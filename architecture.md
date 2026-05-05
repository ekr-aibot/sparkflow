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

### Quota / Rate-Limit Handling

When a runtime adapter returns `quotaHit: true`, the engine waits with exponential backoff (60 s → 120 s → 300 s → 600 s → 1800 s → 3600 s) and retries the step without counting the wait against `max_retries` or `retry.attempts`. This avoids treating a temporary API quota exhaustion as a permanent job failure. `StepStatus.quotaWaitAttempts` tracks how many times the step has waited. The dashboard receives a `{"type":"quota_wait", "step": …, "wait_seconds": …, "attempt": …}` event on stderr.

Detection patterns (both `ClaudeCodeAdapter.isQuotaError` and `GeminiAdapter`):
- Claude: `is_error` result events or stderr containing "rate limit", "quota", "overloaded", "too many requests", "529"
- Gemini: stderr containing any of the above plus "RESOURCE_EXHAUSTED"

### Pasted Image Serving

Pasted images (from chat `Ctrl+V`) are saved to `<repo>/.sparkflow/pasted/<ts>-<rand>.<ext>` by `POST /repos/:repoId/paste-image`. A companion `GET /repos/:repoId/pasted/:filename` endpoint (in `frontend-daemon.ts`) serves those bytes back to the browser with `Cache-Control: private, max-age=86400`. Filename validation uses a strict allowlist regex (`^[A-Za-z0-9_.-]+\.(png|jpg|jpeg|gif|webp)$`) plus `realpathSync` traversal check.

`extractPastedImageRefs` (`src/dashboard/paste-refs.ts`) extracts `@.sparkflow/pasted/<filename>` references from plan text. It is called in `JobManager.startJob()` from either `opts.planText` (direct) or `opts.plan` (read from file), and the resulting relpaths are stored on `JobInfo.attachedImages`. These flow to the frontend via the existing `JobSnapshotMessage` → `JobInfo[]` wire path and are used to render image thumbnails in the job-slug hover tooltip.

The dashboard chat pane shows a thumbnail strip (`.paste-strip`) that is an absolute overlay at the bottom of the chat pane, populated when images are pasted and cleared when a new job is dispatched. The job list renders a `#slug-tooltip` overlay on hover when `job.attachedImages` is non-empty.

### Worktree Manager (`src/engine/worktree.ts`)
Creates isolated git worktrees per step or per run. Mode `isolated` creates a named branch (for PRs); mode `fork` creates a detached HEAD checkout.

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
