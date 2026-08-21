#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import requests
from bs4 import BeautifulSoup


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "brands.json"
DEFAULT_STATE = BASE_DIR / "state" / "sale_state.json"
SALE_WORDS = ("sale", "discount", "% off", "up to", "reduced price")
DISCOUNT_RE = re.compile(r"\b(?:up\s*to\s*)?\d{1,3}(?:\.\d+)?\s*%\s*(?:off|discount)\b", re.I)


def load_json(path):
    with Path(path).expanduser().open(encoding="utf-8") as file_handle:
        return json.load(file_handle)


def save_state(state, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def normalize_url(url):
    parts = urlsplit(url)
    return f"{parts.netloc.lower()}{parts.path.rstrip('/').lower()}"


def clean_discounts(discounts):
    cleaned = [re.sub(r"\s+", " ", item).strip().capitalize() for item in discounts]
    return list(dict.fromkeys(cleaned))


def extract_page(page_html):
    soup = BeautifulSoup(page_html, "html.parser")
    for element in soup(["script", "style", "noscript"]):
        element.decompose()

    title = " ".join(soup.title.stripped_strings) if soup.title else ""
    headings = []
    for level in ("h1", "h2", "h3"):
        headings.extend(" ".join(item.stripped_strings) for item in soup.find_all(level))

    products = set()
    for link in soup.find_all("a", href=True):
        if "/products/" not in link["href"].lower():
            continue
        product_path = normalize_url(link["href"])
        label = " ".join(link.stripped_strings)
        if product_path or label:
            products.add(product_path or label)

    visible_text = " ".join(soup.stripped_strings)
    discounts = sorted(set(DISCOUNT_RE.findall(visible_text)))
    return title, headings, sorted(products), discounts, visible_text.lower()


def make_fingerprint(title, headings, products, discounts):
    relevant_headings = [item for item in headings if any(word in item.lower() for word in SALE_WORDS)]
    payload = json.dumps(
        {
            "title": title,
            "headings": relevant_headings[:80],
            "products": products[:500],
            "discounts": discounts,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def check_brand(session, brand_url):
    response = session.get(brand_url, timeout=30)
    response.raise_for_status()
    title, headings, products, discounts, lower_text = extract_page(response.text)
    active = "sale" in brand_url.lower() or any(word in lower_text for word in SALE_WORDS)
    fingerprint = make_fingerprint(title, headings, products, discounts)
    summary = title.strip() or "Active sale page"
    if discounts:
        summary += f" — {', '.join(clean_discounts(discounts))}"
    return {
        "active": active,
        "fingerprint": fingerprint,
        "title": title,
        "summary": summary[:600],
        "product_count": len(products),
    }, str(response.url)


def telegram_settings(telegram_config):
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    raw_chat_ids = os.getenv("TELEGRAM_CHAT_IDS")

    if not token or not raw_chat_ids:
        config = load_json(telegram_config) if Path(telegram_config).expanduser().exists() else {}
        token = token or config.get("botToken")
        raw_chat_ids = raw_chat_ids or json.dumps(config.get("chatIds") or [])

    try:
        parsed = json.loads(raw_chat_ids)
    except (json.JSONDecodeError, TypeError):
        parsed = raw_chat_ids
    if isinstance(parsed, list):
        chat_ids = [str(item).strip() for item in parsed if str(item).strip()]
    else:
        chat_ids = [item.strip() for item in str(parsed).split(",") if item.strip()]
    return token, chat_ids


def send_telegram(message, telegram_config):
    try:
        token, chat_ids = telegram_settings(telegram_config)
        if not token or not chat_ids:
            return "Telegram alert skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_IDS is missing."

        delivered = 0
        errors = []
        for chat_id in chat_ids:
            response = requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": message, "disable_web_page_preview": True},
                timeout=20,
            )
            delivered += int(response.ok)
            if not response.ok:
                errors.append(f"{chat_id}: HTTP {response.status_code}")
        result = f"Telegram delivery: {delivered}/{len(chat_ids)} chats."
        return result + (f" Errors: {'; '.join(errors)}" if errors else "")
    except Exception as error:
        return f"Telegram delivery failed: {error}"


def run(config_path, state_path, telegram_config, force_alert=False):
    config = load_json(config_path)
    old_state = load_json(state_path) if state_path.exists() else {}
    new_state = dict(old_state)
    checked_at = datetime.now(timezone.utc).isoformat()
    alerts = []
    statuses = []

    with requests.Session() as session:
        session.headers.update({
            "User-Agent": "Mozilla/5.0 (compatible; PakistanSaleMonitor/1.0)",
            "Accept-Language": "en-US,en;q=0.9,ur;q=0.8",
        })
        for brand in config["brands"]:
            name = brand["name"]
            previous = old_state.get(name)
            try:
                result, final_url = check_brand(session, brand["url"])
                new_state[name] = {**result, "url": final_url, "checked_at": checked_at}
                status = "ACTIVE" if result["active"] else "inactive"
                statuses.append(f"{name}: {status} ({result['summary']})")

                changed = bool(previous and result["fingerprint"] != previous.get("fingerprint"))
                newly_active = result["active"] and not (previous or {}).get("active")
                if result["active"] and (newly_active or changed or force_alert):
                    alerts.append(f"🛍️ {name} has a sale update\n{result['summary']}\n{final_url}")
            except Exception as error:
                statuses.append(f"{name}: ERROR — {error}")

    save_state(new_state, state_path)
    print(f"Pakistan sale monitor — {checked_at}\n" + "\n".join(statuses))
    if alerts:
        print(send_telegram("\n\n".join(alerts), telegram_config))


def main():
    parser = argparse.ArgumentParser(description="Check Pakistani brand pages for sales.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--telegram-config", default="~/.codex/telegram-bridge.json")
    parser.add_argument("--force-alert", action="store_true")
    arguments = parser.parse_args()
    run(arguments.config, Path(arguments.state).expanduser(), arguments.telegram_config, arguments.force_alert)


if __name__ == "__main__":
    main()
