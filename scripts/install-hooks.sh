#!/usr/bin/env bash
set -euo pipefail

# Requires git; silently skip if not in a git repo (e.g., CI containers with baked node_modules).
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[sparkflow] not a git repo — skipping hook installation" >&2
  exit 0
fi

git config core.hooksPath hooks
echo "[sparkflow] git hooks installed (core.hooksPath=hooks)"
