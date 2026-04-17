# OpenCode Sessions

Browse, search, and export [OpenCode](https://opencode.ai) session history directly in VS Code.

## Features

- **Full Conversation Content** — View user messages, AI reasoning, tool calls/results, patches, and metadata from the `part` table
- **Directory Browser** — Select from all directories where OpenCode has been used
- **Session List** — Paginated session list with summary, message count, and timestamps
- **Message List** — Paginated messages with checkboxes for batch export, search/filter support
- **Content Viewer** — Click any message to see its full content (text, reasoning, tool calls, patches)
- **Display Options** — Toggle visibility of text, reasoning, tools, patches, and metadata
- **Export to Markdown** — Export selected messages with configurable inclusion of reasoning and tool calls
- **Delete** — Right-click to delete sessions or messages (with confirmation)
- **Statistics** — View total counts of projects, sessions, messages, and parts
- **Auto Refresh** — Configurable polling interval (minimum 1 hour) + manual refresh button

## How It Works

OpenCode stores session data in a SQLite database at `~/.local/share/opencode/opencode.db`. This extension reads from that database using Python 3's built-in `sqlite3` module (invoked via `child_process`).

### Data Structure

| Table | Content |
|-------|---------|
| `project` | Directories where OpenCode was used |
| `session` | Sessions with title, directory, timestamps |
| `message` | Messages with role, agent, model, token usage |
| `part` | Actual conversation content — text, reasoning, tool calls, patches |

## Requirements

- **VS Code** 1.80.0 or later
- **Python 3** installed and available as `python3` in PATH
- **OpenCode** installed with data at `~/.local/share/opencode/`

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `ocSessions.pollIntervalHours` | 1 | Auto-refresh interval in hours (minimum 1) |
| `ocSessions.sessionsPerPage` | 10 | Sessions per page (5 or 10) |
| `ocSessions.messagesPerPage` | 10 | Messages per page (5, 10, or 20) |
| `ocSessions.dbPath` | (auto) | Custom path to `opencode.db` |
| `ocSessions.exportPath` | (empty) | Default export directory |

## Usage

1. Click the OpenCode Sessions icon in the Activity Bar (left sidebar)
2. Select a directory from the dropdown
3. Click a session to load its messages
4. Click a message to view its full content
5. Use checkboxes to select messages for export
6. Adjust display options at the bottom to show/hide content types
7. Click "Export to MD" to save selected messages as Markdown

## Install from VSIX

```bash
code --install-extension oc-sessions-0.3.0.vsix
```

## Building from Source

```bash
cd oc_sessions
yarn install --ignore-engines
npx webpack --mode production
npx @vscode/vsce package --no-dependencies --allow-missing-repository --no-yarn
```
