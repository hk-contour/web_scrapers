# Bullhorn SIA Staffing Indicator Scraper

## What this does
Scrapes the 5 Infogram chart embeds from:
https://www.bullhorn.com/insights/staffing-industry-indicator/

The page embeds 5 Infogram iframes (confirmed via browser DevTools):
- `2727a150-ae63-4e23-abc9-c0d5e9960f8b` → Total US Staffing
- `60a7be6c-516f-4793-afb0-0efa8981ba27` → IT Staffing
- `87105adf-178c-473c-89ec-c868ed20de9a` → Light Industrial
- `098aa765-e53e-43b9-9fed-e66b47abb126` → Office/Clerical
- `d3ff9169-a574-4e62-9f60-9ec2a09dca80` → SIA Perspective

## Setup
```bash
npm install
npx playwright install chromium
```

## Run
```bash
# Save JSON + CSV to ./output/
node scrape.js

# JSON only
node scrape.js --json

# CSV only
node scrape.js --csv

# Print to stdout (no files)
node scrape.js --stdout
```

## Output
Files saved to `./output/bullhorn_indicator_YYYY-MM-DD.json` and `.csv`

## Data extraction strategy (in priority order)
1. **Window globals** — Infogram stores chart data in `window.__INITIAL_STATE__`
   or similar globals. Best source if available.
2. **DOM tables** — Infogram renders accessible `<table>` elements alongside
   charts for screen readers. Clean structured data.
3. **Network interception** — Captures any JSON API calls made by the iframe
   as it loads. Good fallback.
4. **SVG text labels** — Last resort axis/label scraping.

## Debugging
If data extraction is empty or wrong, run with `--stdout` and inspect the
`windowData.source` field to see which strategy succeeded. Then adjust the
`extractInfogramData()` function in `scrape.js` accordingly.

The most common issue is Infogram changing their window variable name.
Check the raw_scripts output to find the new variable name.

## Scheduling (weekly automation)
Add to crontab to run every Tuesday at 9am (data releases Tuesdays):
```
0 9 * * 2 cd /path/to/bullhorn-scraper && node scrape.js >> logs/scraper.log 2>&1
```

## Dependencies
- `playwright` — headless Chromium browser
- `csv-writer` — CSV output (installed but handled manually for flexibility)
