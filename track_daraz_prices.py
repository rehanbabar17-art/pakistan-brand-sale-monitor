#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import smtplib
import ssl
import time
from datetime import datetime, timezone
from pathlib import Path
from email.message import EmailMessage
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from playwright.sync_api import sync_playwright

import monitor


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "prices.json"
DEFAULT_STATE = BASE_DIR / "state" / "daraz_price_state.json"
DEFAULT_HISTORY = BASE_DIR / "state" / "daraz_price_history.json"


def load_json(path):
    with Path(path).expanduser().open(encoding="utf-8") as file_handle:
        return json.load(file_handle)


def save_state(state, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def send_email_alerts(alerts):
    host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))
    username = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    recipients = [
        recipient.strip()
        for recipient in os.getenv("PRICE_ALERT_EMAIL", "").split(",")
        if recipient.strip()
    ]
    if not username or not password or not recipients:
        return "Email skipped: SMTP_USER, SMTP_PASSWORD, or PRICE_ALERT_EMAIL is missing."

    sender = os.getenv("EMAIL_FROM", username).strip() or username
    message = EmailMessage()
    message["Subject"] = f"Daraz price alert — {len(alerts)} change" + ("s" if len(alerts) != 1 else "")
    message["From"] = sender
    message["To"] = ", ".join(recipients)
    message.set_content("\n\n".join(alerts))

    with smtplib.SMTP(host, port, timeout=30) as server:
        server.starttls(context=ssl.create_default_context())
        server.login(username, password)
        server.send_message(message)
    return f"Email delivery: {len(recipients)} recipient(s)."
