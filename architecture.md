# Sparkflow Architecture

## Overview

Sparkflow is a workflow engine that orchestrates multi-step AI agent pipelines. It runs steps in parallel or sequentially, each in its own git worktree, and coordinates LLM runtimes (Claude Code, Gemini) with shell, PR creation, and PR watching steps.

## Key Components

### Config (`src/config/project-config.ts`)
Loads and merges user-level (`~/.sparkflow/config.json`) and project-level (`.sparkflow/config.json`) config. Project fields win; nested objects (`git`) are replaced whole (not deep-merged).

**GitConfig fields:**
- `push_remote` — remote name for `git push` (default: `"origin"`)
- `pull_remote` — remote name for fetching the base branch before diffing (default: `push_remote`). Supports fork workflows where upstream ≠ push target.
- `pr_repo` — `OWNER/NAME` for PR creation/watching
- `issues_repo` — `OWNER/NAME` for issue polling (default: `pr_repo`). Decouples issue tracker from PR target.
- `base` — base branch for PRs

### Template Engine (`src/engine/template.ts`)
`resolveTemplate(text, stepOutputs, itemContext?, config?)` interpolates three forms:
- `${steps.<id>.output.<field>}` — output from a prior step
- `${item}` / `${item.<field>}` — current foreach item (only when `itemContext` is set)
- `${config.<dot.path>}` — value from the merged `ProjectConfig` (only when `config` is passed); missing paths render as `<sparkflow:missing-config path="...">` and the shell adapter fails fast with a helpful error

### Engine (`src/engine/engine.ts`)
Executes workflow steps, resolves worktrees, injects env vars. Passes `config` to every `resolveTemplate` call so `${config.X}` works in prompts, transition messages, step `env` values, and shell `args`. Puts the full `ProjectConfig` on `RuntimeContext.projectConfig` for adapters that need it. Auto-injects `SPARKFLOW_*` env vars from `git` config into every step environment:
- `SPARKFLOW_PR_REPO`, `SPARKFLOW_PUSH_REMOTE`, `SPARKFLOW_BASE_BRANCH` from their respective fields
- `SPARKFLOW_ISSUES_REPO` from `issues_repo ?? pr_repo`

