#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from ddgs import DDGS

import monitor


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_BRANDS = BASE_DIR / "brands.json"
DEFAULT_STATE = BASE_DIR / "state" / "ddg_search_state.json"
DEFAULT_HISTORY = BASE_DIR / "state" / "ddg_search_history.json"


def load_json(path):
    with Path(path).expanduser().open(encoding="utf-8") as fh:
        return json.load(fh)


def save_json(value, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def result_id(item):
    identity = f"{item.get('href', '')}\n{item.get('title', '')}"
    return hashlib.sha256.identity if False else hashlib.sha256(identity.lower().encode("utf-8")).hexdigest()[:24]


def search_ddg(brand_name, max_results=15):
    """Search DuckDuckGo for recent sale posts (past week)."""
    queries = [
        f'{brand_name} sale discount Pakistan 2026',
    ]
    all_results = []
    ddgs = DDGS()
    for query in queries:
        try:
            results = ddgs.text(query, max_results=max_results, timelimit="w")
            for item in results:
                all_results.append({
                    "title": item.get("title", ""),
                    "href": item.get("href", ""),
                    "body": item.get("body", ""),
                    "source": "Web",
                })
        except Exception as error:
            print(f"  DDG query failed: {query} — {error}")
    # Deduplicate by href
    seen = set()
    unique = []
    for item in all_results:
        key = item["href"].lower()
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def main():
    parser = argparse.ArgumentParser(description="Search DuckDuckGo for recent brand sale announcements (past week).")
    parser.add_argument("--brands", default=str(DEFAULT_BRANDS))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--history", default=str(DEFAULT_HISTORY))
    parser.add_argument("--telegram-config", default="~/.codex/telegram-bridge.json")
    arguments = parser.parse_args()

    brands_path = Path(arguments.brands).expanduser()
    state_path = Path(arguments.state).expanduser()
    history_path = Path(arguments.history).expanduser()
    brands = load_json(brands_path).get("brands", [])
    state = load_json(state_path) if state_path.exists() else {}
    history = load_json(history_path) if history_path.exists() else []
    if not isinstance(state, dict):
        state = {}
    if not isinstance(history, list):
        history = []

    checked_at = datetime.now(timezone.utc).isoformat()
    alerts = []
    statuses = []
    had_error = False

    for brand in brands:
        name = brand["name"]
        state_key = f"ddg::{name}"
        previous = state.get(state_key)
        try:
            results = search_ddg(name)
            seen_ids = previous.get("seen_ids", []) if isinstance(previous, dict) else []
            new_results = [item for item in results if result_id(item) not in seen_ids]
            state[state_key] = {
                "seen_ids": ([*seen_ids, *[result_id(item) for item in new_results]])[-300:],
                "result_count": len(results),
                "new_count": len(new_results),
                "checked_at": checked_at,
            }
            statuses.append(f"{name}: {len(new_results)} new result(s) from DuckDuckGo")

            status = "baseline" if previous is None else ("changed" if new_results else "unchanged")
            announced = [] if previous is None else new_results
            for item in (new_results if previous is not None else results[:5]):
                event = {
                    "id": result_id(item),
                    "source": "duckduckgo",
                    "brand_source": item.get("source", "Web"),
                    "name": name,
                    "url": item["href"],
                    "status": status,
                    "title": item["title"],
                    "snippet": item["body"],
                    "checked_at": checked_at,
                }
                history.append(event)
                if item in announced:
                    src = item.get("source", "Web")
                    alerts.append(
                        f"[{src}] {name} sale update\n{item['title']}\n{item['body']}\n{item['href']}"
                    )
        except Exception as error:
            statuses.append(f"{name}: ERROR — {error}")
            had_error = True

    save_json(state, state_path)
    save_json(history, history_path)
    print(f"DuckDuckGo sales search (past week) — {checked_at}\n" + "\n".join(statuses))

    if alerts:
        telegram_delivery = monitor.send_telegram("\n\n".join(alerts), arguments.telegram_config)
        print(telegram_delivery)
        telegram_match = re.search(r"Telegram delivery: (\d+)/(\d+) chats", telegram_delivery)
        telegram_ok = bool(
            telegram_match
            and int(telegram_match.group(1)) == int(telegram_match.group(2))
            and int(telegram_match.group(2)) > 0
        )

        ntfy_delivery = monitor.send_ntfy_alerts(alerts)
        print(ntfy_delivery)
        ntfy_match = re.search(r"ntfy delivery: (\d+)/(\d+)", ntfy_delivery)
        ntfy_ok = bool(ntfy_match and int(ntfy_match.group(1)) == int(ntfy_match.group(2)) > 0)

        discord_delivery = monitor.send_discord_alerts(alerts)
        print(discord_delivery)
        discord_match = re.search(r"Discord delivery: (\d+)/(\d+)", discord_delivery)
        discord_ok = bool(discord_match and int(discord_match.group(1)) == int(discord_match.group(2)) > 0)

        if not telegram_ok or not ntfy_ok or not discord_ok:
            raise SystemExit("DuckDuckGo search notification delivery did not complete")

    if had_error:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
