# Maps Lead Scraper

A Chrome extension that pulls **every business listing** for a city and a
category out of Google Maps and hands you **one file** — name, phone, verified
email, area, rating and more — as CSV, Excel or JSON.

Type `dentists` + `Chennai`, press start, and you get a spreadsheet.

It works around Google's ~120-results-per-search cap by splitting the city into
a **grid** of map viewports and searching each one, then merging the results
into a single deduplicated list.

---

## What you get per business

| Column | Where it comes from |
| --- | --- |
| Business Name | Results list |
| Category | Listing detail panel |
| Phone | Detail panel (`tel:` link — the most reliable source) |
| **Email** | Fetched from the business's own website (Maps never publishes one) |
| **Email Status** | `valid` / `role` / `no-mx` / `disposable` / `invalid` / `unknown` — see below |
| Area | Derived from the full address, relative to the city you searched |
| City | Your search input |
| Full Address | Detail panel |
| Rating / Reviews | Results list and detail panel |
| Website | Detail panel |
| Facebook / Instagram / LinkedIn / X / YouTube | Links published on the business's site |
| Opening Hours | Detail panel — the full week |
| Price Level | Detail panel |
| Claimed | Whether the listing shows "Claim this business" |
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
2. On the **One search** tab, enter a **Category** (`dentists`, `gyms`,
   `IT training institutes`) and a **City** (`Chennai`, `Austin, TX`).
   Or switch to **Batch** and paste one search per line:

   ```
   dentists, Chennai
   dental clinics, Chennai
   orthodontists in Coimbatore
   ```

3. Pick a **Coverage** level (see below) and leave **Max per search** at `0`.
4. Press **Start scraping**. A Google Maps tab opens and drives itself.
5. When it finishes, choose CSV / Excel / JSON and press **Download**.

The popup can be closed while it runs — the job lives in the extension's
background worker, so reopening the popup shows live progress. **Leave the
Google Maps tab open**, though; that tab is doing the work.

If a run is interrupted — you press Stop, Chrome evicts the worker, the browser
restarts — the queue and everything collected so far are already on disk. Open
the popup and press **Resume** to carry on from the search it stopped at.

### Options

| Option | Effect |
| --- | --- |
| **Open each listing for phone & address** | Clicks into every result to read the phone number and full address. Slower, but it is the difference between a list of names and a usable lead list. Leave it on. |
| **Find emails from business websites** | Visits each business's website and reads the email it publishes. |
| **Also check each site's contact page** | When the homepage has no email, follows the site's contact link. |
| **Verify emails** | Looks up the domain's MX records over DNS-over-HTTPS and labels each address. |
| **Skip businesses from earlier runs** | Remembers what you have already exported and leaves it out of the next run. |

---

## Coverage: getting past Google's 120-result cap

Google caps a single Maps search at roughly **120 results**, however many
businesses actually match. The way past it is to ask more than one question.

The first search of each term does double duty: it collects its own results
*and* tells the extension where the city is, because Maps writes the map centre
and zoom into its own URL (`.../@13.0827,80.2707,12z`). No geocoding service and
no API key needed. The extension then lays a grid over that viewport and runs
the same search centred on each cell, zoomed in far enough that Maps returns
businesses local to the cell rather than the same city-wide top 120.

| Coverage | Searches per term | Rough yield |
| --- | --- | --- |
| Off | 1 | ~120 |
| Light | 1 + 4 | ~300 |
| Balanced *(default)* | 1 + 9 | ~600 |
| Thorough | 1 + 16 | ~1,000 |
| Exhaustive | 1 + 25 | ~1,500 |

Yields are rough — a dense city centre fills every cell, a small town does not.
Cells overlap heavily by design, and everything is merged on a stable identity
(the feature id Google embeds in place URLs), so a business found by four
neighbouring cells is still one row.

Stack **Batch** on top for more: three categories × Balanced = 30 searches in
one unattended run.

Rough timings with detail mode on: about **1.5–3 seconds per listing** for the
Maps pass, plus the email and verification passes. A Balanced run over one city
is typically **20–40 minutes** — start it and leave it.

## What "verified email" does and does not mean

No browser can open an SMTP connection, so nothing here can prove a mailbox
exists. Any extension claiming otherwise is guessing. What this does is remove
the addresses that are *certain* to bounce, using signals reachable over HTTPS:

| Status | Meaning |
| --- | --- |
| `valid` | Syntax is fine and the domain publishes a mail server |
| `role` | Deliverable, but `info@`-style — a shared desk, not a person |
| `no-mx` | The domain accepts no mail at all — do not send |
| `disposable` | A throwaway inbox provider |
| `invalid` | Malformed address |
| `unknown` | The DNS lookup did not complete — unverified, not bad |

Lookups go to Cloudflare's DNS-over-HTTPS resolver, falling back to Google's.
Results are cached per domain, so a scraped list costs far fewer queries than
it has rows.

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
| `src/background/service-worker.js` | Owns the run, drives the queue and the tab, persists state |
| `src/lib/geo.js` | Web Mercator maths: map centre, viewport span, the search grid |
| `src/lib/tasks.js` | The search queue — batch parsing, grid expansion, resume points |
| `src/lib/dedupe.js` | Stable business identity, record merging, the cross-run seen index |
| `src/lib/email.js` | Fetches business websites, extracts/ranks emails, finds social links |
| `src/lib/verify.js` | Email verification over DNS-over-HTTPS |
| `src/lib/export.js` | CSV / Excel / JSON serialisation |
| `src/popup/` | The UI |

Three design notes worth knowing:

- **The run is a queue, not a loop.** Batch entries × grid cells become a list
  of tasks written to storage after every one. That is what makes a run
  resumable rather than restartable, and it is why one failed grid cell does
  not sink the other twenty-four.
- **The job lives in the service worker, not the popup.** Chrome kills a popup
  the moment it loses focus, so a popup-owned scrape would die every time you
  clicked away. A keepalive ping stops MV3 evicting the worker mid-run.
- **The file is built in the popup, not the worker.** Blob URLs need a
  document, and service workers do not have one.

---

## Development

```bash
npm test          # 98 unit tests — geo, queue, dedupe, parsing, email, verify, export
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
| Stops around 120 results | Coverage is set to Off. Pick Balanced or higher. |
| Grid skipped, one search only | The map centre could not be read from the tab URL. Rerun; if it persists, Maps may have changed its URL format. |
| A run stopped halfway | Press **Resume** — the queue and results are on disk. |
| Every email says `unknown` | A network or firewall is blocking DNS-over-HTTPS. Verification degrades to unverified; the emails themselves are still fine. |
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