### PR Creator (`src/runtime/pr-creator.ts`)
1. Pushes current branch to `push_remote`
2. Fetches `pull_remote/<base>` best-effort (swallows network failures)
3. Uses `<pull_remote>/<base>` as the diff base for `git log` and `git diff --stat` (falls back to bare branch name if the remote ref doesn't exist locally)
4. Generates PR title/summary via Claude, creates PR via `gh`

### Runtimes
- `claude-code` — spawns `claude` CLI with a prompt, supports nudges and session resumption
- `gemini` — spawns `gemini` CLI
- `codex` — spawns OpenAI `codex exec --json` for NDJSON streaming; session ID captured from events for resume; multi-turn nudge via `user_input` events on stdin; MCP wired via a temp `--config-file` TOML; helper code in `src/runtime/codex-flags.ts`
- `shell` — runs arbitrary shell commands; applies `resolveTemplate` to `command` and each `arg` before spawning, so `${config.X}` and `${steps.X.output.Y}` work in shell args; fails fast with a clear error if a config path resolves to missing
- `pr-watcher` — polls GitHub for CI results and review activity
- `workflow` — dispatches child workflows (supports `foreach`)

### Side-Chat Pool (`src/dashboard/engine-daemon.ts`)

The engine daemon owns a pool of PTY sessions keyed by `chatId`:
- `"main"` — the MCP-wired sparkflow chat (launched via `buildChatSpawn`)
- `"sidechat-N"` — stripped bare instances (no MCP, no system prompt) for parallel conversations

Clients create side-chats via `POST /repos/:repoId/chats` and close them via `DELETE /repos/:repoId/chats/:chatId`. The frontend daemon proxies these requests to the engine over the PTY bridge unix socket using a request-id correlation protocol.

WebSocket connections carry `?chatId=<id>` to bind to a specific chat session's ring buffer and PTY data stream. Max 8 concurrent side-chats per engine (returns 429 beyond).

`buildBareChatSpawn` (`src/tui/chat-tool.ts`) builds the stripped argv — no `--mcp-config`, no `--append-system-prompt`, no file writes for gemini.

### Job Recovery & Resume

When a `sparkflow-run` engine process dies while a job is in `failed_waiting` state, the dashboard can restart it from where it left off:

- **`restart_job(mode="fresh")`** — kills the old process and re-runs the whole workflow from step one (existing behavior).
- **`restart_job(mode="resume")`** — starts a new engine from the `failedStep`, preserving committed work:
  1. Determines the resume step from `job.info.failedStep` or the disk-persisted state (since `answerRecovery` may have cleared it in-memory before the process died).
  2. Passes `--resume-from <stepId>` and `--existing-worktree <path>` to the new engine process.
  3. The engine pre-seeds all success-edge ancestors of the resume step as `"succeeded"` so they are skipped.
  4. The engine reuses the existing worktree directory instead of creating a new one.

**Worktree path persistence**: When the engine creates a run-level worktree it emits a `{type: "run_info", worktreePath: "..."}` JSON event on stderr. The dashboard captures this and persists it in `JobInfo.worktreePath`. For older jobs (before this feature), the path is recovered by parsing the human-readable log line.

**`failed_waiting` persistence fix**: The `job_failed` event handler now calls `schedulePersist` so the `failed_waiting` state (including `failedStep`) survives a daemon restart.

**`answerRecovery` liveness check**: `answerRecovery` now verifies the engine process is alive before writing to its stdin, preventing in-memory state from drifting to `"running"` when the process is already dead.

### Nudge Acknowledgement Lifecycle

Each `nudge_job` call is tracked end-to-end through three phases: **received → delivered → acked** (or **abandoned** on early worker death).

**Identity:** The IPC handler (or engine-daemon command handler) generates a `nudgeId = randomBytes(8).toString("hex")` and threads it through the entire call chain.

**Phase events** (emitted to process.stderr as JSON by the worker process, picked up by the LogTailer and processed in `handleStatusLine`):
- `{type:"nudge_event", phase:"received", nudge_id, step, at}` — engine.ts, when nudge is queued on the NudgeQueue
- `{type:"nudge_event", phase:"delivered", nudge_id, step, at}` — claude-code.ts, when the message is written to the LLM's stdin
- `{type:"nudge_event", phase:"acked", nudge_id, step, at, duration_ms, turn_count}` — claude-code.ts, when the first `result` event arrives after delivery
- `{type:"nudge_event", phase:"abandoned", nudge_id, step, at, reason}` — claude-code.ts, when the child exits with a delivered-but-not-acked nudge

**JobManager** maintains `JobInfo.nudges: NudgeRecord[]` and a `nudgeWaiters` map. When acked/abandoned events arrive, any registered waiter is resolved. Worker death also abandons in-flight waiters.

**MCP tool blocking:** `nudge_job` in the IPC handler awaits `jobManager.waitForNudgeAck(nudgeId, timeoutMs)` before returning, so the MCP tool call blocks until the LLM has responded. On timeout it returns `{ok:false, status:"pending", nudgeId}`.

**Status pane** shows `nudge:pending(Xs)` while in flight and `nudge:ack Xs (Y turns)` for ~5 s after ack.

### Codex Chat Surface (`src/tui/codex-chat.ts`)

The `codex` chat tool uses a different configuration mechanism than Claude and Gemini:
- **MCP:** installs a marker-bounded `[mcp_servers.sparkflow]` block in `~/.codex/config.toml` on chat start, removed on exit.
- **System prompt:** merges a marker-bounded block into `AGENTS.md` in the project cwd (Codex's equivalent of `CLAUDE.md`).
- **Slash commands:** writes `~/.codex/prompts/sf-*.md` files; cleaned up on exit.

`buildChatSpawn("codex")` and `buildBareChatSpawn("codex")` in `src/tui/chat-tool.ts` delegate to these helpers.

`SPARKFLOW_LLM=codex` swaps `claude-code` and `gemini` steps to `codex` (same mechanics as the existing gemini swap). `ToolKind` in `src/dashboard/ipc-protocol.ts` includes `"codex"` alongside `"claude"` and `"gemini"`.

### Quota / Rate-Limit Handling

When a runtime adapter returns `quotaHit: true`, the engine waits with exponential backoff (60 s → 120 s → 300 s → 600 s → 1800 s → 3600 s) and retries the step without counting the wait against `max_retries` or `retry.attempts`. This avoids treating a temporary API quota exhaustion as a permanent job failure. `StepStatus.quotaWaitAttempts` tracks how many times the step has waited. The dashboard receives a `{"type":"quota_wait", "step": …, "wait_seconds": …, "attempt": …}` event on stderr.

Detection patterns (both `ClaudeCodeAdapter.isQuotaError` and `GeminiAdapter`):
- Claude: `is_error` result events or stderr containing "rate limit", "quota", "overloaded", "too many requests", "529"
- Gemini: stderr containing any of the above plus "RESOURCE_EXHAUSTED"

### Pasted Image Serving

Pasted images (from chat `Ctrl+V`) are saved to `<repo>/.sparkflow/pasted/<ts>-<rand>.<ext>` by `POST /repos/:repoId/paste-image`. A companion `GET /repos/:repoId/pasted/:filename` endpoint (in `frontend-daemon.ts`) serves those bytes back to the browser with `Cache-Control: private, max-age=86400`. Filename validation uses a strict allowlist regex (`^[A-Za-z0-9_.-]+\.(png|jpg|jpeg|gif|webp)$`) plus `realpathSync` traversal check.

`extractPastedImageRefs` (`src/dashboard/paste-refs.ts`) extracts `@.sparkflow/pasted/<filename>` references from plan text. It is called in `JobManager.startJob()` from either `opts.planText` (direct) or `opts.plan` (read from file), and the resulting relpaths are stored on `JobInfo.attachedImages`. These flow to the frontend via the existing `JobSnapshotMessage` → `JobInfo[]` wire path and are used to render image thumbnails in the job-slug hover tooltip.

The dashboard chat pane shows a thumbnail strip (`.paste-strip`) that is an absolute overlay at the bottom of the chat pane, populated when images are pasted and cleared when a new job is dispatched. The job list renders a `#slug-tooltip` overlay on hover when `job.attachedImages` is non-empty.

### First-Run Onboarding (`src/cli/init-interview.ts`)

Interactive CLI interview that runs before the dashboard launches when `.sparkflow/config.json` is missing in the project directory.

**Entry points:**
- `shouldAutoTrigger(cwd)` — returns true iff `.sparkflow/config.json` is absent, `stdin` is a TTY, and `SPARKFLOW_SKIP_INIT` is not set.
- `runInitInterview({ cwd, existing })` — runs 8 prompts (via `@inquirer/prompts`), returns a validated `ProjectConfig`. Does not write to disk. Exits 130 on Ctrl-C; exits 0 if user declines the confirm.
- `detectGitDefaults(cwd)` — best-effort autodetect of `push_remote`/`pull_remote` from `git remote -v` and `pr_repo`/`base` from `gh repo view`. Swallows all errors.

**Wire-up in `src/tui/index.ts`:**
- `sparkflow init` subcommand: detected before `parseArgs`; runs the interview with the existing merged config as defaults, writes the result, exits 0.
- Auto-trigger: checked after `parseArgs`; if `shouldAutoTrigger` is true, runs the interview with `existing = null` and writes the result before proceeding to the normal dashboard launch.

**Workflow listing:** Concatenates `.sparkflow/workflows/` (project) and `~/.sparkflow/flows/` (user) with project shadowing user on name conflicts. Aborts with an error if both are empty. The default-workflow select only shows workflows with `"kind": "main"` in their JSON; the monitors checkbox only shows workflows with `"kind": "monitor"`. Workflows with `"kind": "helper"` are excluded from both — they are invocation-only and must not be auto-started without inputs.

### Worktree Manager (`src/engine/worktree.ts`)
Creates isolated git worktrees per step or per run. Mode `isolated` creates a named branch (for PRs); mode `fork` creates a detached HEAD checkout. Auto-generated branch names for `isolated` mode include a random 8-hex suffix (`sparkflow/<stepId>-<runId>-<rand>`).

**Isolated worktree persistence**: `isolated` worktrees persist for the lifetime of a single step invocation. `resolve(stepId, …)` caches the path on first call; subsequent calls for the same `stepId` return the cached path immediately without touching disk. This means failure-edge retries resume the same branch and see all prior commits.

**`invalidate(stepId)`**: Removes the cached worktree (best-effort `git worktree remove --force`) and deletes the cache entry so the next `resolve()` allocates a fresh worktree with a new random branch suffix. Called by the engine when a step is re-entered after success (new loop iteration). `wasEverRegistered(path)` returns true for any path that was ever allocated by `resolve()`, even after invalidation; used to attach diagnostic hints to "cwd does not exist" adapter errors.

**`fork_from`**: A `fork` worktree may set `fork_from: <stepId>` to use the HEAD of another step's `isolated` worktree as its base commit. The engine calls `worktreeManager.getPath(fork_from)` and runs `git rev-parse HEAD` there on each invocation, so re-runs of the fork step automatically see the latest commits from the source step. Throws a clear `Error` if the source step's worktree has not been resolved yet (wrong transition order). The engine skips the per-success cleanup for `isolated` worktrees so they remain accessible to downstream `fork_from` steps.

**Re-entry after success = new invocation**: When `triggerStep` fires for a step whose current state is `"succeeded"`, the engine treats it as a completely fresh invocation rather than a retry. It resets `retryCount`, `tokenLimitResumes`, `sessionId`, `lastError`, `inPlaceAttempt`, and `outputs`, and calls `worktreeManager.invalidate(stepId)` for `isolated` worktrees. This makes multi-task loops (e.g. `auto-develop`) correct: each iteration gets a fresh claude session and a fresh branch, while genuine failure-edge retries (state `"failed"` → re-trigger) still keep the session and worktree intact.

### Worktree Confinement Guardrails
Two complementary mechanisms prevent agents from accidentally committing to the parent repo instead of their isolated worktree:

**Preventive (soft reminder):** The `claude-code` adapter prepends a system reminder to the agent's prompt whenever `ctx.cwd !== ctx.repoRoot`. The reminder tells the agent to stay inside the worktree and avoid absolute parent-repo paths or `git -C` targeting the parent.

**Detective (escape detection):** The engine captures the parent repo's HEAD SHA before spawning any worktree step, then re-checks it after the step finishes. If the parent HEAD moved but the worktree received no new commits, the step is failed with a descriptive error naming the runaway SHA. This catches both direct `cd` escapes and indirect `git -C` escapes.

## Process Architecture & Hot-Reload Semantics

Sparkflow runs as three distinct Node process layers. Knowing which layer holds which code is essential for understanding what does and does not pick up a new `dist/` after `npm run build`.

```
sparkflow (TUI / src/tui/index.ts)        — foreground, long-running
  └─ engine-daemon (dist/src/dashboard/engine-daemon.js)   — per-project, long-running
       └─ sparkflow-run (dist/src/cli/index.js)            — per-job, short-lived
```

The TUI spawns one engine-daemon per project (`src/tui/index.ts` ≈ line 521). The engine-daemon imports `JobManager` from `src/tui/job-manager.ts`, which for each dispatch calls `spawn(process.execPath, [SPARKFLOW_RUN_PATH, …], { detached: true })` (`src/tui/job-manager.ts` ≈ line 193). Each `sparkflow-run` child is a fresh Node process that loads `dist/src/cli/index.js` from disk at spawn time, which in turn loads the workflow engine and all runtime adapters.

### What auto-picks-up new code (no restart needed)

Any module that runs **only inside the `sparkflow-run` subprocess** picks up changes from `dist/` automatically — the next dispatched job spawns a fresh Node process that reads the latest files. As of this writing this includes:

- `src/engine/*` — workflow engine, worktree manager, template interpolation, scheduler.
- `src/runtime/*` — claude-code adapter, shell, gemini, pr-creator, pr-watcher.
- `src/schema/*` — workflow JSON validation and types.
- `src/config/project-config.ts` — (loaded by both `sparkflow-run` and JobManager; new dispatches see new code via the child, the daemon side keeps the old copy until restarted; see below).

Practically: rebuilding `src/engine/worktree.ts` or `src/runtime/claude-code.ts` and dispatching a new job will use the new behavior with no kill/restart. Existing in-flight jobs keep their original code (they're already running in their own processes).

### What requires a daemon (or TUI) restart

Modules loaded **into the engine-daemon process itself** are cached in memory and do not pick up new code until the daemon restarts. As of this writing this includes:

- `src/tui/job-manager.ts` — the spawn logic itself, log paths, env passthrough.
- `src/tui/ipc-handler.ts`, `src/tui/state-store.ts`, `src/tui/log-tailer.ts`, `src/tui/supervisor.ts`.
- `src/dashboard/*` — engine-daemon entry, IPC protocol, discovery, frontend bridge, ring buffer.
- `src/mcp/ipc.ts` — MCP-tool IPC server.

A change to any of the above only takes effect for daemons spawned after the rebuild. Existing engine-daemon processes keep the old behavior.

The TUI process itself (`src/tui/index.ts` and its imports) is loaded once at sparkflow startup and likewise needs a TUI restart to reflect changes.

### Practical implication

For the common change shape — workflow-engine or runtime-adapter fixes — `npm run build` is sufficient; the next dispatched job picks up the new code automatically. Killing the engine-daemon is unnecessary for those changes and was redundant when previously done. Daemon restart is only needed when modifying daemon-side code (job-manager, IPC, dashboard, chat-tool wiring).

### Auto-rebuild after `git pull`

`hooks/post-merge` and `hooks/post-rewrite` automatically run `npm run build` whenever a pull or rebase brings in changes under `src/`, `package.json`, `package-lock.json`, or `tsconfig.json`. After a successful build, if any files listed in `hooks/daemon-side-paths.json` were among the changed files, the hook prints a notice to restart sparkflow. `hooks/daemon-side-paths.json` is the canonical list of daemon-side path prefixes (one source of truth for both the notice and the table above).

The hooks become active after `npm install` (which runs `scripts/install-hooks.sh` via the `prepare` script, setting `core.hooksPath=hooks`). Set `SPARKFLOW_SKIP_AUTOBUILD=1` to disable auto-build in environments where it is unwanted (e.g. CI).

## Data Flow

```
CLI / Web UI → WorkflowEngine.run()
  → triggerStep() → executeStep()
    → WorktreeManager.resolve()  (git worktree)
    → RuntimeAdapter.run(ctx)    (shell/claude-code/pr-creator/…)
    → onStepComplete/Failure → triggerStep(next)
```

## Config Layering

User config (`~/.sparkflow/config.json`) is the base; project config (`.sparkflow/config.json`) overlays it. Nested objects like `git` are replaced wholesale — a project `git` block drops all user `git` fields.
