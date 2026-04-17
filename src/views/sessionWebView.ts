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
        const result = this.dataProvider.getSessions(projectId, offset, limit);
        this.postMessage({ type: "sessions", sessions: result.sessions.map(s => ({ ...s, timeUpdated: formatTime(s.timeUpdated) })), total: result.total, projectId });
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
        await this.doExport(sessionId, messageIds, includeTools, includeReasoning, includeText, includePatches, includeMeta);
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
        if (m.tokens && m.tokens.total) lines.push(`> **Tokens**: ${m.tokens.total} (in: ${m.tokens.input}, out: ${m.tokens.output})`);
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
    const projectsJson = JSON.stringify(projects.map((p) => ({
      id: p.id,
      worktree: p.worktree,
      name: p.name,
      sessionCount: p.sessionCount,
      timeUpdated: formatTime(p.timeUpdated),
    })));
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
      <div id="sessionsList" class="item-list"></div>
      <div class="pagination" id="sessionsPagination"></div>
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
      <div style="margin-top: 8px; display: flex;">
        <button class="btn-primary" onclick="doExport()">Export Selected to MD</button>
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
}

function onProjectChange() {
  const sel = document.getElementById("projectSelect");
  currentProjectId = sel.value;
  currentSessionId = "";
  sessionsPage = 0;
  resetMessages();
  renderMessages();
  refreshContentViewer();
  if (currentProjectId) {
    loadSessions();
  } else {
    sessionsData = { sessions: [], total: 0 };
    renderSessions();
  }
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
  if (renderDebounceTimer) { clearTimeout(renderDebounceTimer); renderDebounceTimer = null; }
}

function loadSessions() {
  vscode.postMessage({
    type: "getSessions",
    projectId: currentProjectId,
    offset: sessionsPage * SESSIONS_PER_PAGE,
    limit: SESSIONS_PER_PAGE,
  });
}

function onSessionClick(sessionId) {
  currentSessionId = sessionId;
  resetMessages();
  refreshContentViewer();
  highlightSession(sessionId);
  fetchMoreMessages();
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

function renderSessions() {
  const list = document.getElementById("sessionsList");
  const badge = document.getElementById("sessionsBadge");
  badge.textContent = sessionsData.total;

  list.innerHTML = sessionsData.sessions.map(s => {
    const summary = truncate(s.title, 100);
    const selected = s.id === currentSessionId ? " selected" : "";
    return '<div class="item-row' + selected + '" data-id="' + s.id + '" onclick="onSessionClick(\\'' + s.id + '\\')">'
      + '<div class="item-main">'
      + '<span class="item-title">' + esc(summary) + '</span>'
      + '<span class="item-meta">' + s.turnCount + ' turns | ' + esc(s.timeUpdated) + '</span>'
      + '</div>'
      + '<div class="item-actions">'
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
  const textSnippet = textPart ? truncate(textPart.text.replace(/\\n/g, " "), 80) : "";
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
    html += '<div class="turn-group">';

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
  if (expandedTurns.has(tIdx)) {
    expandedTurns.delete(tIdx);
  } else {
    expandedTurns.add(tIdx);
  }
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
  if (checked) {
    checkedMsgIds.add(msgId);
  } else {
    checkedMsgIds.delete(msgId);
  }

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

  checkedMessages.forEach((msg, idx) => {
    if (idx > 0) html += '<hr class="msg-divider" />';

    const isUser = msg.role === "user";
    const headerClass = isUser ? "msg-header-user" : "msg-header-assistant";
    let headerText = isUser ? "USER" : ("ASSISTANT" + (msg.agent ? ": " + msg.agent : ""));
    if (!isUser && msg.model) headerText += " model=" + msg.model;
    headerText += " [" + msg.timeFormatted + "]";

    html += '<div class="' + headerClass + '">' + esc(headerText) + '</div>';

    if (showMeta) {
      html += '<div class="content-meta">'
        + 'Role: ' + esc(msg.role)
        + (msg.agent ? ' | Agent: ' + esc(msg.agent) : '')
        + (msg.model ? ' | Model: ' + esc(msg.model) : '')
        + ' | ' + esc(msg.timeFormatted)
        + (msg.tokens && msg.tokens.total ? ' | Tokens: ' + msg.tokens.total : '')
        + '</div>';
    }

    const parts = partsCache[msg.id];
    if (!parts) {
      vscode.postMessage({ type: "getParts", messageId: msg.id });
      html += '<div class="part"><span class="placeholder">Loading parts...</span></div>';
    } else {
      let hasVisiblePart = false;
      parts.forEach(p => {
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
        html += '<div class="part"><span class="placeholder">No visible content (adjust display options).</span></div>';
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
  if (!currentSessionId) {
    return;
  }
  const ids = Array.from(checkedMsgIds);
  const includeTools = document.getElementById("exportTools").checked;
  const includeReasoning = document.getElementById("exportReasoning").checked;
  const includeText = document.getElementById("exportText").checked;
  const includePatches = document.getElementById("exportPatches").checked;
  const includeMeta = document.getElementById("exportMeta").checked;

  vscode.postMessage({
    type: "exportMd",
    sessionId: currentSessionId,
    messageIds: ids,
    includeTools: includeTools,
    includeReasoning: includeReasoning,
    includeText: includeText,
    includePatches: includePatches,
    includeMeta: includeMeta,
  });
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
      if (checkedMsgIds.has(msg.messageId)) {
        refreshContentViewer();
      }
      scheduleRenderMessages();
      break;
    case "sessionDeleted":
      if (msg.sessionId === currentSessionId) {
        currentSessionId = "";
        resetMessages();
        renderMessages();
        refreshContentViewer();
      }
      loadSessions();
      break;
    case "messageDeleted":
      allLoadedMessages = allLoadedMessages.filter(m => m.id !== msg.messageId);
      checkedMsgIds.delete(msg.messageId);
      turns = buildTurns(allLoadedMessages);
      if (visibleTurnCount > turns.length) {
        visibleTurnCount = turns.length;
      }
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
  #sessionsBody, #messagesBody { max-height: 35vh; }
  .content-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .content-panel .section-body { flex: 1; overflow-y: auto; }

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
  .item-actions { opacity: 0; flex-shrink: 0; transition: opacity 0.15s; }
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

  /* Turn grouping */
  .turn-group {
    border-bottom: 1px solid rgba(255,255,255,0.06);
    padding-bottom: 2px;
  }
  .turn-group:last-child { border-bottom: none; }
  .turn-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.35;
    padding: 6px 12px 2px;
    font-weight: 600;
  }
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
