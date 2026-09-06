# Maps Lead Scraper

A Chrome extension that pulls **every business listing** for a city and a
category out of Google Maps and hands you **one file** — name, phone, email,
area, rating and more — as CSV, Excel or JSON.

Type `dentists` + `Chennai`, press start, and you get a spreadsheet.

---

## What you get per business

| Column | Where it comes from |
| --- | --- |
| Business Name | Results list |
| Category | Listing detail panel |
| Phone | Detail panel (`tel:` link — the most reliable source) |
| **Email** | Fetched from the business's own website (Maps never publishes one) |
| Area | Derived from the full address, relative to the city you searched |
| City | Your search input |
| Full Address | Detail panel |
| Rating / Reviews | Results list and detail panel |
| Website | Detail panel |
| Other Emails | Additional addresses found on the site |
| Plus Code | Detail panel |
| Google Maps URL | Results list |

---

## Install (unpacked)

1. Clone or download this folder.
2. Open `chrome://extensions` in Chrome or Edge.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick this folder (the one with `manifest.json`).
5. Pin the extension so its icon is visible in the toolbar.

To build a `.zip` for the Chrome Web Store:

```bash
npm run package     # -> dist/maps-lead-scraper-v1.0.0.zip
```

## Use it

1. Click the extension icon.
2. Enter a **Category** (`dentists`, `gyms`, `pg hostels`, `IT training institutes`)
   and a **City** (`Chennai`, `Coimbatore`, `Austin, TX`).
3. Set **Max results** — leave it at `0` to take everything Maps will show.
4. Press **Start scraping**. A Google Maps tab opens and drives itself.
5. When it finishes, choose CSV / Excel / JSON and press **Download**.

The popup can be closed while it runs — the job lives in the extension's
background worker, so reopening the popup shows live progress. **Leave the
Google Maps tab open**, though; that tab is doing the work.

### Options

| Option | Effect |
| --- | --- |
| **Open each listing for phone & address** | Clicks into every result to read the phone number and full address. Slower, but it is the difference between a list of names and a usable lead list. Leave it on. |
| **Find emails from business websites** | Visits each business's website and reads the email it publishes. |
| **Also check each site's contact page** | When the homepage has no email, follows the site's contact link. |

---

## How long it takes, and how much you get

Google Maps caps a single search at roughly **120 results**, no matter how many
businesses exist. That is Google's limit, not this extension's. To cover a
whole city, run several narrower searches and combine the files:

- By locality — `dentists in Anna Nagar`, `dentists in Adyar`, `dentists in T Nagar`
- By sub-category — `dental clinic`, `orthodontist`, `dental implants`

Rough timings with detail mode on: about **1.5–3 seconds per listing** for the
Maps pass, plus the email pass (4 sites at a time). 120 listings lands around
5–8 minutes.

---

## How it works

```
popup  ──START_JOB──▶  service worker  ──RUN_SCRAPE──▶  content script
  ▲                          │                               │
  │◀──── JOB_UPDATE ─────────┤                        Google Maps tab
  │                          │                          scroll + click
  └──── GET_RECORDS ─────────┘                               │
        (builds the file)     ◀──── records ─────────────────┘
                              │
                              └─▶ fetch business websites for emails
```

| File | Responsibility |
| --- | --- |
| `src/content/scraper.js` | All DOM work: scrolls the results feed, opens each listing, reads the fields |
| `src/lib/parse.js` | Pure text parsing (addresses, phones, ratings) — shared with the tests |
| `src/background/service-worker.js` | Owns the job, drives the tab, enriches emails, persists state |
| `src/lib/email.js` | Fetches business websites and extracts/ranks emails |
| `src/lib/export.js` | CSV / Excel / JSON serialisation |
| `src/popup/` | The UI |

Two design notes worth knowing:

- **The job lives in the service worker, not the popup.** Chrome kills a popup
  the moment it loses focus, so a popup-owned scrape would die every time you
  clicked away. State is mirrored into `chrome.storage.local`, so results
  survive even a worker restart.
- **The file is built in the popup, not the worker.** Blob URLs need a
  document, and service workers do not have one.

---

## Development

```bash
npm test          # 30 unit tests — parsing, email extraction, export formats
npm run test:dom  # browser tests of the DOM wiring (see below)
npm run icons     # regenerate the PNG icons
npm run package   # build the distributable zip
```

`npm run test:dom` drives the real content script inside Chromium against a
synthetic page shaped like Google Maps search results — it verifies the
selectors, the scroll loop, the click-into-detail-and-back cycle and the final
record shape. It needs a browser:

```bash
npm i -D playwright-core     # then either set PLAYWRIGHT_BROWSERS_PATH
npx playwright install chromium
```

The test skips itself if `playwright-core` is not installed, so `npm test`
stays dependency-free.

---

## When it breaks

Google reshuffles the Maps DOM regularly. Every selector lives in one place —
the `SEL` object at the top of `src/content/scraper.js` — and
[`docs/SELECTORS.md`](docs/SELECTORS.md) explains which ones are stable, which
are not, and how to repair them.

Common problems:

| Symptom | Cause and fix |
| --- | --- |
| "No results list found" | The tab is not on a search results page, or Maps is showing a consent screen — accept it in that tab and rerun. |
| Names but no phones | The **Open each listing** option is off. Turn it on. |
| Few emails | Normal. Many small businesses publish no email at all; others hide it behind a contact form. |
| Stops around 120 results | Google's own per-search cap. Split the search — see above. |
| Nothing happens | Reload the extension at `chrome://extensions`, then reopen the Maps tab. |

---

## Please scrape responsibly

This extension automates a browser you are already allowed to use: it reads the
same public pages you would see by hand, at a deliberately unhurried pace. That
does not make it unlimited.

- Scraping Google Maps is contrary to Google's Terms of Service. You are
  responsible for how you use this.
- Emails come from business websites. Contacting them puts you under GDPR, the
  CAN-SPAM Act, India's DPDP Act and similar laws — which generally require a
  lawful basis, accurate sender details and a working opt-out.
- Do not raise the speed. The pacing is what keeps this looking like a person
  browsing rather than an attack.

---

## Licence

MIT — see [LICENSE](LICENSE).
