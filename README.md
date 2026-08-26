# Pakistani Brand Sale Monitor & Link Watcher

Tracks Pakistani retailers, Daraz prices, user-shared pages, and sends alerts through Telegram/email/ntfy. The installable mobile dashboard manages watches and change history.

## Mobile Dashboard

`dashboard/` is an installable PWA (Distill-lite) that connects directly to this repository:

- add or remove product-price watches;
- add or remove shared page-change watches;
- trigger hourly workflows immediately;
- show current values and recent change history;
- install to the Android/iOS home screen.

After pushing to `main`, enable GitHub Pages once:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Run **Deploy Dashboard** from the Actions tab, or push another dashboard change.
4. Open:
   ```text
   https://rehanbabar17-art.github.io/pakistan-brand-sale-monitor/
   ```

In the app, create a fine-grained GitHub token for **only this repository** with:

- **Contents:** Read and write
- **Actions:** Read and write
- A short expiration

Paste it into the app. The token stays in browser local storage and is never committed.

## GitHub Setup

1. Create a new **private** GitHub repository.
2. Push this folder:
   ```bash
   git init
   git add .
   git commit -m "Add Pakistani brand sale monitor"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```
3. Message your Telegram bot once, then get the chat ID from:
   `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
4. In GitHub, open **Settings → Secrets and variables → Actions** and add:
   - `TELEGRAM_BOT_TOKEN`: your bot token
   - `TELEGRAM_CHAT_IDS`: one chat ID, such as `123456789`, or comma-separated IDs
5. Open the **Actions** tab, select **Pakistani Brand Sale Monitor**, then choose **Run workflow** once to initialize.
6. It will then run automatically at **09:00 UTC / 14:00 PKT**.

The workflow commits `state/sale_state.json` after checks, so it remembers previous fingerprints across runs.

## Local Commands

- Manual check: `python3 monitor.py`
- Local daily schedule: `./install_cron.sh`
- Remove local schedule after moving to GitHub: `./remove_local_cron.sh`
- Edit tracked pages: `brands.json`

## Mobile / Termux Setup

The monitor now uses only Python's standard library, so it needs no `pip` packages.

1. Install [Termux](https://f-droid.org/en/packages/com.termux/).
2. Copy or clone this folder to Termux storage.
3. From that folder, run:
   ```bash
   chmod +x setup_mobile.sh run_monitor_mobile.sh
   ./setup_mobile.sh
   ./run_monitor_mobile.sh
   ```

For unattended daily alerts, keep the GitHub Actions schedule enabled; the phone does not need to stay awake. Use `run_monitor_mobile.sh` for on-demand checks from mobile. A failure writes to `logs/monitor.log` and shows an Android notification when Termux:API is installed.

Test Telegram configuration without checking sales:

```bash
TELEGRAM_BOT_TOKEN='your_bot_token' \
TELEGRAM_CHAT_IDS='your_chat_id' \
./run_monitor_mobile.sh --test-telegram
```

For Android sale notifications, install both parts of Termux:API:

```bash
pkg install -y termux-api
```

Also install the **Termux:API** Android app from F-Droid, then allow its permission prompts.

## Product Price Monitoring

`prices.json` tracks product prices separately from full-page changes. The included Daraz product runs hourly through `.github/workflows/price-monitor.yml`. Daraz pages are rendered in headless Chromium and monitored by their `salePrice`, so the crossed-out original price is ignored. The first run saves a baseline; later runs alert only when the selling price changes.

Price changes also send email when these repository secrets are set:

- `SMTP_USER`: Gmail address used to send alerts
- `SMTP_PASSWORD`: Gmail App Password (not your normal Gmail password)
- `PRICE_ALERT_EMAIL`: destination address, such as your Gmail address

Optional secrets:

- `SMTP_HOST`: defaults to `smtp.gmail.com`
- `SMTP_PORT`: defaults to `587`
- `EMAIL_FROM`: defaults to `SMTP_USER`
Price changes also send an Android push through [ntfy](https://ntfy.sh) when these secrets are set:
- `NTFY_TOPIC`: a private topic with at least 8 random characters, such as `daraz-price-9f27c1ab84d0`
- `NTFY_SERVER`: optional; defaults to `https://ntfy.sh`
- `NTFY_TOKEN`: optional; required only for a protected ntfy server/topic
In the ntfy app, subscribe to exactly the same topic. Do not use a guessable name such as `daraz` or `prices`; anyone who knows a public ntfy topic can send notifications to it.

## Shared Link Changes

Add any page to `links.json` to track content changes independently from the sale pages:

```json
{
  "links": [
    {
      "name": "Example page",
      "url": "https://example.com/page"
    }
  ]
}
```

The first check saves a baseline. Later checks send a Telegram/ntfy alert when the title, headings, visible text, page links, discounts, or final URL/redirect change. `shared-link-monitor.yml` checks these links hourly and records changes in `state/link_history.json`.

## Google Sales Search

`google_search.json` searches the web for sale/discount announcements for every tracked brand. It uses the official Google Programmable Search JSON API.

Add these repository secrets:

- `GOOGLE_API_KEY`: Google Cloud API key enabled for Custom Search API
- `GOOGLE_CSE_ID`: Programmable Search Engine ID with **Search the entire web** enabled

The included workflow checks all 25 brands every 6 hours. That is exactly 100 API calls/day at free-tier quota. If you receive quota errors, change its schedule to every 12 hours.

## Discord Notifications

Create a webhook in Discord through **Channel → Edit Channel → Integrations → Webhooks**, then add this repository secret:

- `DISCORD_WEBHOOK_URL`: full Discord webhook URL

Price, shared-page, brand-sale, and Google-search alerts will also post to that Discord channel when the secret is configured.

Optional Discord secrets:

- `DISCORD_USERNAME`: defaults to `Sale Monitor`
- `DISCORD_AVATAR_URL`: custom webhook avatar image

## Google Search Setup

1. In Google Cloud, enable **Custom Search API** and create an API key.
2. At [Programmable Search Engine](https://programmablesearchengine.google.com/), create an engine.
3. Turn on **Search the entire web**.
4. Copy the engine ID into `GOOGLE_CSE_ID`.

The watcher queries:

```text
"Brand Name" ("sale" OR "discount" OR "offer" OR "promotion") Pakistan
```

It records result-link fingerprints in `state/google_search_state.json` and appends changes to `state/google_search_history.json`.

Example brand entry in `brands.json`:

```json
{
  "name": "Khaadi",
  "url": "https://www.khaadi.com/pages/sale"
}
```

## Mobile Dashboard

The dashboard shows all tracked brands, Daraz prices, shared pages, and Google search history. Use **Search sales** for an immediate quota-consuming run.

After deployment, open the GitHub Pages URL in a mobile browser and choose **Add to Home Screen** / **Install app**:

```text
https://rehanbabar17-art.github.io/pakistan-brand-sale-monitor/
```

## How Alerts Work

A Telegram alert is sent when:

- a tracked sale becomes active, or
- the detected title/discounts/products change enough to produce a new fingerprint.

No alert is repeated for an unchanged sale.
