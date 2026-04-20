import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DataProvider, ProjectInfo, SessionInfo, MessageInfo, PartInfo } from "../data/dataProvider";
import { OpenCodeClient, contentHash, ModelOption } from "../opencode/opencodeClient";

const OC_SUMMARY_DIR = "/workspace/oc_session_summary_continue";

export class SessionPanelProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private ocClient: OpenCodeClient | null = null;
  private ocSessionId = "";
  private ocMdPath = "";
  private ocChatLog: Array<{ role: string; text: string }> = [];
  private ocStreamAbortFlag = { abort: false };

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
      this.dataProvider.init();
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
        const keyword = (msg.keyword as string) || "";
        const fromDate = (msg.fromDate as number) || 0;
        const toDate = (msg.toDate as number) || 0;
        const sortBy = (msg.sortBy as string) || "updated";
        const result = this.dataProvider.getSessions(projectId, offset, limit, {
          keyword,
          fromDate: fromDate || undefined,
          toDate: toDate || undefined,
          sortBy: sortBy as "updated" | "created" | "turns",
        });
        this.postMessage({
          type: "sessions",
          sessions: result.sessions.map((s) => ({
            ...s,
            timeUpdated: formatTime(s.timeUpdated),
            timeCreated: formatTime(s.timeCreated),
          })),
          total: result.total,
          projectId,
        });
        break;
      }
      case "getMessages": {
        const sessionId = msg.sessionId as string;
        const offset = msg.offset as number;
        const limit = msg.limit as number;
        const msgFromDate = (msg.fromDate as number) || undefined;
        const msgToDate = (msg.toDate as number) || undefined;
        const result = this.dataProvider.getMessages(sessionId, offset, limit, {
          fromDate: msgFromDate,
          toDate: msgToDate,
        });
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
      case "deleteSession": {
        const sessionId = msg.sessionId as string;
        const confirm = await vscode.window.showWarningMessage(
          "Delete this session and all its messages/parts?",
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
      case "deleteSessions": {
        const sessionIds = msg.sessionIds as string[];
        const confirm = await vscode.window.showWarningMessage(
          `Delete ${sessionIds.length} session(s) and all their data?`,
          { modal: true },
          "Delete"
        );
        if (confirm === "Delete") {
          this.dataProvider.deleteSessions(sessionIds);
          vscode.window.showInformationMessage(`${sessionIds.length} session(s) deleted.`);
          this.postMessage({ type: "sessionsDeleted", sessionIds });
        }
        break;
      }
      case "renameSession": {
        const sessionId = msg.sessionId as string;
        const newTitle = msg.newTitle as string;
        this.dataProvider.renameSession(sessionId, newTitle);
        this.postMessage({ type: "sessionRenamed", sessionId, newTitle });
        break;
      }
      case "deleteMessage": {
        const messageId = msg.messageId as string;
        const sessionId = msg.sessionId as string;
        const confirm = await vscode.window.showWarningMessage(
          "Delete this message and all its parts?",
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
        await this.doExport(sessionId, messageIds, includeTools, includeReasoning, includeText, includePatches, includeMeta);
        break;
      }
      case "copyText": {
        const text = msg.text as string;
        vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage("Copied to clipboard.");
        break;
      }
      case "ocStartServer": {
        await this.handleOcStartServer(msg);
        break;
      }
      case "ocSummarize": {
        await this.handleOcSummarize(msg);
        break;
      }
      case "ocSendMessage": {
        await this.handleOcSendMessage(msg);
        break;
      }
      case "ocEndSession": {
        await this.handleOcEndSession();
        break;
      }
      case "ocStop": {
        this.ocStreamAbortFlag.abort = true;
        if (this.ocClient && this.ocSessionId) {
          try { await this.ocClient.abortSession(this.ocSessionId); } catch { /* ignore */ }
        }
        this.postMessage({ type: "ocStopped" });
        break;
      }
    }
  }

  private async handleOcStartServer(msg: { [key: string]: unknown }): Promise<void> {
    try {
      const sourceSessionId = (msg.sessionId as string) || "unknown";
      const contentMd = (msg.contentMd as string) || "";

      fs.mkdirSync(OC_SUMMARY_DIR, { recursive: true });
      const hash = contentHash(contentMd || sourceSessionId);
      const mdPath = path.join(OC_SUMMARY_DIR, `session_${sourceSessionId}_${hash}.md`);
      fs.writeFileSync(mdPath, contentMd, "utf-8");
      this.ocMdPath = mdPath;
      this.ocChatLog = [];

      const baseUrl = "http://127.0.0.1:4096";
      const serveCommand = "/root/.opencode/bin/opencode serve";
      this.ocClient = new OpenCodeClient({
        baseUrl,
        directory: OC_SUMMARY_DIR,
        serveCommand,
        startupTimeoutMs: 30000,
      });

      if (!await this.ocClient.isHealthy()) {
        await this.ocClient.startServer();
      }

      const mdFileName = path.basename(mdPath);
      this.postMessage({ type: "ocServerStarted", mdPath: mdFileName });

      const models = await this.ocClient.discoverModels();
      this.postMessage({ type: "ocModels", models });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.postMessage({ type: "ocError", error: errMsg });
    }
  }

  private async handleOcSummarize(msg: { [key: string]: unknown }): Promise<void> {
    try {
      if (!this.ocClient) throw new Error("OpenCode server not started.");
      const providerID = (msg.providerID as string) || "";
      const modelID = (msg.modelID as string) || "";
      const model = providerID && modelID ? { providerID, modelID } : undefined;

      if (!this.ocSessionId) {
        this.ocSessionId = await this.ocClient.createSession("OC Sessions Summary");
      }

      const sessionId = this.ocSessionId;
      const chatLog = this.ocChatLog;

      const promptText = chatLog.length === 0
        ? "请用中文总结以下会话内容：\n\n" + fs.readFileSync(this.ocMdPath, "utf-8")
        : "请用中文总结当前会话内容。";

      chatLog.push({ role: "user", text: promptText });
      this.ocStreamAbortFlag = { abort: false };
      await this.ocClient.promptStream(
        { sessionId, prompt: promptText, model, tools: {} },
        this.ocStreamAbortFlag,
        (delta) => this.postMessage({ type: "ocSummarizeDelta", delta }),
        (output) => {
          chatLog.push({ role: "assistant", text: output });
          this.postMessage({ type: "ocSummarizeResult", output });
        },
        (err) => this.postMessage({ type: "ocError", error: err.message })
      );
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.postMessage({ type: "ocError", error: errMsg });
    }
  }

  private async handleOcSendMessage(msg: { [key: string]: unknown }): Promise<void> {
    try {
      if (!this.ocClient || !this.ocSessionId) throw new Error("No active OpenCode session.");
      const text = (msg.text as string) || "";
      const providerID = (msg.providerID as string) || "";
      const modelID = (msg.modelID as string) || "";
      const model = providerID && modelID ? { providerID, modelID } : undefined;

      const sessionId = this.ocSessionId;
      const chatLog = this.ocChatLog;
      chatLog.push({ role: "user", text });

      this.ocStreamAbortFlag = { abort: false };
      await this.ocClient.promptStream(
        { sessionId, prompt: text, model },
        this.ocStreamAbortFlag,
        (delta) => this.postMessage({ type: "ocMessageDelta", delta }),
        (output) => {
          chatLog.push({ role: "assistant", text: output });
          this.postMessage({ type: "ocMessageResult", output, userText: text });
        },
        (err) => this.postMessage({ type: "ocError", error: err.message })
      );
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.postMessage({ type: "ocError", error: errMsg });
    }
  }

  private async handleOcEndSession(): Promise<void> {
    try {
      if (this.ocClient && this.ocSessionId && this.ocMdPath && this.ocChatLog.length > 0) {
        const appendLines: string[] = ["\n\n---\n\n## OpenCode Summary Session\n"];
        for (const entry of this.ocChatLog) {
          appendLines.push(`### [${entry.role.toUpperCase()}]\n\n${entry.text}\n`);
        }
        const saveContent = appendLines.join("\n");
        await this.ocClient.prompt({
          sessionId: this.ocSessionId,
          prompt: `Please write the following content to the end of the file ${this.ocMdPath}:\n\n${saveContent}`,
          agent: "build",
        });
      }
    } catch {
      // fallback: direct write if build agent fails
      try {
        if (this.ocMdPath && this.ocChatLog.length > 0) {
          const appendLines: string[] = ["\n\n---\n\n## OpenCode Summary Session\n"];
          for (const entry of this.ocChatLog) {
            appendLines.push(`### [${entry.role.toUpperCase()}]\n\n${entry.text}\n`);
          }
          fs.appendFileSync(this.ocMdPath, appendLines.join("\n"), "utf-8");
        }
      } catch { /* ignore */ }
    } finally {
      if (this.ocSessionId && this.ocClient) {
        try { await this.ocClient.abortSession(this.ocSessionId); } catch { /* ignore */ }
      }
      this.ocSessionId = "";
      this.ocClient = null;
      this.ocMdPath = "";
      this.ocChatLog = [];
      this.postMessage({ type: "ocSessionEnded" });
    }
  }

  private postMessage(msg: Record<string, unknown>): void {
    if (this.view) {
      this.view.webview.postMessage(msg);
    }
  }

  private async doExport(
    sessionId: string,
    messageIds: string[],
    includeTools: boolean,
    includeReasoning: boolean,
    includeText: boolean = true,
    includePatches: boolean = false,
    includeMeta: boolean = false
  ): Promise<void> {
    const allMessages = this.dataProvider.getAllMessages(sessionId);
    const selected = messageIds.length > 0
      ? allMessages.filter((m) => messageIds.includes(m.id))
      : allMessages;

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
          lines.push(`> **Tokens**: ${m.tokens.total} (in: ${m.tokens.input}, out: ${m.tokens.output}, reasoning: ${m.tokens.reasoning})`);
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
            lines.push("\`\`\`json");
            lines.push(truncate(p.toolInput, 3000));
            lines.push("\`\`\`");
            lines.push("");
            lines.push("</details>");
            lines.push("");
          }
          if (p.toolOutput) {
            lines.push("<details><summary>Output</summary>");
            lines.push("");
            lines.push("\`\`\`");
            lines.push(truncate(p.toolOutput, 5000));
            lines.push("\`\`\`");
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

    const md = lines.join("\n");
    const config = vscode.workspace.getConfiguration("ocSessions");
    const exportDir = config.get<string>("exportPath", "");
    const defaultName = `session-${sessionId.substring(0, 12)}.md`;
    const defaultUri = exportDir
      ? vscode.Uri.file(path.join(exportDir, defaultName))
      : vscode.Uri.file(path.join(os.homedir(), defaultName));

    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { Markdown: ["md"] },
      title: "Export Session",
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(md, "utf-8"));
      vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
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
      <div id="sessionsList" class="item-list"></div>
      <div class="pagination" id="sessionsPagination"></div>
    </div>
  </div>

  <!-- Todos Panel -->
  <div class="panel-section">
    <div class="section-header" onclick="togglePanel('todos')">
      <span class="codicon arrow collapsed" id="todosArrow">&#9660;</span>
      <span>Todos</span>
      <span class="badge" id="todosBadge">0</span>
    </div>
    <div class="section-body collapsed" id="todosBody">
      <div id="todosList" class="item-list"></div>
    </div>
  </div>

  <!-- File Changes Panel -->
  <div class="panel-section">
    <div class="section-header" onclick="togglePanel('diffs')">
      <span class="codicon arrow collapsed" id="diffsArrow">&#9660;</span>
      <span>File Changes</span>
      <span class="badge" id="diffsBadge">0</span>
    </div>
    <div class="section-body collapsed" id="diffsBody">
      <div id="diffsList" class="item-list"></div>
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
      <div class="toolbar-row">
        <button class="btn-sm" onclick="selectAllMessages()">Select All</button>
        <button class="btn-sm" onclick="selectNoMessages()">Select None</button>
        <span class="loading-indicator" id="msgLoadingIndicator" style="display:none;">Loading...</span>
      </div>
      <div class="filter-row msg-filter-row">
        <input type="date" id="msgFilterFrom" title="From date" onchange="onMsgFilterChange()" />
        <span style="font-size:11px;opacity:0.5;">–</span>
        <input type="date" id="msgFilterTo" title="To date" onchange="onMsgFilterChange()" />
        <button class="btn-sm" id="msgFilterClear" onclick="clearMsgFilter()" title="Clear filter" style="display:none;">&#10005;</button>
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

  <!-- Bottom Controls (tabbed) -->
  <div class="bottom-controls">
    <div id="tabDisplay" class="tab-content">
      <div class="control-row">
        <div class="checkbox-row" onchange="refreshContentViewer()">
          <label><input type="checkbox" id="showText" checked /> Text</label>
          <label><input type="checkbox" id="showReasoning" checked /> Reasoning</label>
          <label><input type="checkbox" id="showTools" checked /> Tools</label>
          <label><input type="checkbox" id="showPatch" checked /> Patches</label>
          <label><input type="checkbox" id="showCompaction" /> Compaction</label>
          <label><input type="checkbox" id="showMeta" checked /> Metadata</label>
          <label><input type="checkbox" id="showStepInfo" /> Step Info</label>
        </div>
      </div>
    </div>
    <div id="tabExport" class="tab-content" style="display:none;">
      <div class="control-row">
        <div class="checkbox-row">
          <label><input type="checkbox" id="exportText" checked /> Text</label>
          <label><input type="checkbox" id="exportReasoning" checked /> Reasoning</label>
          <label><input type="checkbox" id="exportTools" /> Tool calls</label>
          <label><input type="checkbox" id="exportPatches" /> Patches</label>
          <label><input type="checkbox" id="exportMeta" /> Metadata</label>
        </div>
        <div style="margin-top: 8px;">
          <button class="btn-primary" onclick="doExport()">Export Selected to MD</button>
        </div>
      </div>
    </div>
    <div id="tabOpencode" style="display:none;">
      <!-- Session Header (fixed top) -->
      <div class="oc-session-header" id="ocSessionHeader">
        <span id="ocSessionTitle">Session: --</span>
      </div>
      <!-- Main flexible area: Summary(0.3) + Chat(0.5) + Input(0.2) -->
      <div class="oc-main-area" id="ocMainArea">
        <div class="oc-summary-section" id="ocSummarySection">
          <div class="oc-summary-title">Summary</div>
          <div class="oc-summary-content" id="ocSummaryArea">
            <span class="oc-placeholder">Summary will appear here after Summarize.</span>
          </div>
        </div>
        <div class="oc-chat-section" id="ocChatSection">
          <div class="oc-chat-content" id="ocChatArea">
            <span class="oc-placeholder">Chat messages will appear here.</span>
          </div>
        </div>
        <div class="oc-input-row" id="ocInputRow">
          <textarea id="ocInputBox" class="oc-input-box" placeholder="Type a message..." disabled></textarea>
          <button class="oc-send-btn" id="ocSendBtn" onclick="ocSendMessage()" disabled>Send</button>
        </div>
      </div>
      <!-- Model Row (fixed height) -->
      <div class="oc-model-row">
        <select id="ocModelSelect" class="oc-select" disabled><option value="">Model</option></select>
        <select id="ocQualitySelect" class="oc-select" disabled><option value="">Quality</option></select>
      </div>
      <!-- Controls Row (fixed height, 4 buttons) -->
      <div class="oc-controls-row">
        <button class="oc-btn oc-btn-run" id="ocRunBtn" onclick="ocStartServer()">RUN OpenCode</button>
        <button class="oc-btn oc-btn-summarize" id="ocSummarizeBtn" onclick="ocSummarize()" disabled>Summarize</button>
        <button class="oc-btn oc-btn-stop" id="ocStopBtn" onclick="ocStop()" disabled>Stop</button>
        <button class="oc-btn oc-btn-end" id="ocEndBtn" onclick="ocEndSession()" disabled>End</button>
      </div>
    </div>
    <div class="bottom-tab-bar">
      <button class="bottom-tab active" id="tabBtnDisplay" onclick="switchBottomTab('display')">DISPLAY</button>
      <button class="bottom-tab" id="tabBtnExport" onclick="switchBottomTab('export')">EXPORT</button>
      <button class="bottom-tab" id="tabBtnOpencode" onclick="switchBottomTab('opencode')">OPENCODE</button>
    </div>
  </div>

</div>

<script>
var vscode = acquireVsCodeApi();
var projects = ${projectsJson};
var SESSIONS_PER_PAGE = ${sessionsPerPage};
var BATCH_SIZE = 30;
var INITIAL_TURNS_SHOW = 5;

var currentProjectId = "";
var currentSessionId = "";
var sessionsData = { sessions: [], total: 0 };
var sessionsPage = 0;
var searchKeyword = "";
var filterFrom = "";
var filterTo = "";
var sortBy = "updated";
var searchDebounceTimer = null;
var allLoadedMessages = [];
var turns = [];
var visibleTurnCount = 0;
var totalMessagesInSession = 0;
var messageOffset = 0;
var allMessagesFetched = false;
var isFetchingMessages = false;
var msgFilterFrom = "";
var msgFilterTo = "";

var checkedMsgIds = new Set();
var partsCache = {};

var expandedTurns = new Set();
var partsRequested = new Set();
var pendingShowCount = 0;
var turnsBeforeFetch = 0;
var renderDebounceTimer = null;

var focusedTurnIdx = -1;

function init() {
  var sel = document.getElementById("projectSelect");
  projects.filter(function(p) { return p.sessionCount > 0; }).forEach(function(p) {
    var opt = document.createElement("option");
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
  var tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "j") { moveFocusTurn(1); e.preventDefault(); }
  else if (e.key === "k") { moveFocusTurn(-1); e.preventDefault(); }
  else if (e.key === " ") { toggleFocusedTurnCheck(); e.preventDefault(); }
  else if (e.key === "e") { toggleFocusedTurnFold(); e.preventDefault(); }
}

function moveFocusTurn(delta) {
  var maxIdx = visibleTurnCount - 1;
  if (maxIdx < 0) return;
  if (focusedTurnIdx < 0) { focusedTurnIdx = delta > 0 ? 0 : maxIdx; }
  else { focusedTurnIdx = Math.max(0, Math.min(maxIdx, focusedTurnIdx + delta)); }
  renderMessages();
  var el = document.querySelector(".turn-group.focused");
  if (el) el.scrollIntoView({ block: "nearest" });
}

function toggleFocusedTurnCheck() {
  if (focusedTurnIdx < 0 || focusedTurnIdx >= turns.length) return;
  var turn = turns[focusedTurnIdx];
  if (turn.user) {
    var isChecked = checkedMsgIds.has(turn.user.id);
    toggleMsgCheck(turn.user.id, !isChecked, true);
  }
}

function toggleFocusedTurnFold() {
  if (focusedTurnIdx < 0) return;
  toggleTurnFold(focusedTurnIdx);
}

function onProjectChange() {
  var sel = document.getElementById("projectSelect");
  currentProjectId = sel.value;
  currentSessionId = "";
  sessionsPage = 0;
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
  searchDebounceTimer = setTimeout(function() {
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

function onMsgFilterChange() {
  msgFilterFrom = document.getElementById("msgFilterFrom").value;
  msgFilterTo = document.getElementById("msgFilterTo").value;
  var clearBtn = document.getElementById("msgFilterClear");
  if (clearBtn) clearBtn.style.display = (msgFilterFrom || msgFilterTo) ? "inline" : "none";
  if (!currentSessionId) return;
  resetMessages();
  renderMessages();
  refreshContentViewer();
  fetchMoreMessages();
}

function clearMsgFilter() {
  document.getElementById("msgFilterFrom").value = "";
  document.getElementById("msgFilterTo").value = "";
  var clearBtn = document.getElementById("msgFilterClear");
  if (clearBtn) clearBtn.style.display = "none";
  msgFilterFrom = "";
  msgFilterTo = "";
  if (!currentSessionId) return;
  resetMessages();
  renderMessages();
  refreshContentViewer();
  fetchMoreMessages();
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

function loadSessions() {
  var fromTs = filterFrom ? new Date(filterFrom).getTime() : 0;
  var toTs = filterTo ? (new Date(filterTo).getTime() + 86400000) : 0;
  vscode.postMessage({
    type: "getSessions",
    projectId: currentProjectId,
    offset: sessionsPage * SESSIONS_PER_PAGE,
    limit: SESSIONS_PER_PAGE,
    keyword: searchKeyword,
    fromDate: fromTs,
    toDate: toTs,
    sortBy: sortBy,
  });
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

function fetchMoreMessages() {
  if (isFetchingMessages || allMessagesFetched) return;
  isFetchingMessages = true;
  showLoadingIndicator(true);
  var fromTs = msgFilterFrom ? new Date(msgFilterFrom).getTime() : 0;
  var toTs = msgFilterTo ? (new Date(msgFilterTo).getTime() + 86400000) : 0;
  vscode.postMessage({
    type: "getMessages",
    sessionId: currentSessionId,
    offset: messageOffset,
    limit: BATCH_SIZE,
    fromDate: fromTs || undefined,
    toDate: toTs || undefined,
  });
}

function showLoadingIndicator(show) {
  var el = document.getElementById("msgLoadingIndicator");
  if (el) el.style.display = show ? "inline" : "none";
}

function highlightSession(sid) {
  document.querySelectorAll("#sessionsList .item-row").forEach(function(el) {
    el.classList.toggle("selected", el.dataset.id === sid);
  });
}

function buildTurns(messages) {
  var result = [];
  var currentTurn = null;
  messages.forEach(function(m) {
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

function renderSessions() {
  var list = document.getElementById("sessionsList");
  var badge = document.getElementById("sessionsBadge");
  badge.textContent = sessionsData.total;

  list.innerHTML = sessionsData.sessions.map(function(s) {
    var summary = truncate(s.title, 100);
    var selected = s.id === currentSessionId ? " selected" : "";
    return '<div class="item-row' + selected + '" data-id="' + s.id + '">'
      + '<div class="item-main" onclick="onSessionClick(\\'' + s.id + '\\')">'
      + '<span class="item-title">' + esc(summary) + '</span>'
      + '<span class="item-meta">' + s.turnCount + ' turns | ' + esc(s.timeUpdated) + '</span>'
      + '</div>'
      + '<div class="item-actions">'
      + '<button onclick="event.stopPropagation(); startRenameSession(\\'' + s.id + '\\', this)" title="Rename">&#9998;</button>'
      + '<button onclick="event.stopPropagation(); deleteSession(\\'' + s.id + '\\')" title="Delete session">&#128465;</button>'
      + '</div>'
      + '</div>';
  }).join("");

  var pag = document.getElementById("sessionsPagination");
  var totalPages = Math.ceil(sessionsData.total / SESSIONS_PER_PAGE);
  if (totalPages > 1) {
    var html = '<span>Page ' + (sessionsPage + 1) + '/' + totalPages + '</span>';
    if (sessionsPage > 0) html = '<button class="btn-sm" onclick="sessionsPage--;loadSessions()">Prev</button>' + html;
    if (sessionsPage < totalPages - 1) html += '<button class="btn-sm" onclick="sessionsPage++;loadSessions()">Next</button>';
    pag.innerHTML = html;
  } else {
    pag.innerHTML = "";
  }
}

function startRenameSession(sid, btn) {
  var row = btn.closest(".item-row");
  var titleEl = row.querySelector(".item-title");
  var oldTitle = sessionsData.sessions.find(function(s) { return s.id === sid; });
  if (!oldTitle) return;
  var input = document.createElement("input");
  input.type = "text";
  input.value = oldTitle.title;
  input.className = "rename-input";
  input.onblur = function() { finishRename(sid, input.value, titleEl, input); };
  input.onkeydown = function(e) {
    if (e.key === "Enter") { input.blur(); }
    if (e.key === "Escape") { input.value = oldTitle.title; input.blur(); }
  };
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function finishRename(sid, newTitle, origEl, input) {
  if (newTitle && newTitle.trim()) {
    vscode.postMessage({ type: "renameSession", sessionId: sid, newTitle: newTitle.trim() });
  }
  var span = document.createElement("span");
  span.className = "item-title";
  span.textContent = newTitle && newTitle.trim() ? newTitle.trim() : (origEl ? origEl.textContent : "");
  input.replaceWith(span);
}

// --- Todos ---
function loadTodos(sessionId) {
  vscode.postMessage({ type: "getTodos", sessionId: sessionId });
}

function clearTodos() {
  document.getElementById("todosList").innerHTML = '<span class="placeholder">Select a session to view todos.</span>';
  document.getElementById("todosBadge").textContent = "0";
}

function renderTodos(todos) {
  var list = document.getElementById("todosList");
  var badge = document.getElementById("todosBadge");
  badge.textContent = todos.length;
  if (todos.length === 0) {
    list.innerHTML = '<span class="placeholder">No todos for this session.</span>';
    return;
  }
  list.innerHTML = todos.map(function(t) {
    var icon = t.status === "completed" ? "&#9745;" : t.status === "in_progress" ? "&#9881;" : "&#9744;";
    return '<div class="todo-item">'
      + '<span class="todo-icon">' + icon + '</span>'
      + '<span class="todo-content">' + esc(t.content || t.title) + '</span>'
      + '<span class="todo-priority priority-' + esc(t.priority) + '">' + esc(t.priority) + '</span>'
      + '</div>';
  }).join("");
}

// --- Diffs ---
function loadDiffs(sessionId) {
  vscode.postMessage({ type: "getDiffs", sessionId: sessionId });
}

function clearDiffs() {
  document.getElementById("diffsList").innerHTML = '<span class="placeholder">Select a session to view file changes.</span>';
  document.getElementById("diffsBadge").textContent = "0";
}

function renderDiffs(diffs) {
  var list = document.getElementById("diffsList");
  var badge = document.getElementById("diffsBadge");
  badge.textContent = diffs.length;
  if (diffs.length === 0) {
    list.innerHTML = '<span class="placeholder">No diffs recorded for this session.</span>';
    return;
  }
  list.innerHTML = diffs.map(function(d) {
    var statusLabel = d.before && d.after ? "Modified" : d.before ? "Deleted" : "Added";
    return '<div class="diff-item">'
      + '<span class="diff-status diff-' + statusLabel.toLowerCase() + '">' + statusLabel + '</span>'
      + '<span class="diff-file">' + esc(d.file) + '</span>'
      + '</div>';
  }).join("");
}

function getTurnSummary(turn) {
  var userMsg = turn.user;
  if (!userMsg) return "";
  var parts = partsCache[userMsg.id];
  if (!parts) return "Loading...";
  var textPart = parts.find(function(p) { return p.type === "text" && p.text; });
  var textSnippet = textPart ? truncate(textPart.text.replace(/\\n/g, " "), 80) : "";
  var allMsgs = turn.user ? [turn.user].concat(turn.assistants) : turn.assistants;
  var toolCount = 0, patchCount = 0;
  allMsgs.forEach(function(m) {
    var mp = partsCache[m.id];
    if (mp) {
      mp.forEach(function(p) {
        if (p.type === "tool") toolCount++;
        if (p.type === "patch") patchCount++;
      });
    }
  });
  var stats = [];
  if (toolCount > 0) stats.push(toolCount + " tools");
  if (patchCount > 0) stats.push(patchCount + " patches");
  var statStr = stats.length > 0 ? " | " + stats.join(" | ") : "";
  return (textSnippet || "(no text)") + statStr;
}

function requestPartsForVisible() {
  var displayTurns = turns.slice(0, visibleTurnCount);
  displayTurns.forEach(function(turn) {
    var msgs = turn.user ? [turn.user].concat(turn.assistants) : turn.assistants;
    msgs.forEach(function(m) {
      if (!partsRequested.has(m.id)) {
        partsRequested.add(m.id);
        vscode.postMessage({ type: "getParts", messageId: m.id });
      }
    });
  });
}

function scheduleRenderMessages() {
  if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
  renderDebounceTimer = setTimeout(function() { renderDebounceTimer = null; renderMessages(); }, 50);
}

function renderMessages() {
  var list = document.getElementById("messagesList");
  var badge = document.getElementById("messagesBadge");
  var totalTurns = allMessagesFetched ? turns.length : (turns.length + "+");
  badge.textContent = totalTurns;

  if (visibleTurnCount === 0 || turns.length === 0) {
    list.innerHTML = "";
    document.getElementById("messagesPagination").innerHTML = "";
    return;
  }

  requestPartsForVisible();

  var displayTurns = turns.slice(0, visibleTurnCount);
  var html = "";

  displayTurns.forEach(function(turn, tIdx) {
    var isExpanded = expandedTurns.has(tIdx);
    var focusedClass = tIdx === focusedTurnIdx ? " focused" : "";
    html += '<div class="turn-group' + focusedClass + '">';

    if (turn.user) {
      var m = turn.user;
      var checked = checkedMsgIds.has(m.id) ? " checked" : "";
      var icon = isExpanded ? "&#9660;" : "&#9654;";
      var summary = getTurnSummary(turn);
      // Token/cost display
      var tokenInfo = "";
      if (m.tokens && m.tokens.total) {
        tokenInfo = '<span class="item-tokens">&#128176; ' + m.tokens.total + ' tok';
        tokenInfo += ' (in:' + m.tokens.input + ' out:' + m.tokens.output;
        if (m.tokens.reasoning) tokenInfo += ' reason:' + m.tokens.reasoning;
        tokenInfo += ')';
        if (m.cost) tokenInfo += ' $' + m.cost.toFixed(4);
        tokenInfo += '</span>';
      }
      html += '<div class="item-row turn-user" data-id="' + m.id + '">'
        + '<span class="turn-fold-icon" onclick="event.stopPropagation(); toggleTurnFold(' + tIdx + ')">' + icon + '</span>'
        + '<input type="checkbox"' + checked + ' onclick="event.stopPropagation(); toggleMsgCheck(\\'' + m.id + '\\', this.checked, true)" />'
        + '<div class="item-main" onclick="toggleMsgCheck(\\'' + m.id + '\\', !checkedMsgIds.has(\\'' + m.id + '\\'), true)">'
        + '<span class="role-user">USER</span>'
        + '<span class="item-meta">' + esc(m.timeFormatted) + '</span>'
        + tokenInfo
        + '</div>'
        + '<div class="item-actions">'
        + '<button onclick="event.stopPropagation(); copyUserText(\\'' + m.id + '\\')" title="Copy user text">&#128203;</button>'
        + '<button onclick="event.stopPropagation(); deleteMessage(\\'' + m.id + '\\', \\'' + m.sessionId + '\\')" title="Delete">&#128465;</button>'
        + '</div>'
        + '</div>';
      if (!isExpanded) {
        html += '<div class="turn-summary">' + esc(summary) + '</div>';
      }
    }

    if (isExpanded) {
      turn.assistants.forEach(function(m) {
        var checked = checkedMsgIds.has(m.id) ? " checked" : "";
        var tokenInfo = "";
        if (m.tokens && m.tokens.total) {
          tokenInfo = '<span class="item-tokens">&#128176; ' + m.tokens.total + ' tok';
          tokenInfo += ' (in:' + m.tokens.input + ' out:' + m.tokens.output;
          if (m.tokens.reasoning) tokenInfo += ' reason:' + m.tokens.reasoning;
          tokenInfo += ')';
          if (m.cost) tokenInfo += ' $' + m.cost.toFixed(4);
          tokenInfo += '</span>';
        }
        html += '<div class="item-row turn-assistant" data-id="' + m.id + '">'
          + '<input type="checkbox"' + checked + ' onclick="event.stopPropagation(); toggleMsgCheck(\\'' + m.id + '\\', this.checked, false)" />'
          + '<div class="item-main" onclick="toggleMsgCheck(\\'' + m.id + '\\', !checkedMsgIds.has(\\'' + m.id + '\\'), false)">'
          + '<span class="role-assistant">ASSISTANT</span>'
          + (m.agent ? ' <span class="item-agent">' + esc(m.agent) + '</span>' : '')
          + '<span class="item-meta">' + esc(m.timeFormatted) + '</span>'
          + tokenInfo
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

  var pag = document.getElementById("messagesPagination");  var canLoadMore = !allMessagesFetched || visibleTurnCount < turns.length;
  var totalLabel = allMessagesFetched ? turns.length : "?";
  var pagHtml = '<span>Showing ' + visibleTurnCount + ' / ' + totalLabel + ' turns</span>';
  if (canLoadMore) {
    var savedVal = window._loadNextVal || "1";
    pagHtml += '<select id="loadNextSelect" style="width:60px;padding:2px 4px;font-size:11px;">'
      + ['1','2','3','4','5','all'].map(function(v) { return '<option value="' + v + '"' + (v === savedVal ? ' selected' : '') + '>' + v + '</option>'; }).join('')
      + '</select>';
    pagHtml += '<button class="btn-sm" onclick="showMoreTurns()">Load Next Turns</button>';
  }
  pag.innerHTML = pagHtml;
  if (canLoadMore) {    var sel = document.getElementById("loadNextSelect");
    if (sel) sel.addEventListener("change", function() { window._loadNextVal = sel.value; });
  }
}

function copyUserText(msgId) {
  var parts = partsCache[msgId];
  if (!parts) return;
  var text = parts.filter(function(p) { return p.type === "text" && p.text; }).map(function(p) { return p.text; }).join("\\n");
  if (text) {
    vscode.postMessage({ type: "copyText", text: text });
  }
}

function toggleTurnFold(tIdx) {
  if (expandedTurns.has(tIdx)) {
    expandedTurns.delete(tIdx);
  } else {
    expandedTurns.add(tIdx);
  }
  renderMessages();
}

function showMoreTurns() {
  var sel = document.getElementById("loadNextSelect");
  var val = sel ? sel.value : "1";
  window._loadNextVal = val;
  var count = val === "all" ? -1 : parseInt(val, 10);

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
    var remaining = count;
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
  if (checked) {
    checkedMsgIds.add(msgId);
  } else {
    checkedMsgIds.delete(msgId);
  }

  if (isUser) {
    var turn = turns.find(function(t) { return t.user && t.user.id === msgId; });
    if (turn) {
      turn.assistants.forEach(function(a) {
        if (checked) checkedMsgIds.add(a.id);
        else checkedMsgIds.delete(a.id);
      });
    }
  }

  renderMessages();
  refreshContentViewer();
}

function selectAllMessages() {
  allLoadedMessages.forEach(function(m) { checkedMsgIds.add(m.id); });
  renderMessages();
  refreshContentViewer();
}

function selectNoMessages() {
  checkedMsgIds.clear();
  renderMessages();
  refreshContentViewer();
}

function refreshContentViewer() {
  var viewer = document.getElementById("contentViewer");
  if (checkedMsgIds.size === 0) {
    viewer.innerHTML = '<span class="placeholder">Select messages to view content.</span>';
    return;
  }

  var checkedMessages = allLoadedMessages.filter(function(m) { return checkedMsgIds.has(m.id); });
  var html = "";

  var showText = document.getElementById("showText").checked;
  var showReasoning = document.getElementById("showReasoning").checked;
  var showTools = document.getElementById("showTools").checked;
  var showPatch = document.getElementById("showPatch").checked;
  var showCompaction = document.getElementById("showCompaction").checked;
  var showMeta = document.getElementById("showMeta").checked;
  var showStepInfo = document.getElementById("showStepInfo").checked;

  checkedMessages.forEach(function(msg, idx) {
    if (idx > 0) html += '<hr class="msg-divider" />';

    var isUser = msg.role === "user";
    var headerClass = isUser ? "msg-header-user" : "msg-header-assistant";
    var headerText = isUser ? "USER" : ("ASSISTANT" + (msg.agent ? ": " + msg.agent : ""));
    if (!isUser && msg.model) headerText += " model=" + msg.model;
    headerText += " [" + msg.timeFormatted + "]";

    html += '<div class="' + headerClass + '">' + esc(headerText) + '</div>';

    if (showMeta) {
      var metaHtml = '<div class="content-meta">';
      metaHtml += 'Role: ' + esc(msg.role);
      if (msg.agent) metaHtml += ' | Agent: ' + esc(msg.agent);
      if (msg.model) metaHtml += ' | Model: ' + esc(msg.model);
      metaHtml += ' | ' + esc(msg.timeFormatted);
      if (msg.tokens && msg.tokens.total) {
        metaHtml += ' | Tokens: <b>' + msg.tokens.total + '</b>'
          + ' | in: ' + msg.tokens.input + ' out: ' + msg.tokens.output;
        if (msg.tokens.reasoning) metaHtml += ' reason: ' + msg.tokens.reasoning;
      }
      if (msg.cost) {
        metaHtml += ' | Cost: <b>$' + msg.cost.toFixed(6) + '</b>';
      }
      metaHtml += '</div>';
      html += metaHtml;
    }

    var parts = partsCache[msg.id];
    if (!parts) {
      vscode.postMessage({ type: "getParts", messageId: msg.id });
      html += '<div class="part"><span class="placeholder">Loading parts...</span></div>';
    } else {
      var hasVisiblePart = false;
        parts.forEach(function(p) {
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
          var tk = p.finishTokens;
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

function doExport() {
  if (!currentSessionId) return;
  var ids = Array.from(checkedMsgIds);
  vscode.postMessage({
    type: "exportMd",
    sessionId: currentSessionId,
    messageIds: ids,
    includeTools: document.getElementById("exportTools").checked,
    includeReasoning: document.getElementById("exportReasoning").checked,
    includeText: document.getElementById("exportText").checked,
    includePatches: document.getElementById("exportPatches").checked,
    includeMeta: document.getElementById("exportMeta").checked,
  });
}

function togglePanel(name) {
  var body = document.getElementById(name + "Body");
  var arrow = document.getElementById(name + "Arrow");
  body.classList.toggle("collapsed");
  arrow.classList.toggle("collapsed");
}

function switchBottomTab(tab) {
  document.getElementById("tabDisplay").style.display = tab === "display" ? "block" : "none";
  document.getElementById("tabExport").style.display = tab === "export" ? "block" : "none";
  document.getElementById("tabOpencode").style.display = tab === "opencode" ? "flex" : "none";
  document.getElementById("tabBtnDisplay").classList.toggle("active", tab === "display");
  document.getElementById("tabBtnExport").classList.toggle("active", tab === "export");
  document.getElementById("tabBtnOpencode").classList.toggle("active", tab === "opencode");
  var isOpencode = tab === "opencode";
  document.getElementById("app").classList.toggle("opencode-mode", isOpencode);
}

function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/\\x3c/g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.substring(0, max) + "... (truncated)" : s;
}

window.addEventListener("message", function(e) {
  var msg = e.data;
  switch (msg.type) {
    case "sessions":
      sessionsData = { sessions: msg.sessions, total: msg.total };
      renderSessions();
      break;
    case "messages": {
      var newMessages = msg.messages.map(function(m) {
        m.timeFormatted = formatTs(m.timeCreated);
        return m;
      });
      allLoadedMessages = allLoadedMessages.concat(newMessages);
      totalMessagesInSession = msg.total;

      if (newMessages.length < BATCH_SIZE) {
        allMessagesFetched = true;
      }
      messageOffset += newMessages.length;
      isFetchingMessages = false;
      showLoadingIndicator(false);

      turns = buildTurns(allLoadedMessages);

      if (visibleTurnCount === 0) {
        visibleTurnCount = Math.min(INITIAL_TURNS_SHOW, turns.length);
      } else if (pendingShowCount === -1) {
        if (!allMessagesFetched) {
          fetchMoreMessages();
          return;
        }
        visibleTurnCount = turns.length;
        pendingShowCount = 0;
      } else if (pendingShowCount > 0) {
        var newTurns = turns.length - turnsBeforeFetch;
        var toAdd = Math.min(pendingShowCount, newTurns);
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
      if (checkedMsgIds.has(msg.messageId)) {
        refreshContentViewer();
      }
      scheduleRenderMessages();
      break;
    case "todos":
      renderTodos(msg.todos);
      break;
    case "diffs":
      renderDiffs(msg.diffs);
      break;
    case "sessionDeleted":
      if (msg.sessionId === currentSessionId) {
        currentSessionId = "";
        resetMessages();
        renderMessages();
        refreshContentViewer();
        clearTodos();
        clearDiffs();
      }
      loadSessions();
      break;
    case "sessionsDeleted":
      if (msg.sessionIds.indexOf(currentSessionId) >= 0) {
        currentSessionId = "";
        resetMessages();
        renderMessages();
        refreshContentViewer();
        clearTodos();
        clearDiffs();
      }
      loadSessions();
      break;
    case "sessionRenamed": {
      var s = sessionsData.sessions.find(function(x) { return x.id === msg.sessionId; });
      if (s) { s.title = msg.newTitle; renderSessions(); }
      break;
    }
    case "messageDeleted":
      allLoadedMessages = allLoadedMessages.filter(function(m) { return m.id !== msg.messageId; });
      checkedMsgIds.delete(msg.messageId);
      turns = buildTurns(allLoadedMessages);
      if (visibleTurnCount > turns.length) visibleTurnCount = turns.length;
      renderMessages();
      refreshContentViewer();
      break;
    case "ocServerStarted":
      ocSetState("running");
      break;
    case "ocModels":
      ocPopulateModels(msg.models);
      ocPopulateQuality(msg.models);
      break;
    case "ocSummarizeDelta":
      ocStreamDelta("summary", msg.delta);
      break;
    case "ocSummarizeResult": {
      var sumArea = document.getElementById("ocSummaryArea");
      ocFlushStream("summary", msg.output);
      sumArea.innerHTML = '<div class="oc-summary-text">' + esc(msg.output) + '</div>';
      var sumBtnEl = document.getElementById("ocSummarizeBtn");
      sumBtnEl.textContent = "Summarized";
      sumBtnEl.disabled = false;
      ocSetState("chatting");
      break;
    }
    case "ocMessageDelta":
      ocStreamDelta("chat", msg.delta);
      break;
    case "ocMessageResult":
      ocFlushStream("chat", msg.output);
      document.getElementById("ocSendBtn").disabled = false;
      document.getElementById("ocSendBtn").textContent = "Send";
      var sumBtnAfterMsg = document.getElementById("ocSummarizeBtn");
      if (sumBtnAfterMsg.textContent === "Summarized") sumBtnAfterMsg.textContent = "Summarize";
      ocSetState("chatting");
      break;
    case "ocStopped":
      ocSetState("chatting");
      document.getElementById("ocStopBtn").textContent = "Stop";
      document.getElementById("ocSummarizeBtn").textContent = "Summarize";
      document.getElementById("ocSummarizeBtn").disabled = false;
      document.getElementById("ocSendBtn").disabled = false;
      document.getElementById("ocSendBtn").textContent = "Send";
      break;
    case "ocError":
      ocAppendChat("assistant", "[Error] " + msg.error);
      document.getElementById("ocSummarizeBtn").textContent = "Summarize";
      document.getElementById("ocSummarizeBtn").disabled = false;
      document.getElementById("ocSendBtn").disabled = false;
      document.getElementById("ocSendBtn").textContent = "Send";
      if (ocState === "starting") ocSetState("initial");
      else ocSetState("chatting");
      break;
    case "ocSessionEnded": {
      var endBtnEl = document.getElementById("ocEndBtn");
      endBtnEl.textContent = "Ended";
      endBtnEl.disabled = true;
      break;
    }
  }
});

function formatTs(ts) {
  if (!ts) return "";
  var d = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
  var pad = function(n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

// --- OPENCODE Tab State & Functions ---
var ocState = "initial"; // initial | starting | running | chatting
var ocModels = [];
var ocSelectedModel = null;

function ocGetContentMd() {
  var ids = Array.from(checkedMsgIds);
  var msgs = ids.length > 0
    ? allLoadedMessages.filter(function(m) { return ids.indexOf(m.id) >= 0; })
    : allLoadedMessages;
  if (msgs.length === 0) return "";
  var lines = ["# Session Content", ""];
  msgs.forEach(function(m) {
    lines.push("## " + (m.role || "unknown").toUpperCase() + " (" + (m.timeFormatted || "") + ")");
    lines.push("");
    var parts = partsCache[m.id];
    if (parts && parts.length > 0) {
      parts.forEach(function(p) {
        if (p.type === "text" && p.text) { lines.push(p.text); lines.push(""); }
        else if (p.type === "reasoning" && p.text) { lines.push("> " + p.text); lines.push(""); }
        else if (p.type === "tool" && p.toolName) { lines.push("**Tool**: " + p.toolName); lines.push(""); }
      });
    }
    lines.push("---");
    lines.push("");
  });
  return lines.join("\\n");
}

 function ocSetState(state) {
  ocState = state;
  var runBtn = document.getElementById("ocRunBtn");
  var modelSel = document.getElementById("ocModelSelect");
  var qualitySel = document.getElementById("ocQualitySelect");
  var sumBtn = document.getElementById("ocSummarizeBtn");
  var stopBtn = document.getElementById("ocStopBtn");
  var endBtn = document.getElementById("ocEndBtn");
  var inputBox = document.getElementById("ocInputBox");
  var sendBtn = document.getElementById("ocSendBtn");

  if (state === "initial") {
    runBtn.textContent = "RUN OpenCode";
    runBtn.className = "oc-btn oc-btn-run";
    runBtn.disabled = false;
    modelSel.disabled = true;
    qualitySel.disabled = true;
    sumBtn.textContent = "Summarize";
    sumBtn.disabled = true;
    stopBtn.textContent = "Stop";
    stopBtn.disabled = true;
    endBtn.textContent = "End";
    endBtn.disabled = true;
    inputBox.disabled = true;
    sendBtn.disabled = true;
  } else if (state === "starting") {
    runBtn.textContent = "Starting...";
    runBtn.className = "oc-btn oc-btn-run";
    runBtn.disabled = true;
    modelSel.disabled = true;
    qualitySel.disabled = true;
    sumBtn.disabled = true;
    stopBtn.disabled = true;
    endBtn.disabled = true;
    inputBox.disabled = true;
    sendBtn.disabled = true;
  } else if (state === "running") {
    runBtn.textContent = "Running";
    runBtn.className = "oc-btn oc-btn-run oc-btn-running";
    runBtn.disabled = true;
    modelSel.disabled = false;
    qualitySel.disabled = false;
    sumBtn.disabled = false;
    stopBtn.disabled = true;
    endBtn.disabled = true;
    inputBox.disabled = true;
    sendBtn.disabled = true;
  } else if (state === "chatting") {
    runBtn.textContent = "Running";
    runBtn.className = "oc-btn oc-btn-run oc-btn-running";
    runBtn.disabled = true;
    modelSel.disabled = false;
    qualitySel.disabled = false;
    sumBtn.disabled = false;
    stopBtn.disabled = true;
    endBtn.disabled = false;
    inputBox.disabled = false;
    sendBtn.disabled = false;
  } else if (state === "streaming") {
    sumBtn.disabled = true;
    stopBtn.disabled = false;
    endBtn.disabled = true;
    inputBox.disabled = true;
    sendBtn.disabled = true;
  }
}

function ocStartServer() {
  if (ocState !== "initial") return;
  ocSetState("starting");
  var contentMd = ocGetContentMd();
  vscode.postMessage({ type: "ocStartServer", sessionId: currentSessionId || "unknown", contentMd: contentMd });
}

function ocStop() {
  var stopBtn = document.getElementById("ocStopBtn");
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping...";
  vscode.postMessage({ type: "ocStop" });
}

function ocSummarize() {
  if (ocState !== "running" && ocState !== "chatting") return;
  var sel = document.getElementById("ocModelSelect");
  var val = sel.value;
  var providerID = "", modelID = "";
  if (val) { var p = val.split("::"); providerID = p[0] || ""; modelID = p[1] || ""; }
  var sumBtn = document.getElementById("ocSummarizeBtn");
  sumBtn.disabled = true;
  sumBtn.textContent = "Summarizing...";
  ocSetState("streaming");
  vscode.postMessage({ type: "ocSummarize", providerID: providerID, modelID: modelID });
}

function ocSendMessage() {
  if (ocState !== "chatting") return;
  var inputBox = document.getElementById("ocInputBox");
  var text = inputBox.value.trim();
  if (!text) return;
  inputBox.value = "";
  var sel = document.getElementById("ocModelSelect");
  var val = sel.value;
  var providerID = "", modelID = "";
  if (val) { var p = val.split("::"); providerID = p[0] || ""; modelID = p[1] || ""; }
  ocAppendChat("user", text);
  var sendBtn = document.getElementById("ocSendBtn");
  sendBtn.disabled = true;
  sendBtn.textContent = "...";
  var sumBtn = document.getElementById("ocSummarizeBtn");
  if (sumBtn.textContent === "Summarized") sumBtn.textContent = "Summarize";
  _ocStreamNode.chat = null;
  ocSetState("streaming");
  vscode.postMessage({ type: "ocSendMessage", text: text, providerID: providerID, modelID: modelID });
}

function ocEndSession() {
  if (ocState !== "chatting") return;
  var endBtn = document.getElementById("ocEndBtn");
  endBtn.disabled = true;
  endBtn.textContent = "Ending...";
  vscode.postMessage({ type: "ocEndSession" });
}

function ocAppendChat(role, text) {
  var area = document.getElementById("ocChatArea");
  if (area.querySelector(".oc-placeholder")) area.innerHTML = "";
  var div = document.createElement("div");
  div.className = "oc-chat-msg";
  var badge = role === "user"
    ? '<span class="oc-badge-you">YOU</span>'
    : '<span class="oc-badge-ai">AI</span>';
  div.innerHTML = badge + '<div class="oc-msg-text">' + esc(text) + '</div>';
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

var _ocStreamNode = { chat: null, summary: null };

function ocStreamDelta(target, delta) {
  if (!delta) return;
  if (target === "chat") {
    var area = document.getElementById("ocChatArea");
    if (area.querySelector(".oc-placeholder")) area.innerHTML = "";
    if (!_ocStreamNode.chat) {
      var div = document.createElement("div");
      div.className = "oc-chat-msg";
      div.innerHTML = '<span class="oc-badge-ai">AI</span><div class="oc-msg-text oc-streaming"></div>';
      area.appendChild(div);
      _ocStreamNode.chat = div.querySelector(".oc-msg-text");
    }
    _ocStreamNode.chat.textContent += delta;
    area.scrollTop = area.scrollHeight;
  } else if (target === "summary") {
    var sumArea = document.getElementById("ocSummaryArea");
    if (!_ocStreamNode.summary) {
      sumArea.innerHTML = '<div class="oc-summary-text oc-streaming"></div>';
      _ocStreamNode.summary = sumArea.querySelector(".oc-summary-text");
    }
    _ocStreamNode.summary.textContent += delta;
    sumArea.scrollTop = sumArea.scrollHeight;
  }
}

function ocFlushStream(target, finalOutput) {
  if (target === "chat") {
    if (_ocStreamNode.chat) {
      _ocStreamNode.chat.classList.remove("oc-streaming");
      _ocStreamNode.chat = null;
    } else {
      ocAppendChat("assistant", finalOutput);
    }
  } else if (target === "summary") {
    _ocStreamNode.summary = null;
  }
}

function ocPopulateModels(models) {
  ocModels = models || [];
  var sel = document.getElementById("ocModelSelect");
  sel.innerHTML = '<option value="">-- Select Model --</option>';
  models.forEach(function(m) {
    var opt = document.createElement("option");
    opt.value = m.providerID + "::" + m.modelID;
    opt.textContent = m.label || (m.providerID + " / " + m.modelID);
    sel.appendChild(opt);
  });
  var freeIdx = models.findIndex(function(m) { return m.modelID && m.modelID.endsWith("-free"); });
  if (freeIdx >= 0) sel.selectedIndex = freeIdx + 1;
  else if (models.length > 0) sel.selectedIndex = 1;
}

function ocPopulateQuality(models) {
  var sel = document.getElementById("ocQualitySelect");
  sel.innerHTML = '<option value="">Auto</option>';
  // quality options populated when model changes (future enhancement)
}

function ocReset() {
  ocSetState("initial");
  _ocStreamNode.chat = null;
  _ocStreamNode.summary = null;
  document.getElementById("ocSummaryArea").innerHTML = '<span class="oc-placeholder">Summary will appear here after Summarize.</span>';
  document.getElementById("ocChatArea").innerHTML = '<span class="oc-placeholder">Chat messages will appear here.</span>';
  document.getElementById("ocInputBox").value = "";
  document.getElementById("ocModelSelect").innerHTML = '<option value="">Model</option>';
  document.getElementById("ocQualitySelect").innerHTML = '<option value="">Quality</option>';
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

  .delete-bar {
    padding: 4px 12px;
    display: flex;
    align-items: center;
  }
  .btn-danger {
    padding: 3px 10px;
    font-size: 11px;
    background: var(--vscode-errorForeground, #f44336);
    color: #fff;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .btn-danger:hover { opacity: 0.85; }

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
    flex: 1;
    padding: 2px 6px;
    font-size: 13px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 3px;
    outline: none;
  }

  /* Turn grouping */
  .turn-group {
    border-bottom: 1px solid rgba(255,255,255,0.06);
    padding-bottom: 2px;
  }
  .turn-group:last-child { border-bottom: none; }
  .turn-group.focused { background: rgba(41,121,255,0.08); }
  .item-row.turn-user {
    border-left: 3px solid #c09553;
  }
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

  .loading-indicator {
    font-size: 11px;
    opacity: 0.6;
    font-style: italic;
    margin-left: 4px;
  }

  .toolbar-row {
    display: flex;
    gap: 6px;
    padding: 6px 12px;
    align-items: center;
    flex-wrap: wrap;
  }
  .msg-filter-row {
    padding: 2px 12px 6px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .msg-filter-row input[type="date"] {
    flex: 1;
    padding: 3px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(255,255,255,0.1));
    border-radius: 4px;
    outline: none;
    font-size: 11px;
  }
  .msg-filter-row input[type="date"]:focus { border-color: var(--vscode-focusBorder); }

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
  .todo-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    font-size: 12px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .todo-icon { font-size: 14px; flex-shrink: 0; }
  .todo-content { flex: 1; min-width: 0; }
  .todo-priority { font-size: 10px; opacity: 0.6; padding: 1px 6px; border-radius: 8px; background: rgba(255,255,255,0.06); }
  .priority-high { background: rgba(244,67,54,0.15); color: #f44336; }
  .priority-medium { background: rgba(255,152,0,0.15); color: #ff9800; }
  .priority-low { background: rgba(76,175,80,0.15); color: #4caf50; }

  /* Diffs */
  .diff-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    font-size: 12px;
    border-bottom: 1px solid rgba(255,255,255,0.04);
  }
  .diff-status { font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 600; }
  .diff-modified { background: rgba(255,152,0,0.15); color: #ff9800; }
  .diff-added { background: rgba(76,175,80,0.15); color: #4caf50; }
  .diff-deleted { background: rgba(244,67,54,0.15); color: #f44336; }
  .diff-file { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .placeholder { opacity: 0.4; font-style: italic; display: block; padding: 10px 12px; font-size: 12px; }

  /* Content viewer */
  .content-viewer {
    padding: 10px 12px;
    font-size: 13px;
    line-height: 1.6;
  }
  .content-viewer .placeholder { padding: 16px 4px; }

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

  .tab-content { padding: 10px 12px; }
  .bottom-tab-bar {
    display: flex;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .bottom-tab {
    flex: 1;
    padding: 6px 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-foreground);
    border: none;
    border-right: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    opacity: 0.55;
    transition: opacity 0.15s;
  }
  .bottom-tab:last-child { border-right: none; }
  .bottom-tab:hover { opacity: 0.85; }
  .bottom-tab.active { opacity: 1; color: #2979ff; border-bottom: 2px solid #2979ff; }

  /* OPENCODE Tab Fixed Layout */
  #app.opencode-mode > .dir-section,
  #app.opencode-mode > .panel-section { display: none !important; }
  #app.opencode-mode > .bottom-controls {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    margin-top: 0 !important;
    border-top: none !important;
    min-height: 0;
  }
  #app.opencode-mode > .bottom-controls > #tabOpencode {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
    padding: 0;
    background: #1e1e1e;
  }
  .oc-session-header { flex-shrink: 0; padding: 6px 12px; background: #252526; border-bottom: 1px solid #333; font-size: 11px; color: #888; font-family: monospace; }
  .oc-main-area { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
  .oc-summary-section { flex: 3; border-bottom: 1px solid #333; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .oc-summary-title { flex-shrink: 0; padding: 4px 12px; background: #252526; font-size: 11px; font-weight: 600; color: #aaa; text-transform: uppercase; }
  .oc-summary-content { flex: 1; overflow-y: auto; padding: 8px 12px; font-size: 12px; line-height: 1.5; }
  .oc-chat-section { flex: 5; display: flex; flex-direction: column; min-height: 0; border-bottom: 1px solid #333; }
  .oc-chat-content { flex: 1; overflow-y: auto; padding: 8px 12px; }
  .oc-input-row { flex: 2; display: flex; gap: 0; padding: 8px 12px; background: #1e1e1e; min-height: 0; }
  .oc-input-box { flex: 1; resize: none; padding: 10px 12px; font-size: 13px; background: #2d2d2d; color: #ccc; border: 2px solid #3d3d3d; border-radius: 6px 0 0 6px; outline: none; font-family: inherit; }
  .oc-input-box:focus { border-color: #2979ff; }
  .oc-input-box:disabled { opacity: 0.5; }
  .oc-send-btn { width: 60px; background: #2979ff; color: #fff; border: none; border-radius: 0 6px 6px 0; cursor: pointer; font-size: 13px; font-weight: 600; }
  .oc-send-btn:disabled { opacity: 0.4; cursor: default; }
  .oc-model-row { flex-shrink: 0; display: flex; gap: 8px; padding: 6px 12px; background: #252526; border-top: 1px solid #333; }
  .oc-controls-row { flex-shrink: 0; display: flex; gap: 8px; padding: 8px 12px; align-items: center; background: #252526; border-top: 1px solid #333; }
  .oc-btn { flex: 1; padding: 6px 14px; border: none; border-radius: 4px; font-size: 12px; font-weight: 500; cursor: pointer; color: #fff; }
  .oc-btn:disabled { opacity: 0.4; cursor: default; }
  .oc-btn-run { background: #3c3c3c; }
  .oc-btn-run.oc-btn-running { background: #2ea44f; }
  .oc-btn-summarize { background: #2979ff; }
  .oc-btn-stop { background: #d32f2f; }
  .oc-btn-end { background: #444; }
  .oc-select { flex: 1; padding: 6px 10px; font-size: 12px; background: #3c3c3c; color: #ccc; border: 1px solid #555; border-radius: 4px; outline: none; }
  .oc-select:disabled { opacity: 0.4; }
  .oc-chat-msg { display: flex; gap: 8px; padding: 8px 0; align-items: flex-start; }
  .oc-badge-you { background: #d4882a; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
  .oc-badge-ai { background: #2979ff; color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; white-space: nowrap; }
  .oc-msg-text { font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; background: #2d2d2d; border: 1px solid #3d3d3d; border-radius: 6px; padding: 10px 12px; flex: 1; }
  .oc-placeholder { color: #666; font-size: 12px; font-style: italic; padding: 12px; }
  .oc-summary-text { white-space: pre-wrap; word-break: break-word; }
  .oc-streaming::after { content: "▋"; animation: oc-blink 0.8s step-end infinite; color: #2979ff; }
  @keyframes oc-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

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
