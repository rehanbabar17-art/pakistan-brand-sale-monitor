#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi
python3 monitor_ads.py >> logs/ads_monitor.log 2>&1
