# OpenCode Sessions - Installation & Usage Guide

## Installation

### Method 1: Install from VSIX (manual)

```bash
code --install-extension oc-sessions-0.3.0.vsix
```

Or in VS Code: `Ctrl+Shift+P` → "Extensions: Install from VSIX..." → select the `.vsix` file.

### Method 2: Install from Marketplace

Search "OpenCode Sessions" in VS Code Extensions panel and click Install.

After installation, reload VS Code (`Ctrl+Shift+P` → "Developer: Reload Window").

## Requirements

- VS Code 1.80.0+
- Python 3 (available as `python3` in PATH)
- OpenCode data at `~/.local/share/opencode/`

## Usage

### Browse Sessions

1. Click the **OpenCode Sessions** icon in the left Activity Bar
2. Select a **directory** from the top dropdown (auto-selects the first one)
3. Click a **session** in the session list
4. Click a **message** to view its full content

### Content Types

The Content Viewer shows all parts of a message:

| Type | Description |
|------|-------------|
| **Text** | User input and AI response text |
| **Reasoning** | AI thinking/reasoning process |
| **Tool** | Tool calls with input/output (e.g., file read, web fetch) |
| **Patch** | File modifications (commit hash, affected files) |
| **Metadata** | Token usage, timing, model info |

Use the **Display Options** checkboxes at the bottom to toggle each type.

### Export to Markdown

1. Check the messages you want to export (or use "Select All")
2. Configure **Export Options**: include reasoning and/or tool calls
3. Click **Export to MD**
4. Choose save location

### Delete Session / Message

Hover over a session or message row and click the trash icon. A confirmation dialog will appear. Deletion is permanent and removes the data from the SQLite database.

### Statistics

Click the graph icon in the panel toolbar to see total counts.

### Refresh

Click the refresh icon in the panel toolbar, or wait for the auto-refresh interval.

## Settings

Open VS Code Settings (`Ctrl+,`) and search for "OpenCode Sessions":

| Setting | Default | Description |
|---------|---------|-------------|
| `ocSessions.pollIntervalHours` | 1 | Auto-refresh interval in hours (minimum 1) |
| `ocSessions.sessionsPerPage` | 10 | Sessions per page (5 or 10) |
| `ocSessions.messagesPerPage` | 10 | Messages per page (5, 10, or 20) |
| `ocSessions.dbPath` | (auto) | Custom path to `opencode.db` |
| `ocSessions.exportPath` | (empty) | Default export directory |

## Building from Source

```bash
cd oc_sessions
yarn install --ignore-engines
npx webpack --mode production
npx @vscode/vsce package --no-dependencies --allow-missing-repository --no-yarn
```

## Publishing to Marketplace

1. Create a Publisher at https://marketplace.visualstudio.com/manage
2. Generate a PAT at https://dev.azure.com/ (Scopes: Marketplace → Manage)
3. Update `publisher` field in `package.json`
4. Run:
   ```bash
   npx @vscode/vsce login <publisher-id>
   npx @vscode/vsce publish
   ```
