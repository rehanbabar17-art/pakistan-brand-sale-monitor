#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
python3 monitor.py >> logs/monitor.log 2>&1
