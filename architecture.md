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

### Engine (`src/engine/engine.ts`)
Executes workflow steps, resolves worktrees, injects env vars. Auto-injects `SPARKFLOW_*` env vars from `git` config into every step environment:
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
- `shell` — runs arbitrary shell commands
- `pr-watcher` — polls GitHub for CI results and review activity
- `workflow` — dispatches child workflows (supports `foreach`)

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
