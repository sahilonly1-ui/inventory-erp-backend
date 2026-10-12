# Price scraper

Fills the ERP's **Market Prices** page with live prices and bank offers from
Amazon, Flipkart, Croma, Reliance Digital and brand sites. No AI, no paid APIs.

## Where it runs
* **GitHub Actions** — `.github/workflows/price-scraper.yml`, 5×/day + "Run workflow".
  Needs the repo secret `PRICE_AGENT_KEY` (same value as on Render).
* **Any Windows/Mac PC** (if a store blocks GitHub's servers):
  ```
  cd scraper
  npm install
  npx playwright install chromium
  set AGENT_KEY=<the key>          (Mac/Linux: export AGENT_KEY=<the key>)
  node index.mjs
  ```
  Options: `STORES=amazon,flipkart` (only these), `QUEUED_ONLY=1`, `LIMIT=20`, `HEADLESS=0` (watch it).

## When a store fails
Screenshots + HTML of failed pages are saved in `scraper/debug/` (on GitHub:
the run's **scraper-debug** artifact). Send them over to fix that store's reader.
