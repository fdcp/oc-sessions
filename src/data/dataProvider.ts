import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";

export interface ProjectInfo {
  id: string;
  worktree: string;
  name: string;
  timeCreated: number;
  timeUpdated: number;
  sessionCount: number;
}

export interface SessionInfo {
  id: string;
  projectId: string;
  directory: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  messageCount: number;
  turnCount: number;
  summaryAdditions: number;
  summaryDeletions: number;
  summaryFiles: number;
}

export interface MessageInfo {
  id: string;
  sessionId: string;
  timeCreated: number;
  role: string;
  agent: string;
  model: string;
  parentId: string;
  tokens: { total: number; input: number; output: number; reasoning: number };
  cost: number;
  finishReason: string;
}

export interface PartInfo {
  id: string;
  messageId: string;
  sessionId: string;
  timeCreated: number;
  type: string;
  text: string;
  toolName: string;
  toolInput: string;
  toolOutput: string;
  toolStatus: string;
  patchHash: string;
  patchFiles: string[];
  finishReason: string;
  finishTokens: { total: number; input: number; output: number; reasoning: number };
  finishCost: number;
}

export interface SessionDiff {
  file: string;
  before: string;
  after: string;
}

export interface TodoInfo {
  sessionId: string;
  content: string;
  status: string;
  priority: string;
  position: number;
  timeCreated: number;
  timeUpdated: number;
}

export interface GetSessionsOpts {
  keyword?: string;
  fromDate?: number;
  toDate?: number;
  sortBy?: "updated" | "created" | "turns";
}

