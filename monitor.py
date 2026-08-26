#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE_DIR / "brands.json"
DEFAULT_LINKS_CONFIG = BASE_DIR / "links.json"
DEFAULT_STATE = BASE_DIR / "state" / "sale_state.json"
DEFAULT_LINK_HISTORY = BASE_DIR / "state" / "link_history.json"
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


MAX_DISCOUNT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")


def max_discount_percent(discounts):
    best = 0
    for entry in discounts:
        match = MAX_DISCOUNT_RE.search(entry)
        if match:
            value = float(match.group(1))
            if value > best:
                best = value
    return best


def extract_page(page_html, base_url):
    class PageParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.title_parts = []
            self.headings = []
            self.text_parts = []
            self.products = set()
            self.links = set()
            self.skip_depth = 0
            self.in_title = False
            self.heading_tag = None
            self.heading_text = []

        def handle_starttag(self, tag, attributes):
            attributes = dict(attributes)
            if tag in {"script", "style", "noscript"}:
                self.skip_depth += 1
                return
            if tag in {"h1", "h2", "h3"}:
                self.heading_tag = tag
                self.heading_text = []
            if tag == "a" and "/products/" in attributes.get("href", "").lower():
                self.products.add(normalize_url(attributes["href"]))
            href = attributes.get("href", "").strip()
            if href and not href.startswith(("mailto:", "tel:", "javascript:", "data:")):
                absolute_url = urljoin(base_url, href).split("#", 1)[0]
                if absolute_url.startswith(("http://", "https://")):
                    self.links.add(absolute_url)
            if tag == "title":
                self.in_title = True

        def handle_endtag(self, tag):
            if tag in {"script", "style", "noscript"}:
                self.skip_depth = max(0, self.skip_depth - 1)
                return
            if tag == "title":
                self.in_title = False
            if tag == self.heading_tag:
                heading = " ".join("".join(self.heading_text).split())
                if heading:
                    self.headings.append(heading)
                self.heading_tag = None
                self.heading_text = []

        def handle_data(self, data):
            if self.skip_depth:
                return
            if self.in_title:
                self.title_parts.append(data)
            elif self.heading_tag:
                self.heading_text.append(data)
            self.text_parts.append(data)

    parser = PageParser()
    parser.feed(page_html)
    parser.close()
    title = " ".join("".join(parser.title_parts).split())
    visible_text = " ".join(parser.text_parts)
    discounts = sorted(set(DISCOUNT_RE.findall(visible_text)))
    return (
        title,
        parser.headings,
        sorted(parser.products),
        discounts,
        visible_text.lower(),
        sorted(parser.links),
    )


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
def make_content_fingerprint(title, headings, links, discounts, lower_text):
    digest = hashlib.sha256()
    values = (
        title,
        "\n".join(headings),
        "\n".join(links),
        "\n".join(discounts),
        " ".join(lower_text.split()),
    )
    for value in values:
        digest.update(value.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def fetch_page(url):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; PakistanSaleMonitor/1.0)",
            "Accept-Language": "en-US,en;q=0.9,ur;q=0.8",
        },
    )
    with urlopen(request, timeout=30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        page_html = response.read().decode(charset, errors="replace")
        final_url = response.geturl()
    return page_html, final_url
def check_brand(brand_url):
    page_html, final_url = fetch_page(brand_url)

    title, headings, products, discounts, lower_text, links = extract_page(page_html, brand_url)
    active = "sale" in brand_url.lower() or any(word in lower_text for word in SALE_WORDS)
    fingerprint = make_fingerprint(title, headings, products, discounts)
    content_fingerprint = make_content_fingerprint(title, headings, links, discounts, lower_text)
    summary = title.strip() or "Active sale page"
    if discounts:
        summary += f" — {', '.join(clean_discounts(discounts))}"
    return {
        "active": active,
        "fingerprint": fingerprint,
        "content_fingerprint": content_fingerprint,
        "title": title,
        "summary": summary[:600],
        "product_count": len(products),
        "link_count": len(links),
        "heading_count": len(headings),
        "text_length": len(lower_text),
        "discounts": discounts,
    }, final_url
def extract_product_price(page_html):
    patterns = (
        re.compile(r'pdt_price(?:\\+)?"\s*:\s*(?:\\+)?"([^"\\]+)', re.I),
        re.compile(r'itemprop=["\']price["\'][^>]*content=["\']([^"\']+)', re.I),
        re.compile(r'"price"\s*:\s*"?([0-9][0-9,.]*)', re.I),
    )
    price_text = ""
    for pattern in patterns:
        match = pattern.search(page_html)
        if match:
            price_text = " ".join(match.group(1).split())
            break
    if not price_text:
        raise ValueError("Product price was not found")
    number_match = re.search(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?", price_text)
    if not number_match:
        raise ValueError(f"Invalid product price: {price_text}")
    digits = number_match.group().replace(",", "")
    try:
        price_value = float(digits)
    except ValueError as error:
        raise ValueError(f"Invalid product price: {price_text}") from error
    og_title = re.search(r'<meta\s+property="og:title"\s+content=["\']([^"\']+)', page_html, re.I)
    title_tag = re.search(r'<title>([^<]+)</title>', page_html, re.I)
    title = (og_title.group(1) if og_title else title_tag.group(1) if title_tag else "Product").strip()
    return title, price_text, price_value
def check_price(url):
    page_html, final_url = fetch_page(url)
    host = urlsplit(final_url).netloc.lower()
    if host == "s.daraz.pk":
        product_match = re.search(
            r"https://www\.daraz\.pk/products/[^\"'<> ]+",
            page_html,
            re.I,
        )
        if not product_match:
            raise ValueError("Could not resolve Daraz share link")
        final_url = product_match.group().split("?", 1)[0]
        page_html, final_url = fetch_page(final_url)
    title, price_text, price_value = extract_product_price(page_html)
    title = title.removesuffix(" | Daraz.pk")
    return {
        "active": False,
        "fingerprint": f"price:{price_value:.2f}",
        "title": title,
        "summary": f"Current price: {price_text}",
        "price": price_text,
        "price_value": price_value,
        "discounts": [],
    }, final_url
def describe_link_changes(previous, current, requested_url, final_url):
    if not previous:
        return ["Baseline saved"]
    changes = []
    if previous.get("title") != current.get("title"):
        changes.append(f"Title changed to: {current.get('title') or '(none)'}")
    if previous.get("heading_count") != current.get("heading_count"):
        changes.append(f"Headings {previous.get('heading_count', 0)} → {current.get('heading_count', 0)}")
    if previous.get("link_count") != current.get("link_count"):
        changes.append(f"Links {previous.get('link_count', 0)} → {current.get('link_count', 0)}")
    if previous.get("text_length") != current.get("text_length"):
        changes.append(f"Text length {previous.get('text_length', 0)} → {current.get('text_length', 0)}")
    if previous.get("discounts") != current.get("discounts"):
        discounts = ", ".join(current.get("discounts") or []) or "(none)"
        changes.append(f"Discounts now: {discounts}")
    if previous.get("url") != final_url:
        changes.append(f"Final URL changed to: {final_url}")
    if requested_url != final_url and previous.get("url") == final_url:
        changes.append(f"Redirects to: {final_url}")
    return changes or ["Page content changed"]
def save_history(history_path, events):
    history_path = Path(history_path)
    existing = load_json(history_path) if history_path.exists() else []
    if not isinstance(existing, list):
        existing = []
    save_state(existing + events, history_path)
def send_ntfy_alerts(alerts):
    topic = os.getenv("NTFY_TOPIC", "").strip()
    if not topic:
        return "ntfy skipped: NTFY_TOPIC is missing."
    server = os.getenv("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    token = os.getenv("NTFY_TOKEN", "").strip()
    delivered = 0
    for alert in alerts:
        lines = alert.splitlines()
        title = lines[0].strip()
        body = "\n".join(lines[1:]) or alert
        tag = "bell"
        if "top deal" in title.lower():
            tag = "fire"
        elif "sale update" in title.lower():
            tag = "tada"
        elif "price" in title.lower():
            tag = "money_with_wings"
        elif "link changed" in title.lower():
            tag = "link"
        safe_title = title.encode("latin-1", errors="replace").decode("latin-1")
        request = Request(
            f"{server}/{topic}",
            data=body.encode("utf-8"),
            headers={
                "Title": safe_title,
                "Tags": tag,
                "Priority": "high",
            },
        )
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urlopen(request, timeout=30) as response:
                delivered += int(200 <= response.status < 300)
        except HTTPError as error:
            raise RuntimeError(f"ntfy returned HTTP {error.code}") from error
    return f"ntfy delivery: {delivered}/{len(alerts)}."


def send_discord_alerts(alerts):
    webhook_url = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    if not webhook_url:
        return "Discord skipped: DISCORD_WEBHOOK_URL is missing."
    if not webhook_url.startswith(("https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/")):
        raise ValueError("DISCORD_WEBHOOK_URL is not a valid Discord webhook URL")

    delivered = 0
    for alert in alerts:
        lines = alert.splitlines()
        title = lines[0].replace("🛍️", "").replace("🔗", "").replace("💰", "").strip()
        description = "\n".join(lines[1:]) or alert
        payload = {
            "username": os.getenv("DISCORD_USERNAME", "Sale Monitor"),
            "embeds": [{
                "title": title[:256],
                "description": description[:4096],
                "color": 3447003,
            }],
        }
        avatar = os.getenv("DISCORD_AVATAR_URL", "").strip()
        if avatar:
            payload["avatar_url"] = avatar
        request = Request(
            webhook_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=30) as response:
                delivered += int(200 <= response.status < 300)
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"Discord returned HTTP {error.code}: {detail}") from error
    return f"Discord delivery: {delivered}/{len(alerts)}."


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
            request = Request(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data=json.dumps(
                    {"chat_id": chat_id, "text": message, "disable_web_page_preview": True}
                ).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            try:
                with urlopen(request, timeout=20) as response:
                    delivered += int(200 <= response.status < 300)
            except HTTPError as error:
                errors.append(f"{chat_id}: HTTP {error.code}")
        result = f"Telegram delivery: {delivered}/{len(chat_ids)} chats."
        return result + (f" Errors: {'; '.join(errors)}" if errors else "")
    except Exception as error:
        return f"Telegram delivery failed: {error}"


def send_android_notifications(alerts):
    command = shutil.which("termux-notification")
    if not command:
        return "Android notifications skipped: termux-notification not found."
    delivered = 0
    errors = []
    for index, message in enumerate(alerts):
        lines = message.splitlines()
        title = lines[0].replace("🛍️", "").replace("🔗", "").replace("💰", "").strip() if lines else "Monitor update"
        if "has a sale update" in title:
            title = title.replace("has a sale update", "").strip() + " sale update"
        content = "\n".join(lines[1:]) or "A tracked sale was updated."
        try:
            result = subprocess.run(
                [
                    command,
                    "-t",
                    title,
                    "-c",
                    content,
                    "--id",
                    str(730000 + index),
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=10,
                check=False,
            )
            delivered += int(result.returncode == 0)
            if result.returncode != 0:
                errors.append(result.stderr.strip())
        except Exception as error:
            errors.append(str(error))
    result = f"Android notifications: {delivered}/{len(alerts)}."
    return result + (f" Errors: {'; '.join(errors)}" if errors else "")


def run(config_path, state_path, telegram_config, force_alert=False, links_config=DEFAULT_LINKS_CONFIG):
    config = load_json(config_path)
    watched_links = load_json(links_config) if Path(links_config).expanduser().exists() else {"links": []}
    old_state = load_json(state_path) if state_path.exists() else {}
    new_state = dict(old_state)
    checked_at = datetime.now(timezone.utc).isoformat()
    alerts = []
    statuses = []
    link_events = []

    for brand in config["brands"]:
        name = brand["name"]
        previous = old_state.get(name)
        try:
            result, final_url = check_brand(brand["url"])
            new_state[name] = {**result, "url": final_url, "checked_at": checked_at}
            status = "ACTIVE" if result["active"] else "inactive"
            statuses.append(f"{name}: {status} ({result['summary']})")

            changed = bool(previous and result["fingerprint"] != previous.get("fingerprint"))
            newly_active = result["active"] and not (previous or {}).get("active")
            if previous is not None and result["active"] and (changed or force_alert):
                disc = max_discount_percent(result.get("discounts", []))
                if disc >= 60:
                    alerts.insert(0, f"TOP DEAL: {name} — {disc:.0f}% off!\n{result['summary']}\n{final_url}")
                else:
                    alerts.append(f"{name} has a sale update\n{result['summary']}\n{final_url}")
        except Exception as error:
            statuses.append(f"{name}: ERROR — {error}")
    for link in watched_links.get("links", []):
        url = link["url"]
        name = link.get("name") or urlsplit(url).netloc.removeprefix("www.")
        state_key = f"link::{name}"
        previous = old_state.get(state_key)
        try:
            if link.get("mode") == "price":
                result, final_url = check_price(url)
            else:
                result, final_url = check_brand(url)
            new_state[state_key] = {**result, "url": final_url, "checked_at": checked_at}
            if link.get("mode") == "price":
                changed = bool(previous and result["fingerprint"] != previous.get("fingerprint"))
                statuses.append(f"{name} price: {result['price']} ({'CHANGED' if changed else 'unchanged'})")
                if changed or force_alert:
                    old_price = previous.get("price") if previous else None
                    change = f"Price changed: {old_price} → {result['price']}" if old_price else f"Baseline price: {result['price']}"
                    alerts.append(f"{name} price update\n{change}\n{final_url}")
            else:
                changes = describe_link_changes(previous, result, url, final_url)
                changed = bool(previous and result["content_fingerprint"] != previous.get("content_fingerprint"))
                statuses.append(f"{name} link: {'CHANGED' if changed else 'unchanged'}")
                event_status = "changed" if previous and changed else ("baseline" if not previous else "unchanged")
                if previous is None or changed:
                    link_events.append({
                        "id": hashlib.sha256(f"{state_key}:{checked_at}".encode()).hexdigest()[:16],
                        "source": "link",
                        "mode": "price" if link.get("mode") == "price" else "content",
                        "name": name,
                        "url": final_url,
                        "status": event_status,
                        "summary": result.get("summary", ""),
                        "changes": changes,
                        "checked_at": checked_at,
                    })
                if changed or force_alert:
                    alerts.append(f"{name} link changed\n" + "\n".join(changes) + f"\n{final_url}")
        except Exception as error:
            statuses.append(f"{name} link: ERROR — {error}")

    save_state(new_state, state_path)
    if link_events:
        save_history(DEFAULT_LINK_HISTORY, link_events)
    print(f"Pakistan sale monitor — {checked_at}\n" + "\n".join(statuses))
    if alerts:
        print(send_telegram("\n\n".join(alerts), telegram_config))
        print(send_android_notifications(alerts))
        try:
            print(send_ntfy_alerts(alerts))
            ntfy_ok = True
        except Exception as error:
            print(f"ntfy delivery failed: {error}")
            ntfy_ok = False
        try:
            print(send_discord_alerts(alerts))
            discord_ok = True
        except Exception as error:
            print(f"Discord delivery failed: {error}")
            discord_ok = False
        if not ntfy_ok:
            raise SystemExit("ntfy delivery did not complete")
        if not discord_ok:
            raise SystemExit("Discord delivery did not complete")


def main():
    parser = argparse.ArgumentParser(description="Check Pakistani brand pages for sales.")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--links-config", default=str(DEFAULT_LINKS_CONFIG))
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--telegram-config", default="~/.codex/telegram-bridge.json")
    parser.add_argument("--force-alert", action="store_true")
    parser.add_argument("--test-telegram", action="store_true")
    arguments = parser.parse_args()
    if arguments.test_telegram:
        print(send_telegram(
            "✅ Pakistan sale monitor Telegram test",
            arguments.telegram_config,
        ))
        return
    run(
        arguments.config,
        Path(arguments.state).expanduser(),
        arguments.telegram_config,
        arguments.force_alert,
        Path(arguments.links_config).expanduser(),
    )


if __name__ == "__main__":
    main()
