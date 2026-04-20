#!/usr/bin/env bash
set -euo pipefail

state_dir=".sparkflow/state/jobs"
handled_dir=".sparkflow/state/handled-by-fixer"
mkdir -p "$handled_dir"

if [[ ! -d "$state_dir" ]]; then
  echo '[]'
  exit 0
fi

excluded='["fixer","fixer-one","github-poller"]'

items=$(
  find "$state_dir" -maxdepth 1 -name '*.json' 2>/dev/null \
  | xargs -r -I{} jq -c --argjson excluded "$excluded" '
      select(.info.state == "failed")
      | select((.info.workflowName // "") as $n | ($excluded | index($n)) | not)
      | {
          job_id:        .info.id,
          log_path:      .logPath,
          workflow_name: (.info.workflowName // ""),
          workflow_path: (.info.workflowPath // ""),
          slug:          (.info.slug // "")
        }
    ' {} \
  | while IFS= read -r row; do
      id=$(jq -r '.job_id' <<<"$row")
      if [[ ! -e "$handled_dir/$id" ]]; then
        echo "$row"
      fi
    done \
  | jq -s '.'
)

echo "$items"
