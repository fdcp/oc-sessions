# OpenCode Sessions

Browse, search, export [OpenCode](https://opencode.ai) session history, and chat with AI directly in VS Code.

## Features

### Sessions Tab
- **Turn-Based View** — Messages grouped by USER/ASSISTANT turns with fold/unfold
- **Turn Summaries** — Folded turns show text snippet + tool/patch counts
- **Load Multiple Turns** — Select to load 1, 2, 3, 4, 5, or all turns at once
- **Full Conversation Content** — View user messages, AI reasoning, tool calls/results, patches
- **Directory Browser** — Select from all directories where OpenCode has been used
- **Session List** — Paginated session list with turn count and timestamps
- **Content Viewer** — Click any message to see its full content
- **Display Options** — Toggle visibility of text, reasoning, tools, patches, metadata
- **Export to Markdown** — Export selected messages as Markdown
- **Delete** — Delete sessions or messages (with confirmation)

### OpenCode Tab (New in 0.9.x)
- **AI Chat** — Send messages to an OpenCode AI agent and view responses inline
- **Summarize** — AI summarizes the current session's markdown files and conversation history
- **Stop** — Interrupt AI processing at any time
- **Model Selection** — Choose from available AI providers and models
- **Session Isolation** — Each chat/summarize runs in its own session with restricted permissions to prevent runaway loops

## How It Works

OpenCode stores session data in a SQLite database at `~/.local/share/opencode/opencode.db`. This extension reads from that database using Python 3's built-in `sqlite3` module (invoked via `child_process`).

The OpenCode Tab communicates with the OpenCode SDK (`@opencode-ai/sdk`) to start sessions and stream AI responses.

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
| `ocSessions.sessionsPerPage` | 10 | Sessions per page |
| `ocSessions.messagesPerPage` | 10 | Messages per page |
| `ocSessions.dbPath` | (auto) | Custom path to `opencode.db` |
| `ocSessions.exportPath` | (empty) | Default export directory |

## Installation

### From VS Code Marketplace (Recommended)

Search for "OpenCode Sessions" in VS Code Extensions, or install from:
https://marketplace.visualstudio.com/items?itemName=zhaoxiuwei.oc-sessions

### From VSIX

```bash
code --install-extension oc-sessions-0.9.1.vsix
```

Get the latest VSIX from the [Releases](https://github.com/fdcp/oc-sessions/releases) page.

## Usage

### Browsing Sessions
1. Click the OpenCode Sessions icon in the Activity Bar (left sidebar)
2. Select a directory from the dropdown
3. Click a session to load its turns
4. Turns are folded by default — click the `▶` icon to expand
5. Use checkboxes to select messages for export
6. Click "Load Next Turns" to load more (select 1-5 or all)
7. Click "Export to MD" to save as Markdown

### Using the OpenCode Tab
1. Switch to the **OPENCODE** tab in the Sessions panel
2. Select an AI provider and model from the dropdowns
3. Type a message and click **Send**, or click **Summarize** to summarize the current session
4. Click **Stop** to interrupt the AI at any time

## Building from Source

```bash
cd oc_sessions
npm install
npx webpack --mode production
npx @vscode/vsce package --no-dependencies --no-yarn --allow-missing-repository
```

## License

MIT
