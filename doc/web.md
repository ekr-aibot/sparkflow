# Sparkflow web UI

`sparkflow --web` replaces the tmux dashboard with a browser-based interface. Everything you can do in the terminal pane is available in the browser — same MCP tools, same slash commands, same job controls.

## Starting

```
sparkflow --web [--port <n>] [--chat-tool claude|gemini] [--cwd <dir>]
```

On startup the server prints a URL:

```
[sparkflow web] ready at http://127.0.0.1:<port>/?token=<hex>
```

Open that URL once. The server validates the token, sets a session cookie, and redirects to `/`. Subsequent page loads and tab reloads are authorized by the cookie — you don't need the token again until the next server restart (at which point the token regenerates).

`--web` is mutually exclusive with `--status-lines` and `--dev`.

## Layout

The page is divided into two regions:

- **Main pane** (top): the active terminal — either the chat or a job log.
- **Jobs panel** (bottom): a live list of all jobs with controls.

A tab bar above the main pane lets you switch between the chat and any open job view. The **Chat** tab is always present and cannot be closed.

## Chat pane

The chat terminal is a real `claude` (or `--chat-tool gemini`) process running on the server, proxied byte-for-byte to [xterm.js](https://xtermjs.org/) in the browser. Type and interact exactly as you would in a terminal.

**Reconnecting.** Refreshing the page replays the last ~64 KB of chat output so you don't lose context. Multiple browser tabs can attach to the same session simultaneously.

**Slash commands.** The same slash commands available in tmux mode work here — `/sf-jobs`, `/sf-detail`, `/sf-recover`, `/project:sf-plan`, `/project:sf-dispatch`. The `/project:sf-quit` command is omitted; use Ctrl-C on the server console to stop the process instead.

## Jobs panel

Each job appears as a card showing:

| Field | Description |
|---|---|
| Name | Workflow name and slug (e.g. `feature-development: add-auth-flow`) |
| State pill | Current state: `running`, `succeeded`, `failed`, `failed waiting`, `blocked` |
| Step chips | Steps currently executing (color-coded by name) |
| Elapsed time | Wall time since the job started |
| Summary | Last status message or pending question |

### Job actions

| Button | Effect |
|---|---|
| **View** | Opens a tab showing the job's live log output |
| **Kill** | Sends SIGTERM to the job; disabled once the job is terminal |
| **Restart** | Starts a fresh run of the same workflow |
| **×** (top-right of card) | Removes a finished job from the dashboard |

### Monitor jobs

Jobs with `kind: "monitor"` are hidden by default to reduce noise. A **Show monitors** toggle appears in the panel header when at least one monitor job exists. Monitors that need attention (failed, blocked, or waiting for a question) are always shown regardless of the toggle.

## Job log view

Clicking **View** on a job opens a tab with a read-only terminal displaying the job's output.

**Verbose mode.** By default the log shows only the running step's output. Enable the **Verbose** checkbox (top-right of the log) to also show JSON status events, sparkflow infrastructure lines, and step-transition messages.

**Nudge bar.** When a step running inside `claude-code` is active and accepting input, a nudge bar appears at the bottom of the job view. Type a message and click **Send** (or press Enter) to redirect that step mid-run. If the job was rehydrated after a server restart, nudges are disabled (the input shows "nudges unavailable after reload").

## Preferences

The preferences dropdowns appear in the jobs panel header:

| Control | Effect |
|---|---|
| **Chat** | Switch the chat terminal between Claude and Gemini. Requires confirmation — a modal shows a summary of the current session before switching, because switching ends the current PTY and starts a fresh one. |
| **Jobs** | Switch the runtime used by newly-dispatched jobs. Takes effect on the next `start_workflow` call. |

Preferences are persisted server-side and survive page reloads.
