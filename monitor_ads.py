#!/usr/bin/env python3
"""
Facebook and Google Ads Sale Monitor for Pakistani Retail Brands.
Tracks active Facebook/Instagram (Meta Ad Library) and Google Ads campaigns,
extracts discount percentages, detects new sale launches, and dispatches alerts
via Telegram, ntfy, and Discord with deduplication.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import monitor

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_BRANDS = BASE_DIR / "brands.json"
DEFAULT_ADS_STATE = BASE_DIR / "state" / "ads_state.json"
DEFAULT_ADS_HISTORY = BASE_DIR / "state" / "ads_history.json"
DEFAULT_SALE_STATE = BASE_DIR / "state" / "sale_state.json"

DISCOUNT_RE = re.compile(
    r"\b(?:(?:up\s*to|flat)\s*)?\d{1,3}(?:\.\d+)?\s*%\s*(?:off|discount)\b"
    r"|\b(?:save|flat)\s+(?:up\s*to\s*)?\d{1,3}(?:\.\d+)?\s*%"
    r"|\b\d{1,2}%\s*off\b",
    re.I,
)
MAX_DISCOUNT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
SALE_KEYWORDS = (
    "sale",
    "discount",
    "off",
    "flat",
    "clearance",
    "save",
    "deal",
    "promo",
    "azadi",
    "eid",
    "winter",
    "summer",
    "festive",
    "special offer",
)


def load_json(path):
    target = Path(path).expanduser()
    if not target.exists():
        return None
    try:
        with target.open(encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return None


def save_json(value, path):
    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(target)


def clean_brand_name(name):
    """Normalize brand name for search queries."""
    clean = re.sub(r"\(.*?\)", "", name).strip()
    clean = re.sub(r"\b(women sale|shoes|clothing|western wear|retail|fashion)\b", "", clean, flags=re.I).strip()
    return clean or name


def extract_discounts(text):
    if not text:
        return []
    matches = DISCOUNT_RE.findall(text)
    cleaned = [re.sub(r"\s+", " ", m).strip().upper() for m in matches]
    return list(dict.fromkeys(cleaned))


def extract_max_discount(discounts, text=""):
    max_val = 0
    pool = list(discounts) + [text]
    for item in pool:
        for m in MAX_DISCOUNT_RE.finditer(item):
            try:
                val = float(m.group(1))
                if 0 < val <= 95 and val > max_val:
                    max_val = int(val) if val.is_integer() else val
            except ValueError:
                continue
    return max_val


def compute_ad_id(platform, text, link=""):
    seed = f"{platform}::{link.strip().lower()}::{text.strip()[:150].lower()}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]


# ---------------------------------------------------------------------------
# Meta Ad Library (Facebook & Instagram)
# ---------------------------------------------------------------------------


def fetch_meta_ad_library_api(brand_name, access_token, country="PK", limit=20):
    """Query Meta Graph API Ad Library Archive."""
    params = {
        "access_token": access_token,
        "search_terms": f'"{brand_name}"',
        "ad_reached_countries": f"['{country}']",
        "ad_type": "ALL",
        "ad_active_status": "ACTIVE",
        "limit": str(limit),
        "fields": "id,page_name,page_id,ad_delivery_start_time,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,publisher_platforms,ad_snapshot_url",
    }
    url = f"https://graph.facebook.com/v19.0/ads_archive?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": "BrandSaleMonitor/2.0"})
    with urlopen(req, timeout=25) as resp:
        data = json.load(resp)

    results = []
    for item in data.get("data", []):
        bodies = item.get("ad_creative_bodies") or []
        titles = item.get("ad_creative_link_titles") or []
        captions = item.get("ad_creative_link_captions") or []
        full_text = " ".join([*bodies, *titles, *captions])
        discounts = extract_discounts(full_text)
        is_sale = bool(discounts) or any(kw in full_text.lower() for kw in SALE_KEYWORDS)

        results.append({
            "id": f"meta_{item.get('id')}",
            "platform": "facebook_ad_library",
            "page_name": item.get("page_name", brand_name),
            "headline": titles[0] if titles else f"{brand_name} Ad",
            "body": (bodies[0] if bodies else full_text)[:300],
            "url": item.get("ad_snapshot_url") or f"https://www.facebook.com/ads/library/?id={item.get('id')}",
            "publisher_platforms": item.get("publisher_platforms") or ["facebook", "instagram"],
            "started_at": item.get("ad_delivery_start_time", ""),
            "discounts": discounts,
            "max_discount": extract_max_discount(discounts, full_text),
            "is_sale": is_sale,
        })
    return results


def search_facebook_ads_google_cse(brand_name, api_key, cse_id):
    """Fallback search using Google Custom Search targeting Facebook Ad Library & brand sale ads."""
    queries = [
        f'site:facebook.com/ads/library "{brand_name}" Pakistan',
        f'site:facebook.com "{brand_name}" ("sale" OR "flat %" OR "up to % off" OR "discount") Pakistan',
    ]
    results = []
    for query in queries:
        params = {
            "key": api_key,
            "cx": cse_id,
            "q": query,
            "num": "5",
            "safe": "active",
        }
        url = f"https://www.googleapis.com/customsearch/v1?{urlencode(params)}"
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            for item in data.get("items", []):
                link = item.get("link", "")
                title = item.get("title", "")
                snippet = item.get("snippet", "")
                full_text = f"{title} {snippet}"
                discounts = extract_discounts(full_text)
                is_sale = bool(discounts) or any(kw in full_text.lower() for kw in SALE_KEYWORDS)
                results.append({
                    "id": compute_ad_id("facebook", full_text, link),
                    "platform": "facebook",
                    "page_name": brand_name,
                    "headline": title,
                    "body": snippet,
                    "url": link,
                    "publisher_platforms": ["facebook", "instagram"],
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "discounts": discounts,
                    "max_discount": extract_max_discount(discounts, full_text),
                    "is_sale": is_sale,
                })
        except Exception as error:
            print(f"  [Notice] Google CSE Facebook search error for {brand_name}: {error}")
    return results


# ---------------------------------------------------------------------------
# Google Ads & Promotions
# ---------------------------------------------------------------------------


def search_google_ads(brand_name, api_key, cse_id):
    """Search Google Custom Search for Google Ads, Shopping, and verified promotional campaigns."""
    queries = [
        f'"{brand_name}" ("sponsored" OR "sale" OR "flat % off" OR "up to % off") Pakistan',
        f'"{brand_name}" ("online sale" OR "clearance sale" OR "flat discount") site:pk',
    ]
    results = []
    for query in queries:
        params = {
            "key": api_key,
            "cx": cse_id,
            "q": query,
            "num": "5",
            "safe": "active",
        }
        url = f"https://www.googleapis.com/customsearch/v1?{urlencode(params)}"
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urlopen(req, timeout=20) as resp:
                data = json.load(resp)
            for item in data.get("items", []):
                link = item.get("link", "")
                title = item.get("title", "")
                snippet = item.get("snippet", "")
                full_text = f"{title} {snippet}"
                discounts = extract_discounts(full_text)
                is_sale = bool(discounts) or any(kw in full_text.lower() for kw in SALE_KEYWORDS)
                results.append({
                    "id": compute_ad_id("google_ads", full_text, link),
                    "platform": "google_ads",
                    "page_name": brand_name,
                    "headline": title,
                    "body": snippet,
                    "url": link,
                    "publisher_platforms": ["google_search", "google_shopping"],
                    "started_at": datetime.now(timezone.utc).isoformat(),
                    "discounts": discounts,
                    "max_discount": extract_max_discount(discounts, full_text),
                    "is_sale": is_sale,
                })
        except Exception as error:
            print(f"  [Notice] Google Ads search error for {brand_name}: {error}")
    return results


# ---------------------------------------------------------------------------
# Core Ad Monitor Runner
# ---------------------------------------------------------------------------


def monitor_ads_for_brand(brand, meta_token="", google_api_key="", google_cse_id=""):
    """Collect ads across Facebook and Google for a single brand."""
    raw_name = brand.get("name", "")
    brand_name = clean_brand_name(raw_name)
    fb_ads = []
    google_ads = []

    # 1. Try Meta Ad Library API
    if meta_token:
        try:
            fb_ads = fetch_meta_ad_library_api(brand_name, meta_token)
        except Exception as err:
            print(f"  Meta Ad Library API failed for {brand_name}: {err}. Falling back to Google CSE.")

    # 2. Fallback to Google CSE for Facebook if needed
    if not fb_ads and google_api_key and google_cse_id:
        fb_ads = search_facebook_ads_google_cse(brand_name, google_api_key, google_cse_id)

    # 3. Search Google Ads & Promotions
    if google_api_key and google_cse_id:
        google_ads = search_google_ads(brand_name, google_api_key, google_cse_id)

    # Deduplicate results per platform by ID
    unique_fb = {ad["id"]: ad for ad in fb_ads}.values()
    unique_google = {ad["id"]: ad for ad in google_ads}.values()

    all_ads = list(unique_fb) + list(unique_google)
    sale_ads = [ad for ad in all_ads if ad.get("is_sale")]

    all_discounts = []
    for ad in sale_ads:
        all_discounts.extend(ad.get("discounts", []))
    all_discounts = list(dict.fromkeys(all_discounts))

    max_disc = 0
    if all_discounts:
        max_disc = extract_max_discount(all_discounts)

    return {
        "brand": raw_name,
        "search_name": brand_name,
        "meta_ads_count": len(unique_fb),
        "google_ads_count": len(unique_google),
        "sale_ads_count": len(sale_ads),
        "has_sale_ads": len(sale_ads) > 0,
        "discounts": all_discounts,
        "max_discount": max_disc,
        "active_ads": all_ads[:15],
    }


def main():
    parser = argparse.ArgumentParser(description="Monitor Facebook & Google Ads for Pakistani fashion brands.")
    parser.add_argument("--brands", default=str(DEFAULT_BRANDS), help="Path to brands.json")
    parser.add_argument("--state", default=str(DEFAULT_ADS_STATE), help="Path to state/ads_state.json")
    parser.add_argument("--history", default=str(DEFAULT_ADS_HISTORY), help="Path to state/ads_history.json")
    parser.add_argument("--sale-state", default=str(DEFAULT_SALE_STATE), help="Path to state/sale_state.json")
    parser.add_argument("--telegram-config", default="~/.codex/telegram-bridge.json")
    parser.add_argument("--dry-run", action="store_true", help="Run without sending alerts or saving state")
    arguments = parser.parse_args()

    meta_token = os.getenv("META_ACCESS_TOKEN") or os.getenv("FB_ACCESS_TOKEN") or os.getenv("FACEBOOK_ACCESS_TOKEN", "").strip()
    google_api_key = os.getenv("GOOGLE_API_KEY", "").strip()
    google_cse_id = os.getenv("GOOGLE_CSE_ID", "").strip()

    has_credentials = bool(meta_token or (google_api_key and google_cse_id))
    if not has_credentials:
        print("Ad monitoring check: META_ACCESS_TOKEN / FB_ACCESS_TOKEN or GOOGLE_API_KEY + GOOGLE_CSE_ID not set.")
        print("Will proceed with dry-run baseline verification using empty state.")

    brands_path = Path(arguments.brands).expanduser()
    brands_data = load_json(brands_path) or {}
    brands = brands_data.get("brands", [])
    if not brands:
        print(f"No brands found in {brands_path}")
        return

    state_path = Path(arguments.state).expanduser()
    history_path = Path(arguments.history).expanduser()
    sale_state_path = Path(arguments.sale_state).expanduser()

    ads_state = load_json(state_path) or {}
    ads_history = load_json(history_path) or []
    sale_state = load_json(sale_state_path) or {}
    sent_alerts = monitor.load_sent_alerts()

    checked_at = datetime.now(timezone.utc).isoformat()
    new_alerts = []
    statuses = []

    print(f"--- Starting Facebook & Google Ads Monitor ({len(brands)} brands) at {checked_at} ---")

    for brand in brands:
        name = brand.get("name", "")
        if "Brand Tijara" in name:
            continue

        prev_brand_state = ads_state.get(name, {})
        seen_ad_ids = set(prev_brand_state.get("seen_ids", []))
        is_baseline = name not in ads_state

        result = monitor_ads_for_brand(
            brand,
            meta_token=meta_token,
            google_api_key=google_api_key,
            google_cse_id=google_cse_id,
        )

        current_ad_ids = [ad["id"] for ad in result["active_ads"]]
        new_sale_ads = [
            ad for ad in result["active_ads"]
            if ad["is_sale"] and ad["id"] not in seen_ad_ids
        ]

        # Update ads state for this brand
        updated_seen_ids = list(dict.fromkeys(list(seen_ad_ids) + current_ad_ids))[-200:]
        ads_state[name] = {
            "brand": name,
            "meta_ads_count": result["meta_ads_count"],
            "google_ads_count": result["google_ads_count"],
            "sale_ads_count": result["sale_ads_count"],
            "has_sale_ads": result["has_sale_ads"],
            "discounts": result["discounts"],
            "max_discount": result["max_discount"],
            "seen_ids": updated_seen_ids,
            "checked_at": checked_at,
            "top_ads": result["active_ads"][:5],
        }

        # Enrich sale_state.json with ad metadata if brand exists
        if name in sale_state:
            sale_state[name]["ads"] = {
                "active": result["has_sale_ads"],
                "meta_count": result["meta_ads_count"],
                "google_count": result["google_ads_count"],
                "sale_ads_count": result["sale_ads_count"],
                "discounts": result["discounts"],
                "max_discount": result["max_discount"],
                "checked_at": checked_at,
            }

        # Format alerts only if new sale ads were detected and NOT during first baseline run
        if not is_baseline and new_sale_ads:
            for ad in new_sale_ads:
                platform_label = "Facebook & Instagram Ad" if "facebook" in ad["platform"] else "Google Ad Campaign"
                disc_text = f" · {', '.join(ad['discounts'])}" if ad.get("discounts") else ""
                alert_text = (
                    f"📢 {name} {platform_label} Detected{disc_text}\n"
                    f"🏷️ Headline: {ad.get('headline', '')}\n"
                    f"💬 Details: {ad.get('body', '')[:160]}...\n"
                    f"🔗 {ad.get('url', '')}"
                )
                if not monitor.is_duplicate(alert_text, sent_alerts):
                    new_alerts.append(alert_text)
                    ads_history.append({
                        "id": ad["id"],
                        "brand": name,
                        "platform": ad["platform"],
                        "headline": ad["headline"],
                        "discounts": ad["discounts"],
                        "url": ad["url"],
                        "detected_at": checked_at,
                    })

        status_line = (
            f"  {name}: {result['meta_ads_count']} Meta ads, "
            f"{result['google_ads_count']} Google ads "
            f"({len(new_sale_ads)} new sale ad(s) detected)"
        )
        statuses.append(status_line)
        print(status_line)

    if not arguments.dry_run:
        save_json(ads_state, state_path)
        save_json(ads_history[-500:], history_path)
        if sale_state:
            save_json(sale_state, sale_state_path)
        monitor.save_sent_alerts(sent_alerts)

    print(f"\nCompleted ad check for {len(brands)} brands.")

    # Dispatch alerts if new ads detected
    if new_alerts and not arguments.dry_run:
        print(f"\nFound {len(new_alerts)} new ad sale alerts! Dispatching notifications...")
        telegram_res = monitor.send_telegram("\n\n".join(new_alerts), arguments.telegram_config)
        print(f"Telegram: {telegram_res}")

        ntfy_res = monitor.send_ntfy_alerts(new_alerts)
        print(f"ntfy: {ntfy_res}")

        discord_res = monitor.send_discord_alerts(new_alerts)
        print(f"Discord: {discord_res}")
    else:
        print("No new ad sale announcements or changes detected; no notification sent.")


if __name__ == "__main__":
    main()
