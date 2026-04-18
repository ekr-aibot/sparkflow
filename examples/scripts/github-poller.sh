#!/usr/bin/env bash
set -euo pipefail

# Find issues to dispatch. Emits a JSON array of { issue_number, title, body }.
# Uses gh issue list and filters out ones already labeled in-progress.
# Claims remaining ones by adding the in-progress label.

repo_args=()
[[ -n "${SPARKFLOW_PR_REPO:-}" ]] && repo_args=(--repo "$SPARKFLOW_PR_REPO")

# 1. Fetch candidates
candidates=$(gh issue list "${repo_args[@]}" \
  --label ready-for-claude --state open \
  --json number,title,body,labels)

# 2. Filter out already in-progress, map to desired output schema
to_dispatch=$(jq -c '
  map(select(any(.labels[]; .name == "in-progress") | not))
  | map({issue_number: .number, title: .title, body: (.body // "" | .[0:2000])})
' <<<"$candidates")

# 3. Claim issues (mark in-progress)
# We do this before emitting so a second poll won't double-dispatch if the first one
# is still starting up.
for num in $(jq -r '.[].issue_number' <<<"$to_dispatch"); do
  echo "[poller] Claiming issue #$num..." >&2
  gh issue edit "$num" "${repo_args[@]}" --add-label in-progress >&2
done

# 4. Emit the JSON to stdout for the engine to parse
echo "$to_dispatch"
