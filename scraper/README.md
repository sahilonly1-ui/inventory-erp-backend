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

## Keeping a run healthy
* `DEADLINE_MIN` (set to 75 in the workflow): stop starting new products after that
  many minutes so the run can finish and report before GitHub's 90-minute limit kills
  it. Products left over go first next time. 0 / unset = no limit.
* A store that blocks several products in a row (Croma does from GitHub's servers) is
  skipped for 15 minutes, then tried once; a skipped store is shown as `skipped` in the
  run summary and its old result is left alone.
* "Not listed" is only reported when a page was really read and the product was not on
  it. A blank page or a sitemap that would not load is reported as `not_found` (retried
  next cycle), not as "not sold here".

## On the showroom PC (`WATCH=1`)
It shares the laptop with whoever is using it, so it runs light:
* one product at a time (`CONCURRENCY`, default 1) and at most one or two pages per store;
* below-normal priority, so the person's own work always comes first (the browser it starts
  inherits this);
* no debug screenshots / HTML unless `DEBUG_DUMPS=1` — earlier versions saved them for every
  failed page and never cleared them; old files are now removed when it starts.
Images, video and fonts are skipped in every mode. The browser closes 2 minutes after the last
refresh, so between refreshes only a small polling loop is left running.

To update the PC: replace the files in its `scraper` folder with the ones from GitHub (or
`git pull`), then close the scraper window and start it again.
