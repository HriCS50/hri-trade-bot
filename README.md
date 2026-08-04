# Hri's Trade Data Bot

A Telegram bot for your father: ask trade questions in Hindi (typed in English letters,
e.g. "America ko kitna export karte hain?") and get answers in Hindi (English letters),
sourced from India's official [TIA Portal](https://trade-analytics.commerce.gov.in/public/country)
(Department of Commerce).

## How it works

The TIA Portal is a JavaScript dashboard with no public API, so this project has two parts:

1. **Scraper** (`scraper/`) - a headless-browser script (Playwright) that visits the portal,
   selects each country, and reads off the trade numbers. It runs weekly for free inside
   **GitHub Actions** and commits the results to `data/countries.json`.
2. **Bot** (`worker/`) - a Telegram webhook handler that runs for free on **Cloudflare
   Workers** (no "sleeping" like some free hosts - it wakes instantly). For every question it:
   - Sends your father's question to **Gemini** (Google's AI, free tier) just to figure out
     *which country* he's asking about.
   - Looks up that country's real numbers in `data/countries.json` (never invented).
   - Asks Gemini to phrase those exact numbers as a warm reply in Hinglish (Hindi, English script).

Nothing here costs money: GitHub Actions, Cloudflare Workers, and the Gemini API all have
free tiers that comfortably cover a personal bot like this.

## What you'll need

- A GitHub account (you said you have one)
- A Telegram account
- A Google account (for a free Gemini API key)
- A Cloudflare account (free) - sign up at https://dash.cloudflare.com/sign-up

---

## Step 1 - Create the Telegram bot

1. Open Telegram, search for **@BotFather**, and start a chat.
2. Send `/newbot`, give it a name and a username (must end in "bot", e.g. `hri_trade_bot`).
3. BotFather replies with a **token** like `123456:ABC-def...`. Save it - you'll need it below.

## Step 2 - Get a free Gemini API key

1. Go to https://aistudio.google.com/apikey
2. Sign in, click **Create API key**. No credit card needed for the free tier.
3. Save the key.

## Step 3 - Push this project to GitHub

From this folder:

```bash
git init
git add .
git commit -m "Initial commit"
gh repo create hri-trade-bot --public --source=. --push
# (or create the repo on github.com and follow its "push an existing repo" instructions)
```

## Step 4 - Run the scraper once

1. On GitHub, open your new repo → **Actions** tab → enable workflows if prompted.
2. Click **Scrape TIA data** (left sidebar) → **Run workflow** → **Run workflow**.
3. Wait a few minutes, then check `data/countries.json` in the repo - it should now list
   trade data for ~220 countries instead of just one.

The scraper runs a quick sanity check on the USA record first (it's the portal's
default view, and I already know its real numbers) - if that check fails, the run
stops immediately with a clear "Sanity check FAILED" message in the log instead of
grinding through 220 countries. If you see that message, see **Debugging** below -
this is the one part of the project I couldn't test against the live site myself,
so it may need a small fix.

## Step 5 - Deploy the bot to Cloudflare Workers

```bash
cd worker
npm install
npx wrangler login          # opens a browser to connect your Cloudflare account

npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # make up any random string, e.g. from `openssl rand -hex 20`
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DATA_URL
# when prompted for DATA_URL, paste:
# https://raw.githubusercontent.com/<your-username>/<your-repo>/main/data/countries.json

npx wrangler deploy
```

Wrangler prints your Worker's URL, e.g. `https://hri-trade-bot.<you>.workers.dev`. Save it.

## Step 6 - Point Telegram at your bot

Run this once (replace the placeholders), using the same secret you chose above:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://hri-trade-bot.<you>.workers.dev/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

You should get back `{"ok":true,"result":true,...}`.

## Step 7 - Test it

Open Telegram, find your bot by its username, send `/start`, then try something like
*"UAE ke saath India ka trade balance kya hai?"*

---

## Debugging the scraper

The scraper drives a real browser to select a country and read the numbers off the
page. It already tries two strategies automatically (a click-through filter panel,
then a native dropdown as a fallback) and self-checks against USA's known numbers
before doing a full run - but I couldn't click through the live site myself to
confirm the exact selectors, so this is still the one piece most likely to need a tweak.

If the Action's log shows the sanity check failing (or most/all countries failing):

1. Run it locally with the browser visible so you can watch what happens:
   ```bash
   cd scraper
   npm install
   npx playwright install chromium
   HEADLESS=false COUNTRIES_LIMIT=1 npm run scrape
   ```
2. Compare what you see to the click targets in `scrape.mjs` (`selectCountryAndSubmit`)
   and adjust the selectors to match. Paste me the error and a screenshot from
   `scraper/debug-screenshots/` and I can fix it with you.

## Extending it

- **Commodity data**: the portal also has a "Trade Watch - Commodity" dashboard. The
  same scraper pattern would work - happy to add it if useful.
- **More metrics**: `data/countries.json` already includes rank, growth %, and top
  commodities - the bot's `composeAnswer` prompt can already use all of it.

## Limitations

- Data refreshes weekly (matches the portal's own monthly update cadence, so this is
  already more than fast enough).
- The bot only answers using this cached dataset - no open-ended "explain the industry"
  chat, by design, so your father never gets an AI-hallucinated number.
- Gemini's free tier has rate limits generous enough for personal use, but if it's ever
  briefly unavailable the bot will say so rather than guess.