export class DataProvider {
  private dbPath: string;
  private storagePath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.storagePath = path.join(path.dirname(dbPath), "storage", "session_diff");
  }

  init(): void {
    if (!fs.existsSync(this.dbPath)) {
      throw new Error(`Database not found: ${this.dbPath}`);
    }
  }

  reload(): void {}

  private querySync(sql: string, params: (string | number)[] = []): Record<string, unknown>[] {
    const script = [
      "import sqlite3, json, sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "conn.row_factory = sqlite3.Row",
      "cur = conn.cursor()",
      "cur.execute(sys.argv[2], json.loads(sys.argv[3]))",
      "print(json.dumps([dict(r) for r in cur.fetchall()]))",
      "conn.close()",
    ].join("\n");

    const result = execFileSync("python3", ["-c", script, this.dbPath, sql, JSON.stringify(params)], {
      encoding: "utf-8",
      timeout: 30000,
    });
    return JSON.parse(result.trim());
  }

  private execSync(sql: string, params: (string | number)[] = []): void {
    const script = [
      "import sqlite3, json, sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "cur = conn.cursor()",
      "cur.execute(sys.argv[2], json.loads(sys.argv[3]))",
      "conn.commit()",
      "conn.close()",
    ].join("\n");
    execFileSync("python3", ["-c", script, this.dbPath, sql, JSON.stringify(params)], { timeout: 15000 });
  }

  getProjects(): ProjectInfo[] {
    const rows = this.querySync(
      `SELECT p.id, p.worktree, p.name, p.time_created, p.time_updated,
              (SELECT COUNT(*) FROM session s WHERE s.project_id = p.id) as session_count
       FROM project p ORDER BY p.time_updated DESC`
    );
    const result: ProjectInfo[] = [];
    for (const row of rows) {
      const worktree = row.worktree as string;
      if (worktree === "/") {
        const dirRows = this.querySync(
          `SELECT s.directory,
                  MAX(s.time_updated) as max_updated,
                  MIN(s.time_created) as min_created,
                  COUNT(*) as cnt
           FROM session s
           WHERE s.project_id = ?
             AND (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) > 0
             AND s.directory IS NOT NULL AND s.directory != ''
           GROUP BY s.directory
           ORDER BY max_updated DESC`,
          [row.id as string]
        );
        for (const dr of dirRows) {
          const dir = dr.directory as string;
          result.push({
            id: `${row.id as string}::${dir}`,
            worktree: dir,
            name: path.basename(dir) || dir,
            timeCreated: dr.min_created as number,
            timeUpdated: dr.max_updated as number,
            sessionCount: dr.cnt as number,
          });
        }
      } else {
        result.push({
          id: row.id as string,
          worktree,
          name: (row.name as string) || path.basename(worktree),
          timeCreated: row.time_created as number,
          timeUpdated: row.time_updated as number,
          sessionCount: row.session_count as number,
        });
      }
    }
    return result;
  }

  getSessions(
    projectId: string,
    offset: number,
    limit: number,
    opts: GetSessionsOpts = {}
  ): { sessions: SessionInfo[]; total: number } {
    const sepIdx = projectId.indexOf("::");
    const realProjectId = sepIdx >= 0 ? projectId.slice(0, sepIdx) : projectId;
    const directoryFilter = sepIdx >= 0 ? projectId.slice(sepIdx + 2) : null;

    const conditions: string[] = [
      "s.project_id = ?",
      "(SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) > 0",
    ];
    const params: (string | number)[] = [realProjectId];

    if (directoryFilter) {
      conditions.push("s.directory = ?");
      params.push(directoryFilter);
    }

    if (opts.keyword && opts.keyword.trim()) {
      conditions.push("LOWER(s.title) LIKE ?");
      params.push(`%${opts.keyword.trim().toLowerCase()}%`);
    }
    if (opts.fromDate) {
      conditions.push("s.time_updated >= ?");
      params.push(opts.fromDate);
    }
    if (opts.toDate) {
      conditions.push("s.time_updated <= ?");
      params.push(opts.toDate);
    }

    const where = conditions.join(" AND ");
    let orderBy = "s.time_updated DESC";
    if (opts.sortBy === "created") {
      orderBy = "s.time_created DESC";
    } else if (opts.sortBy === "turns") {
      orderBy = "turn_count DESC";
    }

    const countRows = this.querySync(`SELECT COUNT(*) as cnt FROM session s WHERE ${where}`, params);
    const total = (countRows[0]?.cnt as number) || 0;

    const rows = this.querySync(
      `SELECT s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated,
              s.summary_additions, s.summary_deletions, s.summary_files,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as message_count,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user') as turn_count
       FROM session s WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return {
      total,
      sessions: rows.map((row) => this.mapSession(row)),
    };
  }

  getAllSessions(): SessionInfo[] {
    const rows = this.querySync(
      `SELECT s.id, s.project_id, s.directory, s.title, s.time_created, s.time_updated,
              s.summary_additions, s.summary_deletions, s.summary_files,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as message_count,
              (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id AND json_extract(m.data, '$.role') = 'user') as turn_count
       FROM session s WHERE (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) > 0 ORDER BY s.time_updated DESC`
    );
    return rows.map((row) => this.mapSession(row));
  }

  private mapSession(row: Record<string, unknown>): SessionInfo {
    return {
      id: row.id as string,
      projectId: row.project_id as string,
      directory: row.directory as string,
      title: row.title as string,
      timeCreated: row.time_created as number,
      timeUpdated: row.time_updated as number,
      messageCount: row.message_count as number,
      turnCount: (row.turn_count as number) || 0,
      summaryAdditions: (row.summary_additions as number) || 0,
      summaryDeletions: (row.summary_deletions as number) || 0,
      summaryFiles: (row.summary_files as number) || 0,
    };
  }

  getMessages(
    sessionId: string,
    offset: number,
    limit: number,
    options?: { fromDate?: number; toDate?: number }
  ): { messages: MessageInfo[]; total: number } {
    const fromDate = options?.fromDate;
    const toDate = options?.toDate;

    const timeFilter = [
      fromDate ? "time_created >= ?" : "",
      toDate ? "time_created <= ?" : "",
    ]
      .filter(Boolean)
      .join(" AND ");
    const whereParts = ["session_id = ?", timeFilter].filter(Boolean).join(" AND ");
    const timeParams: number[] = [
      ...(fromDate ? [fromDate] : []),
      ...(toDate ? [toDate] : []),
    ];

    const countRows = this.querySync(
      `SELECT COUNT(*) as cnt FROM message WHERE ${whereParts}`,
      [sessionId, ...timeParams]
    );
    const total = (countRows[0]?.cnt as number) || 0;

    const rows = this.querySync(
      `SELECT id, session_id, time_created, data FROM message
       WHERE ${whereParts} ORDER BY time_created ASC LIMIT ? OFFSET ?`,
      [sessionId, ...timeParams, limit, offset]
    );

    return { total, messages: rows.map((row) => this.parseMessage(row)) };
  }

  getAllMessages(sessionId: string): MessageInfo[] {
    const rows = this.querySync(
      `SELECT id, session_id, time_created, data FROM message
       WHERE session_id = ? ORDER BY time_created ASC`,
      [sessionId]
    );
    return rows.map((row) => this.parseMessage(row));
  }

  getPartsForMessage(messageId: string): PartInfo[] {
    const rows = this.querySync(
      `SELECT id, message_id, session_id, time_created, data FROM part
       WHERE message_id = ? ORDER BY time_created ASC`,
      [messageId]
    );
    return rows.map((row) => this.parsePart(row));
  }

  getPartsForSession(sessionId: string): PartInfo[] {
    const rows = this.querySync(
      `SELECT id, message_id, session_id, time_created, data FROM part
       WHERE session_id = ? ORDER BY time_created ASC`,
      [sessionId]
    );
    return rows.map((row) => this.parsePart(row));
  }

  getTodosForSession(sessionId: string): TodoInfo[] {
    const rows = this.querySync(
      `SELECT session_id, content, status, priority, position, time_created, time_updated
       FROM todo WHERE session_id = ? ORDER BY position ASC`,
      [sessionId]
    );
    return rows.map((row) => ({
      sessionId: row.session_id as string,
      content: row.content as string,
      status: (row.status as string) || "",
      priority: (row.priority as string) || "",
      position: (row.position as number) || 0,
      timeCreated: row.time_created as number,
      timeUpdated: row.time_updated as number,
    }));
  }

  renameSession(sessionId: string, newTitle: string): void {
    this.execSync("UPDATE session SET title = ? WHERE id = ?", [newTitle, sessionId]);
  }

  deleteSessions(sessionIds: string[]): void {
    for (const sid of sessionIds) {
      this.deleteSession(sid);
    }
  }

  private parseMessage(row: Record<string, unknown>): MessageInfo {
    const data = JSON.parse((row.data as string) || "{}");
    const model = data.model as Record<string, string> | undefined;
    const tokens = data.tokens as Record<string, number> | undefined;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      timeCreated: row.time_created as number,
      role: (data.role as string) || "unknown",
      agent: (data.agent as string) || "",
      model: model ? `${model.providerID}/${model.modelID}` : "",
      parentId: (data.parentID as string) || "",
      tokens: tokens
        ? { total: tokens.total || 0, input: tokens.input || 0, output: tokens.output || 0, reasoning: tokens.reasoning || 0 }
        : { total: 0, input: 0, output: 0, reasoning: 0 },
      cost: (data.cost as number) || 0,
      finishReason: (data.finish as string) || "",
    };
  }

  private parsePart(row: Record<string, unknown>): PartInfo {
    const data = JSON.parse((row.data as string) || "{}");
    const partType = (data.type as string) || "unknown";

    let toolName = "";
    let toolInput = "";
    let toolOutput = "";
    let toolStatus = "";
    if (partType === "tool" && data.state) {
      const state = data.state as Record<string, unknown>;
      toolStatus = (state.status as string) || "";
      const input = state.input;
      toolInput = input ? JSON.stringify(input) : "";
      const output = state.output;
      toolOutput = typeof output === "string" ? output : output ? JSON.stringify(output) : "";
    }
    if (partType === "tool") {
      toolName = (data.tool as string) || "";
    }

    let patchFiles: string[] = [];
    let patchHash = "";
    if (partType === "patch") {
      patchHash = (data.hash as string) || "";
      patchFiles = Array.isArray(data.files) ? (data.files as string[]) : [];
    }

    let finishReason = "";
    let finishCost = 0;
    const finishTokens = { total: 0, input: 0, output: 0, reasoning: 0 };
    if (partType === "step-finish") {
      finishReason = (data.reason as string) || "";
      finishCost = (data.cost as number) || 0;
      if (data.tokens) {
        const t = data.tokens as Record<string, number>;
        finishTokens.total = t.total || 0;
        finishTokens.input = t.input || 0;
        finishTokens.output = t.output || 0;
        finishTokens.reasoning = t.reasoning || 0;
      }
    }

    return {
      id: row.id as string,
      messageId: row.message_id as string,
      sessionId: row.session_id as string,
      timeCreated: row.time_created as number,
      type: partType,
      text: (data.text as string) || "",
      toolName,
      toolInput,
      toolOutput,
      toolStatus,
      patchHash,
      patchFiles,
      finishReason,
      finishTokens,
      finishCost,
    };
  }

  getSessionDiffs(sessionId: string): SessionDiff[] {
    const diffFile = path.join(this.storagePath, `${sessionId}.json`);
    if (!fs.existsSync(diffFile)) {
      return [];
    }
    try {
      const content = fs.readFileSync(diffFile, "utf-8");
      const diffs = JSON.parse(content);
      return Array.isArray(diffs) ? (diffs as SessionDiff[]) : [];
    } catch {
      return [];
    }
  }

  deleteSession(sessionId: string): void {
    const script = [
      "import sqlite3, sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "cur = conn.cursor()",
      "cur.execute('DELETE FROM part WHERE session_id = ?', (sys.argv[2],))",
      "cur.execute('DELETE FROM message WHERE session_id = ?', (sys.argv[2],))",
      "cur.execute('DELETE FROM todo WHERE session_id = ?', (sys.argv[2],))",
      "cur.execute('DELETE FROM session WHERE id = ?', (sys.argv[2],))",
      "conn.commit()",
      "conn.close()",
    ].join("\n");

    execFileSync("python3", ["-c", script, this.dbPath, sessionId], { timeout: 15000 });

    const diffFile = path.join(this.storagePath, `${sessionId}.json`);
    if (fs.existsSync(diffFile)) {
      fs.unlinkSync(diffFile);
    }
  }

  deleteMessage(messageId: string, sessionId: string): void {
    const script = [
      "import sqlite3, sys",
      "conn = sqlite3.connect(sys.argv[1])",
      "cur = conn.cursor()",
      "cur.execute('DELETE FROM part WHERE message_id = ? AND session_id = ?', (sys.argv[2], sys.argv[3]))",
      "cur.execute('DELETE FROM message WHERE id = ? AND session_id = ?', (sys.argv[2], sys.argv[3]))",
      "conn.commit()",
      "conn.close()",
    ].join("\n");

    execFileSync("python3", ["-c", script, this.dbPath, messageId, sessionId], { timeout: 10000 });
  }

  getSessionStats(): { totalProjects: number; totalSessions: number; totalMessages: number; totalParts: number } {
    const rows = this.querySync(
      `SELECT
        (SELECT COUNT(*) FROM project) as total_projects,
        (SELECT COUNT(*) FROM session) as total_sessions,
        (SELECT COUNT(*) FROM message) as total_messages,
        (SELECT COUNT(*) FROM part) as total_parts`
    );
    const r = rows[0] || {};
    return {
      totalProjects: (r.total_projects as number) || 0,
      totalSessions: (r.total_sessions as number) || 0,
      totalMessages: (r.total_messages as number) || 0,
      totalParts: (r.total_parts as number) || 0,
    };
  }

  dispose(): void {}
}
