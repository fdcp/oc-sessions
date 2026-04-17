import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { DataProvider } from "./data/dataProvider";
import { SessionPanelProvider } from "./views/sessionWebView";

function getDbPath(): string {
  const config = vscode.workspace.getConfiguration("ocSessions");
  const custom = config.get<string>("dbPath", "");
  if (custom) {
    return custom;
  }
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

export function activate(context: vscode.ExtensionContext) {
  const dbPath = getDbPath();
  const dataProvider = new DataProvider(dbPath);
  const panelProvider = new SessionPanelProvider(dataProvider, context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("ocSessionsPanel", panelProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("ocSessions.refresh", () => {
      panelProvider.refresh();
    }),

    vscode.commands.registerCommand("ocSessions.showStats", async () => {
      try {
        await dataProvider.init();
        const stats = dataProvider.getSessionStats();
        vscode.window.showInformationMessage(
          `OpenCode: ${stats.totalProjects} projects, ${stats.totalSessions} sessions, ${stats.totalMessages} messages, ${stats.totalParts} parts`
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to get stats: ${msg}`);
      }
    })
  );

  const pollConfig = vscode.workspace.getConfiguration("ocSessions");
  const pollHours = Math.max(1, pollConfig.get<number>("pollIntervalHours", 1));
  const pollInterval = setInterval(() => {
    panelProvider.refresh();
  }, pollHours * 3600 * 1000);

  context.subscriptions.push({
    dispose() {
      clearInterval(pollInterval);
      dataProvider.dispose();
    },
  });
}

export function deactivate() {}
