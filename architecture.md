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
