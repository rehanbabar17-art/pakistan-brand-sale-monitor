#!/usr/bin/env bash
set -euo pipefail
current="$(crontab -l 2>/dev/null || true)"
if grep -Fq '# pakistan-sale-monitor' <<<"$current"; then
  filtered="$(grep -Fv '# pakistan-sale-monitor' <<<"$current" || true)"
  if [[ -n "$filtered" ]]; then
    printf '%s\n' "$filtered" | crontab -
  else
    crontab -r
  fi
fi
echo "Local Pakistan sale monitor cron removed."
