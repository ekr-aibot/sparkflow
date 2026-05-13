#!/usr/bin/env bash
# adopt-pr.sh — swap the workflow's worktree to an existing PR's head branch.
#
# Reads $SPARKFLOW_PROMPT (the plan text prepended to this step's prompt) and
# looks for a sentinel like `<!-- adopt-pr: 114 -->`. When present:
#   1. Resolve the PR's head branch via `gh pr view`.
#   2. Fetch it from origin.
#   3. If another worktree is holding that branch, force-remove it.
#   4. Switch the current worktree to that branch (resetting it to origin's tip).
#   5. Delete the now-orphaned fresh `sparkflow/_run-<id>` branch.
# When the sentinel is absent, the script no-ops successfully.

set -euo pipefail

prompt="${SPARKFLOW_PROMPT-}"
if [ -z "$prompt" ]; then
  echo "[adopt-pr] SPARKFLOW_PROMPT empty; nothing to inspect"
  exit 0
fi

pr_num="$(printf '%s' "$prompt" | grep -oE '<!--[[:space:]]*adopt-pr:[[:space:]]*[0-9]+[[:space:]]*-->' | head -1 | grep -oE '[0-9]+' || true)"
if [ -z "$pr_num" ]; then
  echo "[adopt-pr] no '<!-- adopt-pr: N -->' sentinel; running as fresh-branch workflow"
  exit 0
fi

echo "[adopt-pr] adopting PR #$pr_num"

head_branch="$(gh pr view "$pr_num" --json headRefName --jq '.headRefName')"
if [ -z "$head_branch" ]; then
  echo "[adopt-pr] gh pr view returned no headRefName for #$pr_num" >&2
  exit 1
fi
echo "[adopt-pr] PR #$pr_num head branch: $head_branch"

git fetch origin "$head_branch"

current_wt="$(git rev-parse --show-toplevel)"
existing_wt="$(git worktree list --porcelain \
  | awk -v target="refs/heads/$head_branch" '
      /^worktree / { wt=$2 }
      $0 == "branch " target { print wt; exit }
    ')"

if [ -n "$existing_wt" ] && [ "$existing_wt" != "$current_wt" ]; then
  echo "[adopt-pr] removing existing worktree at $existing_wt"
  git worktree remove --force "$existing_wt"
fi

prev_branch="$(git rev-parse --abbrev-ref HEAD)"
git checkout -B "$head_branch" "origin/$head_branch"

if [ "$prev_branch" != "$head_branch" ] && printf '%s' "$prev_branch" | grep -qE '^sparkflow/_run-'; then
  echo "[adopt-pr] deleting orphaned fresh branch $prev_branch"
  git branch -D "$prev_branch" 2>/dev/null || true
fi

echo "[adopt-pr] now on $(git rev-parse --abbrev-ref HEAD)"
