#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  if command -v pkg >/dev/null 2>&1; then
    pkg update -y
    pkg install -y python
  else
    echo "Python 3 is required. Install Termux, then run this script again." >&2
    exit 1
  fi
fi

python3 -m py_compile monitor.py
echo "Mobile setup complete. Run ./run_monitor_mobile.sh"
