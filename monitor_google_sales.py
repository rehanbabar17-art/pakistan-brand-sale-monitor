#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import monitor


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_BRANDS = BASE_DIR / "brands.json"
DEFAULT_STATE = BASE_DIR / "state" / "google_search_state.json"
DEFAULT_HISTORY = BASE_DIR / "state" / "google_search_history.json"


def load_json(path):
    with Path(path).expanduser().open(encoding="utf-8") as file_handle:
        return json.load(file_handle)


def save_json(value, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def search_web(brand_name, credentials):
    query = f'"{brand_name}" ("sale" OR "discount" OR "offer" OR "promotion") Pakistan'
    parameters = {
        "key": credentials["api_key"],
        "cx": credentials["cse_id"],
        "q": query,
        "num": "10",
        "safe": "active",
    }
    request = Request(f"https://www.googleapis.com/customsearch/v1?{urlencode(parameters)}")
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Custom Search HTTP {error.code}: {detail[:500]}") from error
    return [
        {
            "title": item.get("title", ""),
            "link": item.get("link", ""),
            "snippet": item.get("snippet", ""),
            "display_link": item.get("displayLink", ""),
        }
        for item in payload.get("items", [])
        if item.get("link")
    ]


def search_facebook(brand_name, credentials):
    query = f'site:facebook.com "{brand_name}" ("sale" OR "discount" OR "offer" OR "% off") Pakistan'
    parameters = {
        "key": credentials["api_key"],
        "cx": credentials["cse_id"],
        "q": query,
        "num": "10",
        "safe": "active",
    }
    request = Request(f"https://www.googleapis.com/customsearch/v1?{urlencode(parameters)}")
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Google Custom Search HTTP {error.code}: {detail[:500]}") from error
    return [
        {
            "title": item.get("title", ""),
            "link": item.get("link", ""),
            "snippet": item.get("snippet", ""),
            "display_link": item.get("displayLink", ""),
        }
        for item in payload.get("items", [])
        if item.get("link") and "facebook.com" in item.get("link", "")
    ]


def result_id(item):
    identity = f"{item.get('link', '')}\n{item.get('title', '')}"
    return hashlib.sha256(identity.lower().encode("utf-8")).hexdigest()[:24]


def main():
    parser = argparse.ArgumentParser(description="Search the web for tracked-brand sale announcements.")
    parser.add_argument("--brands", default=str(DEFAULT_BRANDS))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--history", default=str(DEFAULT_HISTORY))
    parser.add_argument("--telegram-config", default="~/.codex/telegram-bridge.json")
    arguments = parser.parse_args()

    api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    cse_id = os.getenv("GOOGLE_CSE_ID", "").strip()
    if not api_key or not cse_id:
        print("Google sales search skipped: GOOGLE_API_KEY or GOOGLE_CSE_ID is missing.")
        return

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
        state_key = f"google::{name}"
        previous = state.get(state_key)
        try:
            results = search_web(name, {"api_key": api_key, "cse_id": cse_id})
            fb_key = f"facebook::{name}"
            fb_previous = state.get(fb_key)
            fb_results = search_facebook(name, {"api_key": api_key, "cse_id": cse_id})
            all_results = results + fb_results
            seen_ids = previous.get("seen_ids", []) if isinstance(previous, dict) else []
            fb_seen_ids = fb_previous.get("seen_ids", []) if isinstance(fb_previous, dict) else []
            new_web = [item for item in results if result_id(item) not in seen_ids]
            new_fb = [item for item in fb_results if result_id(item) not in fb_seen_ids]
            new_results = new_web + new_fb
            state[state_key] = {
                "query": f'"{name}" sale announcements',
                "seen_ids": ([*seen_ids, *[result_id(item) for item in new_web]])[-300:],
                "result_count": len(results),
                "checked_at": checked_at,
            }
            state[fb_key] = {
                "query": f'"{name}" Facebook sale posts',
                "seen_ids": ([*fb_seen_ids, *[result_id(item) for item in new_fb]])[-300:],
                "result_count": len(fb_results),
                "checked_at": checked_at,
            }
            statuses.append(f"{name}: {len(new_web)} web + {len(new_fb)} Facebook new result(s)")

            status = "baseline" if previous is None else ("changed" if new_results else "unchanged")
            events = []
            announced_results = [] if previous is None else new_results
            for item in (new_results if previous is not None else results[:5]):
                event_id = result_id(item)
                event = {
                    "id": event_id,
                    "source": "google_search",
                    "name": name,
                    "url": item["link"],
                    "status": status,
                    "title": item["title"],
                    "snippet": item["snippet"],
                    "checked_at": checked_at,
                }
                events.append(event)
                if item in announced_results:
                    source = "Facebook" if "facebook.com" in item.get("link", "") else "Web"
                    alerts.append(
                        f"🔎 {name} {source} update\n{item['title']}\n{item['snippet']}\n{item['link']}"
                    )
            history.extend(events)
        except Exception as error:
            statuses.append(f"{name}: ERROR — {error}")
            had_error = True

    save_json(state, state_path)
    save_json(history, history_path)
    print(f"Google sales search — {checked_at}\n" + "\n".join(statuses))

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
            raise SystemExit("Google search notification delivery did not complete")

    if had_error:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
