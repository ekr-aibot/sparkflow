# Sparkflow capability reference

This document is the canonical list of everything Claude can do with sparkflow: command-line entry points, MCP tools exposed through the dashboard bridge, and the slash commands injected into the chat tool. The `sparkflow_capabilities` MCP tool returns this file verbatim; keeping this file up to date is how Claude learns about new or changed features.

## Command-line entry points

### `sparkflow` — dashboard

Launches a tmux session with a chat tool in the top pane and a live status display in the bottom pane. The chat tool is spawned with an MCP config that exposes the dashboard tools (see below).

```
sparkflow [options]
```

| Flag | Description |
| --- | --- |
| `--chat-command <cmd>` | Chat tool command. Default: `claude`. |
| `--chat-args <args>` | Extra args for the chat tool, comma-separated. |
| `--cwd <dir>` | Working directory. Default: current directory. |
| `--workflow <path>` | Default workflow for `/project:sf-dispatch`. May be a path or a bare name resolved as `.sparkflow/workflows/<name>.json`. |
| `--status-lines <n>` | Height of the status pane. Default: `5`. |
| `--dev` | Hot-reload mode: run the status daemon under a supervisor that watches `dist/` and respawns on change. In-flight jobs survive reloads. See `doc/hot-reload.md`. |

### `sparkflow-run` — workflow runner

Executes a single workflow. The dashboard's `start_workflow` MCP tool spawns this under the hood, but you can also invoke it directly.

```
sparkflow-run validate [<workflow>]
sparkflow-run run [<workflow>] [--dry-run] [--cwd <dir>] [--plan <plan.md>] [--verbose] [--status-json]
```

| Flag | Description |
| --- | --- |
| `<workflow>` | Path to a JSON workflow file, or a bare name resolved as `.sparkflow/workflows/<name>.json`. If omitted, uses `defaultWorkflow` from `.sparkflow/config.json`. |
| `--dry-run` | Plan the workflow without executing side effects. |
| `--cwd <dir>` | Working directory for the run. |
| `--plan <plan.md>` | Prepend the text of `<plan.md>` to every prompt sent to agents. |
| `--verbose` | Verbose logging. |
| `--status-json` | Emit step-status events as JSON on stderr and read answer events from stdin. Used by the dashboard to drive the status pane. |

## MCP tools (dashboard bridge)

These are exposed by `src/tui/mcp-bridge.ts` when Claude is running inside a `sparkflow` dashboard session.

### Job lifecycle

- **`start_workflow`** — Start a `sparkflow-run` job. Params: `workflow_path` (required), `cwd`, `plan`, `plan_text`, `slug` (≤ 40 chars, 3-word label for the dashboard). Returns a job id.
- **`list_jobs`** — List all jobs with state, step, elapsed time.
- **`get_job_detail`** — Full output log for a specific job. Param: `job_id`.
- **`answer_job_recovery`** — Resolve a job paused in `failed_waiting`. Params: `job_id`, `action` (`retry` | `skip` | `abort`), `message` (required for `retry`, ignored otherwise). For a claude-code step, the agent resumes with `message` as the next user turn — phrase it as a direct instruction.
- **`kill_job`** — SIGTERM a running job. Idempotent on terminal jobs. Logs and worktrees are preserved.
- **`restart_job`** — Restart a job. Params: `job_id`, `mode` (`fresh` (default) | `resume`). `resume` is not implemented yet. Returns a new job id.
- **`remove_job`** — Drop a terminal (succeeded/failed) job from the dashboard and its persisted state. Fails if the job is live; kill it first.
- **`clear_terminal_jobs`** — Drop every terminal job in one call. Returns count removed.

### Introspection

- **`sparkflow_version`** — Returns `{ version, gitCommit?, buildMode }`. `buildMode` is `"dev"` when running under `--dev`, else `"prod"`. `gitCommit` is a short SHA, omitted if the installed package isn't a git checkout.
- **`sparkflow_capabilities`** — Returns this document. Call it when you're unsure what sparkflow can do.
- **`sparkflow_reload_info`** — Returns the most recent hot-reload documentation diff, if any. Useful after a reload to re-read the change notice.

## MCP prompts (slash commands)

These are invoked by typing `/<name>` in the chat tool.

- **`/sf-jobs`** — Quick summary of all running jobs (MCP prompt).
- **`/sf-detail <job_id>`** — Tail of a job's output with a prompt to diagnose failures.
- **`/sf-recover <job_id>`** — Walkthrough for resolving a `failed_waiting` job; produces instructions to craft a correction and call `answer_job_recovery`.
- **`/project:sf-plan <description>`** — Planning mode. Claude clarifies ambiguity, then writes a project plan with Goal / Scope / Approach / Files / Details / Verification sections.
- **`/project:sf-dispatch <workflow?>`** — Writes the plan to disk and calls `start_workflow` with a 3-word slug. If `--workflow` was provided to `sparkflow`, it defaults here.
- **`/project:sf-quit`** — Shuts down the dashboard tmux session (kills all running jobs).

## Hot-reload behavior (dev mode)

When `sparkflow --dev` is running and TypeScript rebuilds `dist/`, the supervisor respawns the status daemon and the MCP bridge briefly disconnects from it. On reconnect, the bridge prepends any changes to `doc/` to the next tool response, wrapped as:

```
[sparkflow reloaded — documentation updates follow]
<diff of doc/*.md since the previous reload>
[end reload notice]
```

If you see that block, the capabilities listed in this document may have changed — read the diff before continuing. If the reload touched no doc files, the notice is a single `[sparkflow reloaded — no documentation changes]` line. See `doc/hot-reload.md` for limitations.

## Related docs

- `doc/schema.md` — workflow JSON schema reference.
- `doc/hot-reload.md` — dev-mode internals and limitations.
