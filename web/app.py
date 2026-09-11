#!/usr/bin/env python3
"""Render web service wrapper: run the brand sale monitor on demand."""
import os
import subprocess
import threading
import time

from flask import Flask, jsonify, request

app = Flask(__name__)

_run_lock = threading.Lock()
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "pakistan-brand-sale-monitor"})


@app.route("/run", methods=["POST", "GET"])
def run_monitor():
    token = os.getenv("APP_TOKEN", "").strip()
    if token:
        provided = request.headers.get("X-App-Token") or request.args.get("token") or ""
        if provided != token:
            return jsonify({"error": "unauthorized"}), 401

    if not _run_lock.acquire(blocking=False):
        return jsonify({"error": "monitor already running"}), 409

    started = time.time()
    try:
        proc = subprocess.run(
            ["bash", "run_monitor.sh"],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            timeout=1800,
        )
        log_lines = (proc.stdout or "") + (proc.stderr or "")
        # log tail to keep the response small
        tail = "\n".join(log_lines.strip().splitlines()[-200:])
        result = {
            "exit_code": proc.returncode,
            "duration_seconds": round(time.time() - started, 1),
            "output": tail,
        }
        status = 200 if proc.returncode == 0 else 500
        return jsonify(result), status
    except subprocess.TimeoutExpired:
        return jsonify({"error": "monitor timed out"}), 504
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": str(exc)}), 500
    finally:
        _run_lock.release()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8080"))
    app.run(host="0.0.0.0", port=port)
