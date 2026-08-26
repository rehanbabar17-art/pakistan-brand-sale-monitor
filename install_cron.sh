#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
marker="# pakistan-sale-monitor"
current="$(crontab -l 2>/dev/null || true)"
current="$(grep -Fv "$marker" <<<"$current" || true)"

entries="0 8,12,16,20 * * * $dir/run_monitor.sh $marker
30 8,12,16,20 * * * $dir/run_ddg_search.sh $marker"

if [[ -n "$current" ]]; then
  printf '%s\n%s\n' "$current" "$entries" | crontab -
else
  printf '%s\n' "$entries" | crontab -
fi
echo "Cron installed:"
echo "  Brand monitor:  08:00, 12:00, 16:00, 20:00 UTC"
echo "  DDG search:     08:30, 12:30, 16:30, 20:30 UTC"
