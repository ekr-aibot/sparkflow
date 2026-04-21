#!/usr/bin/env bash
set -euo pipefail

decision="${SPARKFLOW_FIXER_DECISION:?SPARKFLOW_FIXER_DECISION is required}"
job_id="${SPARKFLOW_INPUT_JOB_ID:?SPARKFLOW_INPUT_JOB_ID is required}"

# Mark this job as handled before branching so no re-fire occurs on any path.
mkdir -p .sparkflow/state/handled-by-fixer
touch ".sparkflow/state/handled-by-fixer/$job_id"

action=$(jq -r '.action' <<<"$decision")

case "$action" in
  redispatch)
    workflow_path=$(jq -r '.workflow_path // empty' <<<"$decision")
    plan_text=$(jq -r '.plan_text // empty' <<<"$decision")
    if [[ -z "$workflow_path" ]]; then
      echo "[fixer] redispatch missing workflow_path" >&2
      exit 1
    fi
    mkdir -p .sparkflow/dispatch-queue
    req_file=".sparkflow/dispatch-queue/$(date +%s%N)-${job_id}.json"
    tmp_file="${req_file}.tmp"
    jq -n \
      --arg wf   "$workflow_path" \
      --arg plan "$plan_text" \
      --arg slug "fixer redispatch" \
      '{workflow_path: $wf, plan_text: $plan, slug: $slug}' > "$tmp_file"
    mv "$tmp_file" "$req_file"
    echo "[fixer] queued redispatch of $workflow_path → $req_file" >&2
    ;;

  file-issue)
    title=$(jq -r '.issue_title' <<<"$decision")
    body=$(jq -r '.issue_body' <<<"$decision")
    echo "[fixer] filing issue: $title" >&2
    gh issue create \
      --repo ekr-aibot/sparkflow \
      --title "$title" \
      --body "$body" \
      --label needs-triage
    ;;

  alert-user)
    msg=$(jq -r '.user_message' <<<"$decision")
    echo "[fixer] ALERT for job $job_id: $msg" >&2
    exit 0
    ;;

  *)
    echo "[fixer] unknown action: $action" >&2
    exit 1
    ;;
esac