def send_ntfy_alerts(alerts):
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic:
        return "ntfy skipped: NTFY_TOPIC is missing."
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", topic):
        raise ValueError("NTFY_TOPIC must be 8-64 letters, numbers, underscores, or dashes")
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    token = os.getenv("NTFY_TOKEN", "").strip()
    delivered = 0
    for alert in alerts:
        lines = alert.splitlines()
        title = lines[0].replace("💰", "").strip() if lines else "Daraz price alert"
        body = "\n".join(lines[1:]) or alert
        click_url = body.splitlines()[-1] if body.splitlines()[-1].startswith(("http://", "https://")) else None
        payload = {
            "topic": topic,
            "title": title,
            "message": body,
            "tags": ["money_with_wings"],
            "priority": "high",
        }
        if click_url:
            payload["click"] = click_url
        request = Request(
            f"{server}/",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urlopen(request, timeout=30) as response:
                delivered += int(200 <= response.status < 300)
        except HTTPError as error:
            raise RuntimeError(f"ntfy returned HTTP {error.code}") from error
    if delivered != len(alerts):
        raise RuntimeError(f"ntfy delivery incomplete: {delivered}/{len(alerts)}")
    return f"ntfy delivery: {delivered} notification(s)."


def find_sale_prices(payload):
    candidates = []

    def walk(value):
        if isinstance(value, dict):
            sale_price = value.get("salePrice")
            if isinstance(sale_price, dict) and sale_price.get("value") is not None:
                candidates.append(
                    {
                        "price": sale_price.get("text") or f"Rs. {sale_price['value']}",
                        "price_value": float(sale_price["value"]),
                        "original_price": (value.get("originalPrice") or {}).get("text"),
                        "original_price_value": (value.get("originalPrice") or {}).get("value"),
                    }
                )
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(payload)
    unique = []
    seen = set()
    for candidate in candidates:
        key = candidate["price_value"]
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    if not unique:
        raise ValueError("Daraz salePrice was not found")
    if len(unique) > 1:
        raise ValueError(f"Multiple Daraz sale prices found: {unique}")
    return unique[0]


def fetch_rendered_price(page, url):
    captures = []

    def on_response(response):
        try:
            if "mtop.global.detail.web.getdetailinfo" in response.url:
                captures.append(response.text())
        except Exception:
            pass

    page.on("response", on_response)
    page.goto(url, timeout=60000, wait_until="domcontentloaded")
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline and not captures:
        page.wait_for_timeout(250)
    valid_captures = [capture for capture in captures if 'salePrice' in capture]
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not valid_captures:
        page.wait_for_timeout(250)
        valid_captures = [capture for capture in captures if 'salePrice' in capture]
    if not valid_captures:
        preview = captures[-1][:300] if captures else "(none)"
        raise RuntimeError(f"Successful Daraz detail API response was not received: {preview}")

    outer_payload = json.loads(valid_captures[-1])
    module_payload = outer_payload["data"]["module"]
    if isinstance(module_payload, str):
        module_payload = json.loads(module_payload)
    result = find_sale_prices(module_payload)
    title = " ".join(page.title().split()).removesuffix(" | Daraz.pk")
    result["title"] = title
    result["fingerprint"] = hashlib.sha256(str(result["price_value"]).encode()).hexdigest()
    return result, page.url


def main():
    parser = argparse.ArgumentParser(description="Track rendered Daraz sale prices.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--history", default=str(DEFAULT_HISTORY))
    parser.add_argument("--telegram-config", default="~/.codex/telegram-bridge.json")
    arguments = parser.parse_args()

    config_path = Path(arguments.config).expanduser()
    state_path = Path(arguments.state).expanduser()
    links = load_json(config_path).get("links", [])
    old_state = load_json(state_path) if state_path.exists() else {}
    new_state = dict(old_state)
    checked_at = datetime.now(timezone.utc).isoformat()
    alerts = []
    statuses = []
    events = []
    had_error = False

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            locale="en-PK",
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/125 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        try:
            page = context.new_page()
            for link in links:
                name = link.get("name") or link["url"]
                state_key = f"daraz::{name}"
                previous = old_state.get(state_key)
                try:
                    result, final_url = fetch_rendered_price(page, link["url"])
                    new_state[state_key] = {**result, "url": final_url, "checked_at": checked_at}
                    changed = bool(previous and result["fingerprint"] != previous.get("fingerprint"))
                    statuses.append(f"{name}: {result['price']} ({'CHANGED' if changed else 'unchanged'})")
                    status = "changed" if previous and changed else ("baseline" if not previous else "unchanged")
                    if previous is None or changed:
                        events.append({
                            "id": hashlib.sha256(f"{state_key}:{checked_at}".encode()).hexdigest()[:16],
                            "source": "price",
                            "mode": "price",
                            "name": name,
                            "url": final_url,
                            "status": status,
                            "previous_price": previous.get("price") if previous else None,
                            "price": result["price"],
                            "original_price": result.get("original_price"),
                            "checked_at": checked_at,
                        })
                    if changed:
                        alerts.append(
                            f"💰 {name} price changed\n"
                            f"Price changed: {previous.get('price')} → {result['price']}\n{final_url}"
                        )
                    elif not previous:
                        statuses[-1] += " — baseline saved"
                except Exception as error:
                    statuses.append(f"{name}: ERROR — {error}")
                    had_error = True
        finally:
            browser.close()

    save_state(new_state, state_path)
    if events:
        history_path = Path(arguments.history).expanduser()
        existing = load_json(history_path) if history_path.exists() else []
        if not isinstance(existing, list):
            existing = []
        save_state(existing + events, history_path)
    print(f"Daraz price monitor — {checked_at}\n" + "\n".join(statuses))
    if alerts:
        delivery = monitor.send_telegram("\n\n".join(alerts), arguments.telegram_config)
        print(delivery)
        match = re.search(r"Telegram delivery: (\d+)/(\d+) chats", delivery)
        telegram_ok = bool(
            match
            and int(match.group(1)) == int(match.group(2))
            and int(match.group(2)) > 0
        )
        print(send_email_alerts(alerts))
        try:
            print(send_ntfy_alerts(alerts))
            ntfy_ok = True
        except Exception as error:
            print(f"ntfy delivery failed: {error}")
            ntfy_ok = False
        try:
            print(monitor.send_discord_alerts(alerts))
            discord_ok = True
        except Exception as error:
            print(f"Discord delivery failed: {error}")
            discord_ok = False
        if not telegram_ok:
            raise SystemExit("Telegram delivery did not complete")
        if not ntfy_ok:
            raise SystemExit("ntfy delivery did not complete")
        if not discord_ok:
            raise SystemExit("Discord delivery did not complete")

    if had_error:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
