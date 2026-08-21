#!/usr/bin/env bash
set -euo pipefail
script_path="$(cd "$(dirname "$0")" && pwd)/run_monitor.sh"
chmod +x "$script_path"
marker="# pakistan-sale-monitor"
entry="0 9 * * * $script_path $marker"
current="$(crontab -l 2>/dev/null || true)"
if grep -Fq "$marker" <<<"$current"; then
  current="$(grep -Fv "$marker" <<<"$current" || true)"
fi
if [[ -n "$current" ]]; then
  printf '%s\n%s\n' "$current" "$entry" | crontab -
else
  printf '%s\n' "$entry" | crontab -
fi
echo "Daily check installed at 09:00 UTC."
