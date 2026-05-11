#!/usr/bin/env bash
# Shared helper invoked by post-merge and post-rewrite.
# Callers must export:
#   SPARKFLOW_DIFF_OLD — old-tree SHA (or ORIG_HEAD)
#   SPARKFLOW_DIFF_NEW — new-tree SHA (or HEAD)
#
# Output goes to stderr so it doesn't pollute git pull stdout.

set -euo pipefail

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HOOKS_DIR/.." && pwd)"

# ── Opt-out ──────────────────────────────────────────────────────────────────
if [[ -n "${SPARKFLOW_SKIP_AUTOBUILD:-}" ]]; then
  echo "[sparkflow] auto-build skipped (SPARKFLOW_SKIP_AUTOBUILD set)" >&2
  exit 0
fi

# ── Resolve diff range ────────────────────────────────────────────────────────
OLD="${SPARKFLOW_DIFF_OLD:-}"
NEW="${SPARKFLOW_DIFF_NEW:-}"

if [[ -z "$OLD" || -z "$NEW" ]]; then
  echo "[sparkflow] _run-build.sh: missing SPARKFLOW_DIFF_OLD or SPARKFLOW_DIFF_NEW" >&2
  exit 0
fi

# If nothing actually changed (no-op pull), skip silently.
if [[ "$OLD" == "$NEW" ]]; then
  exit 0
fi

# ── Collect changed files ─────────────────────────────────────────────────────
CHANGED_FILES="$(git -C "$REPO_ROOT" diff-tree -r --name-only "$OLD" "$NEW" 2>/dev/null || true)"

# ── Decide whether a rebuild is needed ───────────────────────────────────────
DIST_ENTRY="$REPO_ROOT/dist/src/cli/index.js"
BUILD_NEEDED=0

# Always build if dist/ is absent.
if [[ ! -f "$DIST_ENTRY" ]]; then
  BUILD_NEEDED=1
fi

# Build if any source-relevant file changed.
if [[ $BUILD_NEEDED -eq 0 ]]; then
  while IFS= read -r f; do
    case "$f" in
      src/*|package.json|package-lock.json|tsconfig.json) BUILD_NEEDED=1; break ;;
    esac
  done <<< "$CHANGED_FILES"
fi

if [[ $BUILD_NEEDED -eq 0 ]]; then
  exit 0
fi

# ── Lockfile ──────────────────────────────────────────────────────────────────
LOCK="$HOOKS_DIR/.build.lock"
if ! (set -C; echo $$ > "$LOCK") 2>/dev/null; then
  existing_pid=$(cat "$LOCK" 2>/dev/null || echo "")
  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "[sparkflow] another build in progress; skipping" >&2
    exit 0
  fi
  # Stale lock (process gone) — remove and re-acquire.
  rm -f "$LOCK"
  (set -C; echo $$ > "$LOCK") 2>/dev/null || { echo "[sparkflow] could not acquire build lock" >&2; exit 0; }
fi
trap 'rm -f "$LOCK"' EXIT

# ── Build ─────────────────────────────────────────────────────────────────────
cd "$REPO_ROOT"
if npm run build >&2; then
  echo "[sparkflow] rebuilt dist/" >&2
else
  echo "" >&2
  echo "[sparkflow] BUILD FAILED — dist/ is stale; fix and run \`npm run build\`" >&2
  exit 0  # Do NOT fail the pull.
fi

# ── Daemon-side notice ────────────────────────────────────────────────────────
DAEMON_PATHS_JSON="$HOOKS_DIR/daemon-side-paths.json"
if [[ ! -f "$DAEMON_PATHS_JSON" ]]; then
  exit 0
fi

# Read daemon-side path prefixes from JSON (requires jq; skip gracefully if absent).
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

DAEMON_PREFIXES="$(jq -r '.[]' "$DAEMON_PATHS_JSON")"

DAEMON_CHANGED=()
while IFS= read -r f; do
  while IFS= read -r prefix; do
    if [[ "$f" == "$prefix"* ]]; then
      DAEMON_CHANGED+=("$f")
      break
    fi
  done <<< "$DAEMON_PREFIXES"
done <<< "$CHANGED_FILES"

if [[ ${#DAEMON_CHANGED[@]} -gt 0 ]]; then
  LIST="$(IFS=', '; echo "${DAEMON_CHANGED[*]}")"
  echo "[sparkflow] daemon-side files changed: $LIST. Restart sparkflow for these to take effect (in-flight jobs unaffected)." >&2
fi
