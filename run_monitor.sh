#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
if [[ -f .env ]]; then
  set -a
  source .env
  set +a
fi
python3 monitor.py 2>&1 | tee -a logs/monitor.log || true
python3 monitor_ads.py --brands brands_ads.json 2>&1 | tee -a logs/monitor.log

