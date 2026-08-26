#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p logs

if output="$(python3 monitor.py "$@" 2>&1)"; then
  printf '%s\n' "$output" >> logs/monitor.log
else
  status=$?
  printf '%s\n' "$output" >> logs/monitor.log
  if command -v termux-notification >/dev/null 2>&1; then
    termux-notification -t "Sale monitor failed" -c "${output##*$'\n'}" --id 7311 || true
  fi
  exit "$status"
fi
