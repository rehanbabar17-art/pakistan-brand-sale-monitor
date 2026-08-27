#!/usr/bin/env bash
# Run from cron-job.org? No - this is a helper to trigger GitHub Actions via API.
# Use the curl command shown in the file as the "HTTP Request" in cron-job.org.
set -euo pipefail

TOKEN="${GITHUB_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  echo "Set GITHUB_TOKEN (a GitHub PAT with 'workflow' scope) to use this script."
  exit 1
fi

curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/rehanbabar17-art/pakistan-brand-sale-monitor/actions/workflows/339350213/dispatches" \
  -d '{"ref":"main"}'
