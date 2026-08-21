# Pakistani Brand Sale Monitor

Tracks 25 Pakistani fashion and footwear retailers, detects new/changed sales, and sends Telegram alerts. It can run locally or as a free scheduled GitHub Actions job.

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

## How Alerts Work

A Telegram alert is sent when:

- a tracked sale becomes active, or
- the detected title/discounts/products change enough to produce a new fingerprint.

No alert is repeated for an unchanged sale.
