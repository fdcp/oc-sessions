import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { DataProvider, ProjectInfo, SessionInfo, MessageInfo, PartInfo } from "../data/dataProvider";

export class SessionPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;

  constructor(
    private dataProvider: DataProvider,
    private extensionUri: vscode.Uri
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    this.renderMain();
  }

  refresh(): void {
    if (this.view) {
      this.renderMain();
    }
  }

  private renderMain(): void {
    if (!this.view) {
      return;
    }
    try {
      this.dataProvider.init();
    } catch {
      this.view.webview.html = this.wrapHtml("<p>Database not found.</p>");
      return;
    }
    const projects = this.dataProvider.getProjects();
    this.view.webview.html = this.buildMainHtml(projects);
  }

  private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    try {
      await this.dataProvider.init();
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(errMsg);
      return;
    }

    switch (msg.type) {
      case "getSessions": {
        const projectId = msg.projectId as string;
        const offset = msg.offset as number;
        const limit = msg.limit as number;
        const keyword = msg.keyword as string | undefined;
        const fromDate = msg.fromDate as number | undefined;
        const toDate = msg.toDate as number | undefined;
        const sortBy = msg.sortBy as "updated" | "created" | "turns" | undefined;
        const result = this.dataProvider.getSessions(projectId, offset, limit, { keyword, fromDate, toDate, sortBy });
        this.postMessage({
          type: "sessions",
          sessions: result.sessions.map((s) => ({ ...s, timeUpdated: formatTime(s.timeUpdated) })),
          total: result.total,
          projectId,
        });
        break;
      }
      case "getMessages": {
        const sessionId = msg.sessionId as string;
        const offset = msg.offset as number;
        const limit = msg.limit as number;
        const result = this.dataProvider.getMessages(sessionId, offset, limit);
        this.postMessage({ type: "messages", ...result, sessionId });
        break;
      }
      case "getParts": {
        const messageId = msg.messageId as string;
        const parts = this.dataProvider.getPartsForMessage(messageId);
        this.postMessage({ type: "parts", parts, messageId });
        break;
      }
      case "getTodos": {
        const sessionId = msg.sessionId as string;
        const todos = this.dataProvider.getTodosForSession(sessionId);
        this.postMessage({ type: "todos", todos, sessionId });
        break;
      }
      case "getDiffs": {
        const sessionId = msg.sessionId as string;
        const diffs = this.dataProvider.getSessionDiffs(sessionId);
        this.postMessage({ type: "diffs", diffs, sessionId });
        break;
      }
      case "renameSession": {
        const sessionId = msg.sessionId as string;
        const newTitle = msg.newTitle as string;
        this.dataProvider.renameSession(sessionId, newTitle);
        this.postMessage({ type: "sessionRenamed", sessionId, newTitle });
        break;
      }
      case "deleteSession": {
        const sessionId = msg.sessionId as string;
        const confirm = await vscode.window.showWarningMessage(
          `Delete this session and all its messages/parts?`,
          { modal: true },
          "Delete"
        );
        if (confirm === "Delete") {
          this.dataProvider.deleteSession(sessionId);
          vscode.window.showInformationMessage("Session deleted.");
          this.postMessage({ type: "sessionDeleted", sessionId });
        }
        break;
      }
      case "deleteSessionsBatch": {
        const sessionIds = msg.sessionIds as string[];
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${sessionIds.length} session(s) and all their messages/parts?`,
          { modal: true },
          "Delete"
        );
        if (confirm === "Delete") {
          this.dataProvider.deleteSessionsBatch(sessionIds);
          vscode.window.showInformationMessage(`${sessionIds.length} session(s) deleted.`);
          this.postMessage({ type: "sessionsBatchDeleted", sessionIds });
        }
        break;
      }
      case "deleteMessage": {
        const messageId = msg.messageId as string;
        const sessionId = msg.sessionId as string;
        const confirm = await vscode.window.showWarningMessage(
          `Delete this message and all its parts?`,
          { modal: true },
          "Delete"
        );
        if (confirm === "Delete") {
          this.dataProvider.deleteMessage(messageId, sessionId);
          vscode.window.showInformationMessage("Message deleted.");
          this.postMessage({ type: "messageDeleted", messageId, sessionId });
        }
        break;
      }
      case "exportMd": {
        const sessionId = msg.sessionId as string;
        const messageIds = msg.messageIds as string[];
        const includeTools = msg.includeTools as boolean;
        const includeReasoning = msg.includeReasoning as boolean;
        const includeText = msg.includeText as boolean;
        const includePatches = msg.includePatches as boolean;
        const includeMeta = msg.includeMeta as boolean;
        await this.doExportMd(sessionId, messageIds, includeTools, includeReasoning, includeText, includePatches, includeMeta);
        break;
      }
      case "exportJson": {
        const sessionId = msg.sessionId as string;
        const messageIds = msg.messageIds as string[];
        await this.doExportJson(sessionId, messageIds);
        break;
      }
      case "exportHtml": {
        const sessionId = msg.sessionId as string;
        const messageIds = msg.messageIds as string[];
        const includeTools = msg.includeTools as boolean;
        const includeReasoning = msg.includeReasoning as boolean;
        const includeText = msg.includeText as boolean;
        await this.doExportHtml(sessionId, messageIds, includeTools, includeReasoning, includeText);
        break;
      }
      case "copyText": {
        const text = msg.text as string;
        vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage("Copied to clipboard.");
        break;
      }
    }
  }

  private postMessage(msg: Record<string, unknown>): void {
    if (this.view) {
      this.view.webview.postMessage(msg);
    }
  }

  private async doExportMd(
    sessionId: string,
    messageIds: string[],
    includeTools: boolean,
    includeReasoning: boolean,
    includeText: boolean = true,
    includePatches: boolean = false,
    includeMeta: boolean = false
  ): Promise<void> {
    const allMessages = this.dataProvider.getAllMessages(sessionId);
    const selected = messageIds.length > 0 ? allMessages.filter((m) => messageIds.includes(m.id)) : allMessages;
    const sessions = this.dataProvider.getAllSessions();
    const sessionInfo = sessions.find((s) => s.id === sessionId);

    const lines: string[] = [];
    lines.push("# OpenCode Session Export");
    lines.push("");
    if (sessionInfo) {
      lines.push(`## ${sessionInfo.title}`);
      lines.push("");
      lines.push(`- **Session ID**: \`${sessionInfo.id}\``);
      lines.push(`- **Directory**: ${sessionInfo.directory}`);
      lines.push(`- **Created**: ${formatTime(sessionInfo.timeCreated)}`);
      lines.push(`- **Updated**: ${formatTime(sessionInfo.timeUpdated)}`);
      lines.push(`- **Messages exported**: ${selected.length} / ${allMessages.length}`);
      lines.push("");
    }

    for (const m of selected) {
      lines.push(`### [${m.role.toUpperCase()}] ${formatTime(m.timeCreated)}`);
      lines.push("");
      if (includeMeta) {
        lines.push(`> **Role**: ${m.role}`);
        if (m.agent) lines.push(`> **Agent**: ${m.agent}`);
        if (m.model) lines.push(`> **Model**: ${m.model}`);
        if (m.tokens && m.tokens.total) {
          lines.push(
            `> **Tokens**: ${m.tokens.total} (in: ${m.tokens.input}, out: ${m.tokens.output}, reasoning: ${m.tokens.reasoning})`
          );
        }
        if (m.cost) lines.push(`> **Cost**: $${m.cost.toFixed(6)}`);
        lines.push("");
      } else if (m.agent) {
        lines.push(`> Agent: ${m.agent} | Model: ${m.model}`);
        lines.push("");
      }

      const parts = this.dataProvider.getPartsForMessage(m.id);
      for (const p of parts) {
        if (p.type === "text" && includeText && p.text) {
          lines.push(p.text);
          lines.push("");
        } else if (p.type === "reasoning" && includeReasoning && p.text) {
          lines.push("<details><summary>Reasoning</summary>");
          lines.push("");
          lines.push(p.text);
          lines.push("");
          lines.push("</details>");
          lines.push("");
        } else if (p.type === "tool" && includeTools) {
          lines.push(`**Tool: ${p.toolName}** (${p.toolStatus})`);
          lines.push("");
          if (p.toolInput) {
            lines.push("<details><summary>Input</summary>");
            lines.push("");
            lines.push("```json");
            lines.push(truncate(p.toolInput, 3000));
            lines.push("```");
            lines.push("");
            lines.push("</details>");
            lines.push("");
          }
          if (p.toolOutput) {
            lines.push("<details><summary>Output</summary>");
            lines.push("");
            lines.push("```");
            lines.push(truncate(p.toolOutput, 5000));
            lines.push("```");
            lines.push("");
            lines.push("</details>");
            lines.push("");
          }
        } else if (p.type === "patch" && includePatches) {
          lines.push(`**Patch**: \`${p.patchHash.substring(0, 8)}\` (${p.patchFiles.length} file(s))`);
          lines.push("");
        }
      }
      lines.push("---");
      lines.push("");
    }

    await this.saveExport(lines.join("\n"), sessionId, "md", "Markdown", "Export Session (MD)");
  }

  private async doExportJson(sessionId: string, messageIds: string[]): Promise<void> {
    const allMessages = this.dataProvider.getAllMessages(sessionId);
    const selected = messageIds.length > 0 ? allMessages.filter((m) => messageIds.includes(m.id)) : allMessages;
    const sessions = this.dataProvider.getAllSessions();
    const sessionInfo = sessions.find((s) => s.id === sessionId);

    const output = {
      session: sessionInfo || { id: sessionId },
      messages: selected.map((m) => ({
        ...m,
        timeFormatted: formatTime(m.timeCreated),
        parts: this.dataProvider.getPartsForMessage(m.id),
      })),
    };

    await this.saveExport(JSON.stringify(output, null, 2), sessionId, "json", "JSON", "Export Session (JSON)");
  }

  private async doExportHtml(
    sessionId: string,
    messageIds: string[],
    includeTools: boolean,
    includeReasoning: boolean,
    includeText: boolean
  ): Promise<void> {
    const allMessages = this.dataProvider.getAllMessages(sessionId);
    const selected = messageIds.length > 0 ? allMessages.filter((m) => messageIds.includes(m.id)) : allMessages;
    const sessions = this.dataProvider.getAllSessions();
    const sessionInfo = sessions.find((s) => s.id === sessionId);

    const esc = (s: string) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const blocks: string[] = [];
    for (const m of selected) {
      const isUser = m.role === "user";
      const headerBg = isUser ? "#c09553" : "#2979ff";
      let header = `<div style="background:${headerBg};color:#fff;padding:6px 12px;border-radius:4px;font-weight:600;font-size:13px;margin-bottom:8px;">`;
      header += isUser ? "USER" : `ASSISTANT${m.agent ? ": " + m.agent : ""}`;
      header += ` [${formatTime(m.timeCreated)}]`;
      if (m.tokens && m.tokens.total) {
        header += ` &nbsp; tokens: ${m.tokens.total} (in:${m.tokens.input} out:${m.tokens.output})`;
      }
      if (m.cost) header += ` &nbsp; $${m.cost.toFixed(6)}`;
      header += "</div>";

      const parts = this.dataProvider.getPartsForMessage(m.id);
      let partsHtml = "";
      for (const p of parts) {
        if (p.type === "text" && includeText && p.text) {
          partsHtml += `<pre style="white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;margin:0 0 8px 0;">${esc(p.text)}</pre>`;
        } else if (p.type === "reasoning" && includeReasoning && p.text) {
          partsHtml += `<details style="margin:8px 0;padding:8px 12px;background:rgba(249,168,37,0.08);border-left:3px solid #f9a825;border-radius:0 4px 4px 0;"><summary style="cursor:pointer;font-weight:600;color:#f9a825;">Reasoning</summary><pre style="white-space:pre-wrap;font-size:12px;margin-top:6px;">${esc(p.text)}</pre></details>`;
        } else if (p.type === "tool" && includeTools) {
          partsHtml += `<div style="background:rgba(124,77,255,0.06);border-left:3px solid #7c4dff;padding:8px 12px;margin:8px 0;border-radius:0 4px 4px 0;"><div style="font-weight:600;color:#7c4dff;font-size:12px;">Tool: ${esc(p.toolName)} (${esc(p.toolStatus)})</div>`;
          if (p.toolInput)
            partsHtml += `<details><summary>Input</summary><pre style="font-size:11px;white-space:pre-wrap;">${esc(truncate(p.toolInput, 3000))}</pre></details>`;
          if (p.toolOutput)
            partsHtml += `<details><summary>Output</summary><pre style="font-size:11px;white-space:pre-wrap;">${esc(truncate(p.toolOutput, 5000))}</pre></details>`;
          partsHtml += "</div>";
        }
      }
      blocks.push(`<div style="margin-bottom:20px;">${header}${partsHtml}</div><hr style="border:0;border-top:1px dashed #ccc;margin:16px 0;">`);
    }

    const title = sessionInfo ? esc(sessionInfo.title) : sessionId;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#1a1a1a;background:#fff;line-height:1.6;}pre{background:#f5f5f5;padding:10px;border-radius:4px;overflow-x:auto;}</style></head><body><h1>${title}</h1><p style="color:#666;font-size:13px;">${selected.length} messages | ${sessionInfo ? formatTime(sessionInfo.timeUpdated) : ""}</p><hr style="margin:16px 0;">${blocks.join("\n")}</body></html>`;

    await this.saveExport(html, sessionId, "html", "HTML", "Export Session (HTML)");
  }

  private async saveExport(content: string, sessionId: string, ext: string, filterName: string, title: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("ocSessions");
    const exportDir = config.get<string>("exportPath", "");
    const defaultName = `session-${sessionId.substring(0, 12)}.${ext}`;
    const defaultUri = exportDir
      ? vscode.Uri.file(path.join(exportDir, defaultName))
      : vscode.Uri.file(path.join(os.homedir(), defaultName));

    const filters: Record<string, string[]> = {};
    filters[filterName] = [ext];
    const uri = await vscode.window.showSaveDialog({ defaultUri, filters, title });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
      vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
      if (ext === "md" || ext === "html") {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      }
    }
  }

  private buildMainHtml(projects: ProjectInfo[]): string {
    const projectsJson = JSON.stringify(
      projects.map((p) => ({
        id: p.id,
        worktree: p.worktree,
        name: p.name,
        sessionCount: p.sessionCount,
        timeUpdated: formatTime(p.timeUpdated),
      }))
    );
    const config = vscode.workspace.getConfiguration("ocSessions");
    const sessionsPerPage = config.get<number>("sessionsPerPage", 10);

    return this.wrapHtml(`
<div id="app">

  <!-- Directory Selector -->
  <div class="panel-section dir-section">
    <label class="section-label">Directory</label>
    <select id="projectSelect" onchange="onProjectChange()">
      <option value="">-- Select a directory --</option>
    </select>
  </div>

  <!-- Sessions Panel -->
  <div class="panel-section">
    <div class="section-header" onclick="togglePanel('sessions')">
      <span class="codicon arrow" id="sessionsArrow">&#9660;</span>
      <span>Sessions</span>
      <span class="badge" id="sessionsBadge">0</span>
    </div>
    <div class="section-body" id="sessionsBody">
      <!-- Search + Filter + Sort -->
      <div class="search-bar">
        <input type="text" id="sessionSearch" placeholder="Search title..." oninput="onSearchInput()" />
        <div class="filter-row">
          <input type="date" id="filterFrom" title="From date" onchange="onFilterChange()" />
          <input type="date" id="filterTo" title="To date" onchange="onFilterChange()" />
          <select id="sortBy" onchange="onFilterChange()" title="Sort by">
            <option value="updated">Updated</option>
            <option value="created">Created</option>
            <option value="turns">Turns</option>
          </select>
        </div>
      </div>
      <!-- Bulk actions -->
      <div class="toolbar-row" id="sessionToolbar">
        <label style="font-size:11px;opacity:0.6;cursor:pointer;">
          <input type="checkbox" id="checkAllSessions" onchange="onCheckAllSessions(this.checked)" style="margin-right:4px;" />All
        </label>
        <button class="btn-sm btn-danger" id="deleteSelectedBtn" onclick="deleteSelectedSessions()" style="display:none;">Delete Selected (<span id="deleteSelectedCount">0</span>)</button>
      </div>
      <div id="sessionsList" class="item-list"></div>
      <div class="pagination" id="sessionsPagination"></div>
    </div>
  </div>

  <!-- Todos Panel -->
  <div class="panel-section">
    <div class="section-header" onclick="togglePanel('todos')">
      <span class="codicon arrow" id="todosArrow">&#9660;</span>
      <span>Todos</span>
      <span class="badge" id="todosBadge">0</span>
    </div>
    <div class="section-body collapsed" id="todosBody">
      <div id="todosList" class="item-list">
        <span class="placeholder" style="padding:12px;display:block;">Select a session to view todos.</span>
      </div>
    </div>
  </div>

  <!-- Diffs Panel -->
  <div class="panel-section">
    <div class="section-header" onclick="togglePanel('diffs')">
      <span class="codicon arrow" id="diffsArrow">&#9660;</span>
      <span>File Changes</span>
      <span class="badge" id="diffsBadge">0</span>
    </div>
    <div class="section-body collapsed" id="diffsBody">
      <div id="diffsList" class="item-list">
        <span class="placeholder" style="padding:12px;display:block;">Select a session to view file changes.</span>
      </div>
    </div>
  </div>

  <!-- Messages Panel -->
  <div class="panel-section">
    <div class="section-header" onclick="togglePanel('messages')">
      <span class="codicon arrow" id="messagesArrow">&#9660;</span>
      <span>Messages</span>
      <span class="badge" id="messagesBadge">0</span>
    </div>
    <div class="section-body" id="messagesBody">
      <!-- Part type filter chips -->
      <div class="chip-row" id="partFilterChips">
        <span class="chip active" data-type="all" onclick="setPartFilter('all')">All</span>
        <span class="chip" data-type="text" onclick="setPartFilter('text')">Text</span>
        <span class="chip" data-type="reasoning" onclick="setPartFilter('reasoning')">Reasoning</span>
        <span class="chip" data-type="tool" onclick="setPartFilter('tool')">Tools</span>
        <span class="chip" data-type="patch" onclick="setPartFilter('patch')">Patches</span>
        <span class="chip chip-count" id="partFilterCount" style="margin-left:auto;cursor:default;background:none;opacity:0.4;"></span>
      </div>
      <div class="toolbar-row">
        <button class="btn-sm" onclick="selectAllMessages()">Select All</button>
        <button class="btn-sm" onclick="selectNoMessages()">Select None</button>
        <span class="loading-indicator" id="msgLoadingIndicator" style="display:none;">Loading...</span>
      </div>
      <div id="messagesList" class="item-list"></div>
      <div class="pagination" id="messagesPagination"></div>
    </div>
  </div>

  <!-- Content Viewer Panel -->
  <div class="panel-section content-panel">
    <div class="section-header" onclick="togglePanel('content')">
      <span class="codicon arrow" id="contentArrow">&#9660;</span>
      <span>Content</span>
    </div>
    <div class="section-body" id="contentBody">
      <div id="contentViewer" class="content-viewer">
        <span class="placeholder">Select messages to view content.</span>
      </div>
    </div>
  </div>

  <!-- Bottom Controls -->
  <div class="bottom-controls">
    <div class="control-row">
      <label class="section-label">Display Options</label>
      <div class="checkbox-row" onchange="refreshContentViewer()">
        <label><input type="checkbox" id="showText" checked /> Text</label>
        <label><input type="checkbox" id="showReasoning" checked /> Reasoning</label>
        <label><input type="checkbox" id="showTools" checked /> Tools</label>
        <label><input type="checkbox" id="showPatch" checked /> Patches</label>
        <label><input type="checkbox" id="showCompaction" /> Compaction</label>
        <label><input type="checkbox" id="showMeta" checked /> Metadata</label>
        <label><input type="checkbox" id="showStepInfo" /> Step Info</label>
        <label><input type="checkbox" id="showTokenCost" checked /> Token/Cost</label>
      </div>
    </div>
    <div class="control-row">
      <label class="section-label">Export Options</label>
      <div class="checkbox-row">
        <label><input type="checkbox" id="exportText" checked /> Text</label>
        <label><input type="checkbox" id="exportReasoning" checked /> Reasoning</label>
        <label><input type="checkbox" id="exportTools" /> Tool calls</label>
        <label><input type="checkbox" id="exportPatches" /> Patches</label>
        <label><input type="checkbox" id="exportMeta" /> Metadata</label>
      </div>
      <div style="margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap;">
        <button class="btn-primary" onclick="doExport('md')">Export MD</button>
        <button class="btn-sm" onclick="doExport('json')">Export JSON</button>
        <button class="btn-sm" onclick="doExport('html')">Export HTML</button>
      </div>
    </div>
  </div>

</div>

<script>
const vscode = acquireVsCodeApi();
const projects = ${projectsJson};
const SESSIONS_PER_PAGE = ${sessionsPerPage};
const BATCH_SIZE = 30;
const INITIAL_TURNS_SHOW = 5;

let currentProjectId = "";
let currentSessionId = "";
let sessionsData = { sessions: [], total: 0 };
let sessionsPage = 0;
let searchKeyword = "";
let filterFrom = "";
let filterTo = "";
let sortBy = "updated";
let searchDebounceTimer = null;
let checkedSessionIds = new Set();

let allLoadedMessages = [];
let turns = [];
let visibleTurnCount = 0;
let totalMessagesInSession = 0;
let messageOffset = 0;
let allMessagesFetched = false;
let isFetchingMessages = false;

let checkedMsgIds = new Set();
let partsCache = {};

let expandedTurns = new Set();
let partsRequested = new Set();
let pendingShowCount = 0;
let turnsBeforeFetch = 0;
let renderDebounceTimer = null;

let partTypeFilter = "all";
let focusedTurnIdx = -1;

function init() {
  const sel = document.getElementById("projectSelect");
  projects.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.worktree + " (" + p.sessionCount + " sessions)";
    sel.appendChild(opt);
  });
  if (projects.length > 0) {
    sel.value = projects[0].id;
    onProjectChange();
  }
  document.addEventListener("keydown", onKeyDown);
}

function onKeyDown(e) {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "j") { moveFocusTurn(1); e.preventDefault(); }
  else if (e.key === "k") { moveFocusTurn(-1); e.preventDefault(); }
  else if (e.key === " ") { toggleFocusedTurnCheck(); e.preventDefault(); }
  else if (e.key === "e") { toggleFocusedTurnFold(); e.preventDefault(); }
}

function moveFocusTurn(delta) {
  const maxIdx = visibleTurnCount - 1;
  if (maxIdx < 0) return;
  if (focusedTurnIdx < 0) { focusedTurnIdx = delta > 0 ? 0 : maxIdx; }
  else { focusedTurnIdx = Math.max(0, Math.min(maxIdx, focusedTurnIdx + delta)); }
  renderMessages();
  const el = document.querySelector(".turn-group.focused");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function toggleFocusedTurnCheck() {
  if (focusedTurnIdx < 0 || focusedTurnIdx >= turns.length) return;
  const turn = turns[focusedTurnIdx];
  if (turn.user) {
    const isChecked = checkedMsgIds.has(turn.user.id);
    toggleMsgCheck(turn.user.id, !isChecked, true);
  }
}

function toggleFocusedTurnFold() {
  if (focusedTurnIdx < 0) return;
  toggleTurnFold(focusedTurnIdx);
}

function onProjectChange() {
  const sel = document.getElementById("projectSelect");
  currentProjectId = sel.value;
  currentSessionId = "";
  sessionsPage = 0;
  checkedSessionIds.clear();
  updateDeleteSelectedBtn();
  resetMessages();
  renderMessages();
  refreshContentViewer();
  clearTodos();
  clearDiffs();
  if (currentProjectId) {
    loadSessions();
  } else {
    sessionsData = { sessions: [], total: 0 };
    renderSessions();
  }
}

function onSearchInput() {
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchKeyword = document.getElementById("sessionSearch").value;
    sessionsPage = 0;
    loadSessions();
  }, 300);
}

function onFilterChange() {
  filterFrom = document.getElementById("filterFrom").value;
  filterTo = document.getElementById("filterTo").value;
  sortBy = document.getElementById("sortBy").value;
  sessionsPage = 0;
  loadSessions();
}

function loadSessions() {
  const msg = {
    type: "getSessions",
    projectId: currentProjectId,
    offset: sessionsPage * SESSIONS_PER_PAGE,
    limit: SESSIONS_PER_PAGE,
    keyword: searchKeyword || undefined,
    sortBy: sortBy,
  };
  if (filterFrom) msg.fromDate = Math.floor(new Date(filterFrom).getTime() / 1000);
  if (filterTo) msg.toDate = Math.floor(new Date(filterTo + "T23:59:59").getTime() / 1000);
  vscode.postMessage(msg);
}

function resetMessages() {
  allLoadedMessages = [];
  turns = [];
  visibleTurnCount = 0;
  totalMessagesInSession = 0;
  messageOffset = 0;
  allMessagesFetched = false;
  isFetchingMessages = false;
  checkedMsgIds.clear();
  partsCache = {};
  expandedTurns.clear();
  partsRequested.clear();
  pendingShowCount = 0;
  turnsBeforeFetch = 0;
  focusedTurnIdx = -1;
  if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); renderDebounceTimer = null; }
}

function onSessionClick(sessionId) {
  currentSessionId = sessionId;
  resetMessages();
  refreshContentViewer();
  highlightSession(sessionId);
  fetchMoreMessages();
  loadTodos(sessionId);
  loadDiffs(sessionId);
}

function loadTodos(sessionId) {
  vscode.postMessage({ type: "getTodos", sessionId });
}

function loadDiffs(sessionId) {
  vscode.postMessage({ type: "getDiffs", sessionId });
}

function clearTodos() {
  document.getElementById("todosBadge").textContent = "0";
  document.getElementById("todosList").innerHTML = '<span class="placeholder" style="padding:12px;display:block;">Select a session to view todos.</span>';
}

function clearDiffs() {
  document.getElementById("diffsBadge").textContent = "0";
  document.getElementById("diffsList").innerHTML = '<span class="placeholder" style="padding:12px;display:block;">Select a session to view file changes.</span>';
}

function renderTodos(todos) {
  document.getElementById("todosBadge").textContent = todos.length;
  if (todos.length === 0) {
    document.getElementById("todosList").innerHTML = '<span class="placeholder" style="padding:12px;display:block;">No todos for this session.</span>';
    return;
  }
  const statusIcon = { completed: "&#10003;", in_progress: "&#9654;", pending: "&#9675;", cancelled: "&#215;" };
  const statusColor = { completed: "#4caf50", in_progress: "#2979ff", pending: "#888", cancelled: "#e53935" };
  const priorityColor = { high: "#e53935", medium: "#f9a825", low: "#78909c" };
  document.getElementById("todosList").innerHTML = todos.map(t => {
    const icon = statusIcon[t.status] || "&#9675;";
    const sc = statusColor[t.status] || "#888";
    const pc = priorityColor[t.priority] || "#888";
    return '<div class="todo-row">'
      + '<span class="todo-icon" style="color:' + sc + ';">' + icon + '</span>'
      + '<span class="todo-content">' + esc(t.content || t.title) + '</span>'
      + '<span class="todo-priority" style="color:' + pc + ';">' + esc(t.priority) + '</span>'
      + '</div>';
  }).join("");
}

function renderDiffs(diffs) {
  document.getElementById("diffsBadge").textContent = diffs.length;
  if (diffs.length === 0) {
    document.getElementById("diffsList").innerHTML = '<span class="placeholder" style="padding:12px;display:block;">No file changes recorded for this session.</span>';
    return;
  }
  document.getElementById("diffsList").innerHTML = diffs.map(d => {
    const changed = d.before !== d.after;
    const statusColor = changed ? "#f9a825" : "#4caf50";
    const statusLabel = changed ? "modified" : "unchanged";
    return '<div class="diff-row">'
      + '<span class="diff-status" style="color:' + statusColor + ';">' + statusLabel + '</span>'
      + '<span class="diff-file">' + esc(d.file) + '</span>'
      + '</div>';
  }).join("");
}

function fetchMoreMessages() {
  if (isFetchingMessages || allMessagesFetched) return;
  isFetchingMessages = true;
  showLoadingIndicator(true);
  vscode.postMessage({
    type: "getMessages",
    sessionId: currentSessionId,
    offset: messageOffset,
    limit: BATCH_SIZE,
  });
}

function showLoadingIndicator(show) {
  const el = document.getElementById("msgLoadingIndicator");
  if (el) el.style.display = show ? "inline" : "none";
}

function highlightSession(sid) {
  document.querySelectorAll("#sessionsList .item-row").forEach(el => {
    el.classList.toggle("selected", el.dataset.id === sid);
  });
}

function buildTurns(messages) {
  const result = [];
  let currentTurn = null;
  messages.forEach(m => {
    if (m.role === "user") {
      currentTurn = { user: m, assistants: [] };
      result.push(currentTurn);
    } else {
      if (!currentTurn) {
        currentTurn = { user: null, assistants: [] };
        result.push(currentTurn);
      }
      currentTurn.assistants.push(m);
    }
  });
  return result;
}

function setPartFilter(type) {
  partTypeFilter = type;
  document.querySelectorAll(".chip").forEach(c => {
    c.classList.toggle("active", c.dataset.type === type);
  });
  const countEl = document.getElementById("partFilterCount");
  if (countEl) {
    if (type !== "all") {
      const total = Object.values(partsCache).reduce((sum, parts) => sum + parts.filter(p => p.type === type).length, 0);
      countEl.textContent = total + " parts";
    } else {
      countEl.textContent = "";
    }
  }
  refreshContentViewer();
}

function onCheckAllSessions(checked) {
  if (checked) {
    sessionsData.sessions.forEach(s => checkedSessionIds.add(s.id));
  } else {
    checkedSessionIds.clear();
  }
  renderSessions();
  updateDeleteSelectedBtn();
}

function updateDeleteSelectedBtn() {
  const btn = document.getElementById("deleteSelectedBtn");
  const cnt = document.getElementById("deleteSelectedCount");
  if (btn) btn.style.display = checkedSessionIds.size > 0 ? "inline-block" : "none";
  if (cnt) cnt.textContent = checkedSessionIds.size;
}

function onSessionCheck(sid, checked) {
  if (checked) checkedSessionIds.add(sid);
  else checkedSessionIds.delete(sid);
  updateDeleteSelectedBtn();
  const allChk = document.getElementById("checkAllSessions");
  if (allChk) allChk.checked = sessionsData.sessions.length > 0 && sessionsData.sessions.every(s => checkedSessionIds.has(s.id));
}

function deleteSelectedSessions() {
  const ids = Array.from(checkedSessionIds);
  if (ids.length === 0) return;
  vscode.postMessage({ type: "deleteSessionsBatch", sessionIds: ids });
}

function startRenameSession(sid, currentTitle) {
  const el = document.querySelector('#sessionsList .item-row[data-id="' + sid + '"] .item-title');
  if (!el) return;
  el.innerHTML = '<input type="text" class="rename-input" value="' + esc(currentTitle) + '" />';
  const input = el.querySelector("input");
  input.focus();
  input.select();
  input.addEventListener("keydown", function(e) {
    if (e.key === "Enter") {
      const val = input.value.trim();
      if (val) vscode.postMessage({ type: "renameSession", sessionId: sid, newTitle: val });
      else el.textContent = currentTitle;
    } else if (e.key === "Escape") {
      el.textContent = currentTitle;
    }
  });
  input.addEventListener("blur", function() {
    const val = input.value.trim();
    if (val && val !== currentTitle) vscode.postMessage({ type: "renameSession", sessionId: sid, newTitle: val });
    else el.textContent = currentTitle;
  });
  input.addEventListener("click", e => e.stopPropagation());
}

function copyUserText(sid) {
  const turnIdx = parseInt(sid, 10);
  if (isNaN(turnIdx) || turnIdx >= turns.length) return;
  const turn = turns[turnIdx];
  if (!turn || !turn.user) return;
  const parts = partsCache[turn.user.id];
  if (!parts) return;
  const textPart = parts.find(p => p.type === "text" && p.text);
  if (textPart) vscode.postMessage({ type: "copyText", text: textPart.text });
}

function renderSessions() {
  const list = document.getElementById("sessionsList");
  const badge = document.getElementById("sessionsBadge");
  badge.textContent = sessionsData.total;
  const allChk = document.getElementById("checkAllSessions");
  if (allChk) allChk.checked = sessionsData.sessions.length > 0 && sessionsData.sessions.every(s => checkedSessionIds.has(s.id));

  list.innerHTML = sessionsData.sessions.map(s => {
    const summary = truncate(s.title, 100);
    const selected = s.id === currentSessionId ? " selected" : "";
    const checked = checkedSessionIds.has(s.id) ? "checked" : "";
    return '<div class="item-row' + selected + '" data-id="' + s.id + '" onclick="onSessionClick(\\'' + s.id + '\\')">'
      + '<input type="checkbox" ' + checked + ' onclick="event.stopPropagation(); onSessionCheck(\\'' + s.id + '\\', this.checked)" />'
      + '<div class="item-main">'
      + '<span class="item-title">' + esc(summary) + '</span>'
      + '<span class="item-meta">' + s.turnCount + ' turns | ' + esc(s.timeUpdated) + '</span>'
      + '</div>'
      + '<div class="item-actions">'
      + '<button onclick="event.stopPropagation(); startRenameSession(\\'' + s.id + '\\', \\'' + esc(s.title).replace(/'/g, "\\\\'") + '\\')" title="Rename">&#9998;</button>'
      + '<button onclick="event.stopPropagation(); deleteSession(\\'' + s.id + '\\')" title="Delete session">&#128465;</button>'
      + '</div>'
      + '</div>';
  }).join("");

  const pag = document.getElementById("sessionsPagination");
  const totalPages = Math.ceil(sessionsData.total / SESSIONS_PER_PAGE);
  if (totalPages > 1) {
    let html = '<span>Page ' + (sessionsPage + 1) + '/' + totalPages + '</span>';
    if (sessionsPage > 0) html = '<button class="btn-sm" onclick="sessionsPage--;loadSessions()">Prev</button>' + html;
    if (sessionsPage < totalPages - 1) html += '<button class="btn-sm" onclick="sessionsPage++;loadSessions()">Next</button>';
    pag.innerHTML = html;
  } else {
    pag.innerHTML = "";
  }
}

function getTurnSummary(turn) {
  const userMsg = turn.user;
  if (!userMsg) return "";
  const parts = partsCache[userMsg.id];
  if (!parts) return "Loading...";
  const textPart = parts.find(p => p.type === "text" && p.text);
  const textSnippet = textPart ? truncate(textPart.text.replace(/\n/g, " "), 80) : "";
  const allMsgs = turn.user ? [turn.user, ...turn.assistants] : turn.assistants;
  let toolCount = 0, patchCount = 0;
  allMsgs.forEach(m => {
    const mp = partsCache[m.id];
    if (mp) {
      mp.forEach(p => {
        if (p.type === "tool") toolCount++;
        if (p.type === "patch") patchCount++;
      });
    }
  });
  const stats = [];
  if (toolCount > 0) stats.push(toolCount + " tools");
  if (patchCount > 0) stats.push(patchCount + " patches");
  const statStr = stats.length > 0 ? " | " + stats.join(" | ") : "";
  return (textSnippet || "(no text)") + statStr;
}

function requestPartsForVisible() {
  const displayTurns = turns.slice(0, visibleTurnCount);
  displayTurns.forEach(turn => {
    const msgs = turn.user ? [turn.user, ...turn.assistants] : turn.assistants;
    msgs.forEach(m => {
      if (!partsRequested.has(m.id)) {
        partsRequested.add(m.id);
        vscode.postMessage({ type: "getParts", messageId: m.id });
      }
    });
  });
}

function scheduleRenderMessages() {
  if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
  renderDebounceTimer = setTimeout(() => { renderDebounceTimer = null; renderMessages(); }, 50);
}

function renderMessages() {
  const list = document.getElementById("messagesList");
  const badge = document.getElementById("messagesBadge");
  const totalTurns = allMessagesFetched ? turns.length : (turns.length + "+");
  badge.textContent = totalTurns;

  if (visibleTurnCount === 0 || turns.length === 0) {
    list.innerHTML = "";
    document.getElementById("messagesPagination").innerHTML = "";
    return;
  }

  requestPartsForVisible();

  const displayTurns = turns.slice(0, visibleTurnCount);
  let html = "";

  displayTurns.forEach((turn, tIdx) => {
    const isExpanded = expandedTurns.has(tIdx);
    const isFocused = tIdx === focusedTurnIdx;
    html += '<div class="turn-group' + (isFocused ? " focused" : "") + '">';

    if (turn.user) {
      const m = turn.user;
      const checked = checkedMsgIds.has(m.id) ? "checked" : "";
      const icon = isExpanded ? "&#9660;" : "&#9654;";
      const summary = getTurnSummary(turn);
      html += '<div class="item-row turn-user" data-id="' + m.id + '">'
        + '<span class="turn-fold-icon" onclick="event.stopPropagation(); toggleTurnFold(' + tIdx + ')">' + icon + '</span>'
        + '<input type="checkbox" ' + checked + ' onclick="event.stopPropagation(); toggleMsgCheck(\\'' + m.id + '\\', this.checked, true)" />'
        + '<div class="item-main" onclick="toggleMsgCheck(\\'' + m.id + '\\', !checkedMsgIds.has(\\'' + m.id + '\\'), true)">'
        + '<span class="role-user">USER</span>'
        + '<span class="item-meta">' + esc(m.timeFormatted) + '</span>'
        + '</div>'
        + '<div class="item-actions">'
        + '<button onclick="event.stopPropagation(); copyUserText(' + tIdx + ')" title="Copy user text">&#128203;</button>'
        + '<button onclick="event.stopPropagation(); deleteMessage(\\'' + m.id + '\\', \\'' + m.sessionId + '\\')" title="Delete">&#128465;</button>'
        + '</div>'
        + '</div>';
      if (!isExpanded) {
        html += '<div class="turn-summary">' + esc(summary) + '</div>';
      }
    }

    if (isExpanded) {
      turn.assistants.forEach(m => {
        const checked = checkedMsgIds.has(m.id) ? "checked" : "";
        html += '<div class="item-row turn-assistant" data-id="' + m.id + '">'
          + '<input type="checkbox" ' + checked + ' onclick="event.stopPropagation(); toggleMsgCheck(\\'' + m.id + '\\', this.checked, false)" />'
          + '<div class="item-main" onclick="toggleMsgCheck(\\'' + m.id + '\\', !checkedMsgIds.has(\\'' + m.id + '\\'), false)">'
          + '<span class="role-assistant">ASSISTANT</span>'
          + (m.agent ? ' <span class="item-agent">' + esc(m.agent) + '</span>' : '')
          + '<span class="item-meta">' + esc(m.timeFormatted) + '</span>'
          + (m.tokens && m.tokens.total ? ' <span class="item-tokens">tok:' + m.tokens.total + '</span>' : '')
          + (m.cost ? ' <span class="item-tokens">$' + m.cost.toFixed(4) + '</span>' : '')
          + '</div>'
          + '<div class="item-actions">'
          + '<button onclick="event.stopPropagation(); deleteMessage(\\'' + m.id + '\\', \\'' + m.sessionId + '\\')" title="Delete">&#128465;</button>'
          + '</div>'
          + '</div>';
      });
    }

    html += '</div>';
  });

  list.innerHTML = html;

  const pag = document.getElementById("messagesPagination");
  const canLoadMore = !allMessagesFetched || visibleTurnCount < turns.length;
  const totalLabel = allMessagesFetched ? turns.length : "?";
  let pagHtml = '<span>Showing ' + visibleTurnCount + ' / ' + totalLabel + ' turns</span>';
  if (canLoadMore) {
    const savedVal = window._loadNextVal || "1";
    pagHtml += '<select id="loadNextSelect" style="width:60px;padding:2px 4px;font-size:11px;">'
      + ['1','2','3','4','5','all'].map(v => '<option value="' + v + '"' + (v === savedVal ? ' selected' : '') + '>' + v + '</option>').join('')
      + '</select>';
    pagHtml += '<button class="btn-sm" onclick="showMoreTurns()">Load Next Turns</button>';
  }
  pag.innerHTML = pagHtml;
  if (canLoadMore) {
    const sel = document.getElementById("loadNextSelect");
    if (sel) sel.addEventListener("change", () => { window._loadNextVal = sel.value; });
  }
}

function toggleTurnFold(tIdx) {
  if (expandedTurns.has(tIdx)) expandedTurns.delete(tIdx);
  else expandedTurns.add(tIdx);
  renderMessages();
}

function showMoreTurns() {
  const sel = document.getElementById("loadNextSelect");
  const val = sel ? sel.value : "1";
  window._loadNextVal = val;
  const count = val === "all" ? -1 : parseInt(val, 10);

  if (count === -1) {
    if (!allMessagesFetched) {
      pendingShowCount = -1;
      turnsBeforeFetch = turns.length;
      fetchMoreMessages();
    } else {
      visibleTurnCount = turns.length;
      renderMessages();
    }
  } else {
    let remaining = count;
    while (remaining > 0 && visibleTurnCount < turns.length) {
      visibleTurnCount++;
      remaining--;
    }
    if (remaining > 0 && !allMessagesFetched) {
      pendingShowCount = remaining;
      turnsBeforeFetch = turns.length;
      fetchMoreMessages();
    } else {
      renderMessages();
    }
  }
}

function toggleMsgCheck(msgId, checked, isUser) {
  if (checked) checkedMsgIds.add(msgId);
  else checkedMsgIds.delete(msgId);

  if (isUser) {
    const turn = turns.find(t => t.user && t.user.id === msgId);
    if (turn) {
      turn.assistants.forEach(a => {
        if (checked) checkedMsgIds.add(a.id);
        else checkedMsgIds.delete(a.id);
      });
    }
  }

  renderMessages();
  refreshContentViewer();
}

function selectAllMessages() {
  allLoadedMessages.forEach(m => checkedMsgIds.add(m.id));
  renderMessages();
  refreshContentViewer();
}

function selectNoMessages() {
  checkedMsgIds.clear();
  renderMessages();
  refreshContentViewer();
}

function refreshContentViewer() {
  const viewer = document.getElementById("contentViewer");
  if (checkedMsgIds.size === 0) {
    viewer.innerHTML = '<span class="placeholder">Select messages to view content.</span>';
    return;
  }

  const checkedMessages = allLoadedMessages.filter(m => checkedMsgIds.has(m.id));
  let html = "";

  const showText = document.getElementById("showText").checked;
  const showReasoning = document.getElementById("showReasoning").checked;
  const showTools = document.getElementById("showTools").checked;
  const showPatch = document.getElementById("showPatch").checked;
  const showCompaction = document.getElementById("showCompaction").checked;
  const showMeta = document.getElementById("showMeta").checked;
  const showStepInfo = document.getElementById("showStepInfo").checked;
  const showTokenCost = document.getElementById("showTokenCost").checked;

  checkedMessages.forEach((msg, idx) => {
    if (idx > 0) html += '<hr class="msg-divider" />';

    const isUser = msg.role === "user";
    const headerClass = isUser ? "msg-header-user" : "msg-header-assistant";
    let headerText = isUser ? "USER" : ("ASSISTANT" + (msg.agent ? ": " + msg.agent : ""));
    if (!isUser && msg.model) headerText += " model=" + msg.model;
    headerText += " [" + msg.timeFormatted + "]";

    html += '<div class="' + headerClass + '">' + esc(headerText) + '</div>';

    if (showMeta || showTokenCost) {
      let metaHtml = '<div class="content-meta">';
      if (showMeta) {
        metaHtml += 'Role: ' + esc(msg.role)
          + (msg.agent ? ' | Agent: ' + esc(msg.agent) : '')
          + (msg.model ? ' | Model: ' + esc(msg.model) : '')
          + ' | ' + esc(msg.timeFormatted);
      }
      if (showTokenCost && msg.tokens && msg.tokens.total) {
        metaHtml += (showMeta ? '<br/>' : '')
          + '<span class="token-detail">Tokens: <b>' + msg.tokens.total + '</b>'
          + ' | in: ' + msg.tokens.input
          + ' | out: ' + msg.tokens.output
          + (msg.tokens.reasoning ? ' | reasoning: ' + msg.tokens.reasoning : '')
          + (msg.cost ? ' | <b>$' + msg.cost.toFixed(6) + '</b>' : '')
          + '</span>';
      }
      metaHtml += '</div>';
      html += metaHtml;
    }

    const parts = partsCache[msg.id];
    if (!parts) {
      vscode.postMessage({ type: "getParts", messageId: msg.id });
      html += '<div class="part"><span class="placeholder">Loading parts...</span></div>';
    } else {
      const filteredParts = partTypeFilter === "all" ? parts : parts.filter(p => p.type === partTypeFilter);
      let hasVisiblePart = false;
      filteredParts.forEach(p => {
        if (p.type === "text" && showText && p.text) {
          html += '<div class="part part-text"><pre>' + esc(p.text) + '</pre></div>';
          hasVisiblePart = true;
        } else if (p.type === "reasoning" && showReasoning && p.text) {
          html += '<details class="part part-reasoning"><summary>Reasoning</summary><pre>' + esc(p.text) + '</pre></details>';
          hasVisiblePart = true;
        } else if (p.type === "tool" && showTools) {
          html += '<div class="part part-tool">';
          html += '<div class="tool-title">Tool: ' + esc(p.toolName) + ' (' + esc(p.toolStatus) + ')</div>';
          if (p.toolInput) html += '<div class="tool-section"><strong>Input:</strong><pre>' + esc(truncate(p.toolInput, 5000)) + '</pre></div>';
          if (p.toolOutput) html += '<div class="tool-section"><strong>Output:</strong><pre>' + esc(truncate(p.toolOutput, 10000)) + '</pre></div>';
          html += '</div>';
          hasVisiblePart = true;
        } else if (p.type === "patch" && showPatch) {
          html += '<div class="part part-patch">Patch: ' + esc(p.patchHash.substring(0, 8)) + ' (' + (p.patchFiles ? p.patchFiles.length : 0) + ' files)</div>';
          hasVisiblePart = true;
        } else if (p.type === "compaction" && showCompaction && p.text) {
          html += '<details class="part part-compaction"><summary>Compaction</summary><pre>' + esc(p.text) + '</pre></details>';
          hasVisiblePart = true;
        } else if (p.type === "step-finish" && showStepInfo) {
          const tk = p.finishTokens;
          if (tk && tk.total) {
            html += '<div class="part part-meta">Step Finish: ' + esc(p.finishReason) + ' | Tokens: ' + tk.total + ' (in:' + tk.input + ' out:' + tk.output + ')</div>';
            hasVisiblePart = true;
          }
        }
      });
      if (!hasVisiblePart && parts.length > 0) {
        html += '<div class="part"><span class="placeholder">No visible content (adjust display options or filter).</span></div>';
      } else if (parts.length === 0) {
        html += '<div class="part"><span class="placeholder">No content for this message.</span></div>';
      }
    }
  });

  viewer.innerHTML = html;
}

function deleteSession(sid) {
  vscode.postMessage({ type: "deleteSession", sessionId: sid });
}

function deleteMessage(msgId, sid) {
  vscode.postMessage({ type: "deleteMessage", messageId: msgId, sessionId: sid });
}

function doExport(format) {
  if (!currentSessionId) return;
  const ids = Array.from(checkedMsgIds);
  const includeTools = document.getElementById("exportTools").checked;
  const includeReasoning = document.getElementById("exportReasoning").checked;
  const includeText = document.getElementById("exportText").checked;
  const includePatches = document.getElementById("exportPatches").checked;
  const includeMeta = document.getElementById("exportMeta").checked;

  if (format === "md") {
    vscode.postMessage({ type: "exportMd", sessionId: currentSessionId, messageIds: ids, includeTools, includeReasoning, includeText, includePatches, includeMeta });
  } else if (format === "json") {
    vscode.postMessage({ type: "exportJson", sessionId: currentSessionId, messageIds: ids });
  } else if (format === "html") {
    vscode.postMessage({ type: "exportHtml", sessionId: currentSessionId, messageIds: ids, includeTools, includeReasoning, includeText });
  }
}

function togglePanel(name) {
  const body = document.getElementById(name + "Body");
  const arrow = document.getElementById(name + "Arrow");
  body.classList.toggle("collapsed");
  arrow.classList.toggle("collapsed");
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.substring(0, max) + "... (truncated)" : s;
}

window.addEventListener("message", e => {
  const msg = e.data;
  switch (msg.type) {
    case "sessions":
      sessionsData = { sessions: msg.sessions, total: msg.total };
      renderSessions();
      break;
    case "messages": {
      const newMessages = msg.messages.map(m => ({
        ...m,
        timeFormatted: formatTs(m.timeCreated),
      }));
      allLoadedMessages = allLoadedMessages.concat(newMessages);
      totalMessagesInSession = msg.total;

      if (newMessages.length < BATCH_SIZE) allMessagesFetched = true;
      messageOffset += newMessages.length;
      isFetchingMessages = false;
      showLoadingIndicator(false);

      turns = buildTurns(allLoadedMessages);

      if (visibleTurnCount === 0) {
        visibleTurnCount = Math.min(INITIAL_TURNS_SHOW, turns.length);
      } else if (pendingShowCount === -1) {
        if (!allMessagesFetched) { fetchMoreMessages(); return; }
        visibleTurnCount = turns.length;
        pendingShowCount = 0;
      } else if (pendingShowCount > 0) {
        const newTurns = turns.length - turnsBeforeFetch;
        const toAdd = Math.min(pendingShowCount, newTurns);
        visibleTurnCount = Math.min(visibleTurnCount + toAdd, turns.length);
        pendingShowCount -= toAdd;
        if (pendingShowCount > 0 && !allMessagesFetched) {
          turnsBeforeFetch = turns.length;
          fetchMoreMessages();
          return;
        }
        pendingShowCount = 0;
      } else {
        visibleTurnCount = Math.min(visibleTurnCount + 1, turns.length);
      }

      renderMessages();
      refreshContentViewer();
      break;
    }
    case "parts":
      partsCache[msg.messageId] = msg.parts;
      if (checkedMsgIds.has(msg.messageId)) refreshContentViewer();
      scheduleRenderMessages();
      break;
    case "todos":
      renderTodos(msg.todos);
      break;
    case "diffs":
      renderDiffs(msg.diffs);
      break;
    case "sessionDeleted":
      checkedSessionIds.delete(msg.sessionId);
      if (msg.sessionId === currentSessionId) {
        currentSessionId = "";
        resetMessages();
        renderMessages();
        refreshContentViewer();
        clearTodos();
        clearDiffs();
      }
      updateDeleteSelectedBtn();
      loadSessions();
      break;
    case "sessionsBatchDeleted":
      msg.sessionIds.forEach(sid => checkedSessionIds.delete(sid));
      if (msg.sessionIds.includes(currentSessionId)) {
        currentSessionId = "";
        resetMessages();
        renderMessages();
        refreshContentViewer();
        clearTodos();
        clearDiffs();
      }
      updateDeleteSelectedBtn();
      loadSessions();
      break;
    case "sessionRenamed":
      const s = sessionsData.sessions.find(x => x.id === msg.sessionId);
      if (s) { s.title = msg.newTitle; renderSessions(); }
      break;
    case "messageDeleted":
      allLoadedMessages = allLoadedMessages.filter(m => m.id !== msg.messageId);
      checkedMsgIds.delete(msg.messageId);
      turns = buildTurns(allLoadedMessages);
      if (visibleTurnCount > turns.length) visibleTurnCount = turns.length;
      renderMessages();
      refreshContentViewer();
      break;
  }
});

function formatTs(ts) {
  if (!ts) return "";
  const d = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  const pad = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

init();
</script>
`);
  }

  private wrapHtml(body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    overflow-x: hidden;
  }
  #app { display: flex; flex-direction: column; height: 100vh; }

  .panel-section { border-bottom: 1px solid var(--vscode-panel-border); }
  .dir-section { padding: 4px 12px 8px; }
  .section-label {
    display: block;
    padding: 6px 0 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.6;
    font-weight: 600;
  }
  select {
    width: 100%;
    padding: 6px 10px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    border-radius: 4px;
    outline: none;
    font-size: 13px;
  }
  select:focus { border-color: var(--vscode-focusBorder); }

  .section-header {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: var(--vscode-sideBarSectionHeader-background);
    color: var(--vscode-sideBarSectionHeader-foreground);
    gap: 6px;
  }
  .section-header:hover { opacity: 0.85; }
  .arrow { font-size: 0.65em; transition: transform 0.15s; }
  .arrow.collapsed { transform: rotate(-90deg); }
  .badge {
    margin-left: auto;
    font-size: 10px;
    padding: 1px 7px;
    min-width: 20px;
    text-align: center;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
    font-weight: 600;
  }

  .section-body { overflow-y: auto; }
  .section-body.collapsed { display: none; }
  #sessionsBody, #messagesBody { max-height: 30vh; }
  #todosBody, #diffsBody { max-height: 20vh; }
  .content-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .content-panel .section-body { flex: 1; overflow-y: auto; }

  /* Search bar */
  .search-bar {
    padding: 6px 12px 4px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .search-bar input[type="text"] {
    width: 100%;
    padding: 5px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
    border-radius: 4px;
    outline: none;
    font-size: 12px;
    margin-bottom: 4px;
  }
  .search-bar input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
  .filter-row {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .filter-row input[type="date"] {
    flex: 1;
    padding: 3px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
    border-radius: 4px;
    outline: none;
    font-size: 11px;
    width: auto;
  }
  .filter-row select {
    width: auto;
    padding: 3px 6px;
    font-size: 11px;
    flex-shrink: 0;
  }

  /* Chip filter */
  .chip-row {
    display: flex;
    gap: 4px;
    padding: 5px 12px;
    flex-wrap: wrap;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .chip {
    padding: 2px 10px;
    font-size: 11px;
    border-radius: 12px;
    cursor: pointer;
    background: rgba(255,255,255,0.06);
    color: var(--vscode-foreground);
    opacity: 0.6;
    user-select: none;
    transition: all 0.15s;
  }
  .chip:hover { opacity: 0.9; }
  .chip.active { background: #2979ff; color: #fff; opacity: 1; }

  .item-list {}
  .item-row {
    display: flex;
    align-items: center;
    padding: 7px 12px;
    gap: 8px;
    cursor: pointer;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 13px;
    transition: background 0.1s;
  }
  .item-row:hover { background: var(--vscode-list-hoverBackground); }
  .item-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .item-main { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .item-title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .item-meta { font-size: 11px; opacity: 0.5; white-space: nowrap; }
  .item-agent { font-size: 11px; opacity: 0.65; font-style: italic; }
  .item-tokens { font-size: 10px; opacity: 0.5; }
  .item-actions { opacity: 0; flex-shrink: 0; transition: opacity 0.15s; display: flex; gap: 2px; }
  .item-row:hover .item-actions { opacity: 1; }
  .item-actions button {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 4px;
    font-size: 13px;
    opacity: 0.4;
  }
  .item-actions button:hover { opacity: 1; color: var(--vscode-errorForeground); }

  .rename-input {
    width: 100%;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 13px;
    outline: none;
  }

  /* Turn grouping */
  .turn-group {
    border-bottom: 1px solid rgba(255,255,255,0.06);
    padding-bottom: 2px;
  }
  .turn-group:last-child { border-bottom: none; }
  .turn-group.focused { background: rgba(41,121,255,0.06); }
  .item-row.turn-user { border-left: 3px solid #c09553; }
  .turn-fold-icon {
    font-size: 9px;
    opacity: 0.55;
    cursor: pointer;
    padding: 0 4px 0 0;
    flex-shrink: 0;
    user-select: none;
  }
  .turn-fold-icon:hover { opacity: 1; }
  .turn-summary {
    font-size: 11px;
    opacity: 0.55;
    padding: 2px 12px 5px 44px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-style: italic;
  }
  .item-row.turn-assistant {
    padding-left: 28px;
    border-left: 3px solid transparent;
  }

  /* Role badges */
  .role-user {
    font-weight: 700;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 8px;
    border-radius: 3px;
    background: #c09553;
    color: #fff;
  }
  .role-assistant {
    font-weight: 700;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 8px;
    border-radius: 3px;
    background: #2979ff;
    color: #fff;
  }

  .loading-indicator { font-size: 11px; opacity: 0.6; font-style: italic; margin-left: 4px; }

  .toolbar-row {
    display: flex;
    gap: 6px;
    padding: 6px 12px;
    align-items: center;
    flex-wrap: wrap;
  }

  .btn-sm {
    padding: 3px 10px;
    font-size: 11px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-sm:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-danger {
    background: rgba(229,57,53,0.15);
    color: #e53935;
    border: 1px solid rgba(229,57,53,0.3);
  }
  .btn-danger:hover { background: rgba(229,57,53,0.3); }
  .btn-primary {
    padding: 5px 16px;
    font-size: 12px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.15s;
  }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 8px 12px;
    font-size: 11px;
    opacity: 0.8;
  }

  /* Todos */
  .todo-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 12px;
  }
  .todo-icon { font-size: 12px; flex-shrink: 0; margin-top: 1px; }
  .todo-content { flex: 1; word-break: break-word; }
  .todo-priority { font-size: 10px; opacity: 0.7; flex-shrink: 0; text-transform: uppercase; }

  /* Diffs */
  .diff-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
    font-size: 12px;
  }
  .diff-status { font-size: 10px; text-transform: uppercase; flex-shrink: 0; }
  .diff-file { flex: 1; font-family: var(--vscode-editor-font-family); word-break: break-all; }

  /* Content viewer */
  .content-viewer {
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.6;
  }
  .content-viewer .placeholder { opacity: 0.4; font-style: italic; display: block; padding: 16px 4px; }

  .msg-divider { border: 0; border-top: 1px dashed rgba(255,255,255,0.08); margin: 16px 0; }

  .msg-header-user {
    background: #c09553;
    color: #fff;
    padding: 6px 12px;
    font-weight: 600;
    font-size: 12px;
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .msg-header-assistant {
    background: #2979ff;
    color: #fff;
    padding: 6px 12px;
    font-weight: 600;
    font-size: 12px;
    border-radius: 4px;
    margin-bottom: 8px;
  }

  .content-meta {
    padding: 5px 10px;
    margin-bottom: 8px;
    background: rgba(255,255,255,0.03);
    border-left: 3px solid rgba(255,255,255,0.1);
    font-size: 11px;
    opacity: 0.7;
    border-radius: 0 4px 4px 0;
  }
  .token-detail { font-size: 11px; color: #f9a825; }
  .part { margin-bottom: 10px; }
  .part pre {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    padding: 10px 12px;
    background: rgba(0,0,0,0.2);
    border-radius: 4px;
    max-height: 400px;
    overflow-y: auto;
    line-height: 1.5;
  }
  .part-text pre { background: transparent; padding: 0; }
  .part-reasoning {
    background: rgba(249,168,37,0.06);
    border-left: 3px solid #f9a825;
    padding: 10px 12px;
    margin: 8px 0;
    border-radius: 0 4px 4px 0;
  }
  .part-reasoning summary { cursor: pointer; font-weight: 600; font-size: 12px; color: #f9a825; padding-bottom: 4px; }
  .part-compaction {
    background: rgba(0,150,136,0.06);
    border-left: 3px solid #009688;
    padding: 10px 12px;
    margin: 8px 0;
    border-radius: 0 4px 4px 0;
  }
  .part-compaction summary { cursor: pointer; font-weight: 600; font-size: 12px; color: #009688; padding-bottom: 4px; }
  .part-tool {
    background: rgba(124,77,255,0.06);
    border-left: 3px solid #7c4dff;
    padding: 10px 12px;
    margin: 8px 0;
    border-radius: 0 4px 4px 0;
  }
  .part-tool .tool-title { font-weight: 600; font-size: 12px; color: #7c4dff; padding-bottom: 4px; }
  .tool-section { margin: 6px 0; }
  .tool-section strong { font-size: 11px; opacity: 0.6; display: block; margin-bottom: 3px; }
  .part-patch {
    font-size: 12px;
    padding: 5px 10px;
    background: rgba(76,175,80,0.08);
    border-left: 3px solid #4caf50;
    border-radius: 0 4px 4px 0;
  }
  .part-meta {
    font-size: 11px;
    opacity: 0.5;
    padding: 3px 0;
    border-top: 1px solid rgba(255,255,255,0.05);
    margin-top: 4px;
  }

  /* Bottom controls */
  .bottom-controls {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 10px 12px;
    flex-shrink: 0;
  }
  .control-row { margin-bottom: 8px; }
  .control-row:last-child { margin-bottom: 0; }
  .checkbox-row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    font-size: 12px;
    padding: 4px 0;
  }
  .checkbox-row label { display: flex; align-items: center; gap: 4px; cursor: pointer; opacity: 0.85; }
  .checkbox-row label:hover { opacity: 1; }
  input[type="checkbox"] { transform: scale(1.1); margin: 0; accent-color: #2979ff; }
  .placeholder { opacity: 0.4; font-style: italic; }
</style>
</head>
<body>
${body}
</body>
</html>`;
  }
}

function formatTime(ts: number): string {
  if (!ts) {
    return "unknown";
  }
  const d = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncate(s: string, maxLen: number): string {
  if (!s) {
    return "";
  }
  return s.length > maxLen ? s.substring(0, maxLen) + "..." : s;
}
