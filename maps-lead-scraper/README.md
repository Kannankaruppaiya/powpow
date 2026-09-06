# Maps Lead Scraper

A Chrome extension that turns a search you could run by hand into **one
downloadable file**.

Two sources:

- **Google Maps** — every business listing for a city and a category: name,
  phone, verified email, area, rating, website, hours and more. It works around
  Google's ~120-results-per-search cap by splitting the city into a **grid** of
  map viewports and searching each one, then merging the results into a single
  deduplicated list.
- **LinkedIn People search** — the results of a people search you have already
  set up: name, headline, company, location, connection degree, open-to-work
  and profile URL. **Read the warning below before using this one.**

Type `dentists` + `Chennai`, press start, and you get a spreadsheet.

---

## ⚠️ Before you use the LinkedIn source

Google's Terms of Service discourage automated collection; the practical
consequence of ignoring them is that a scraper stops working.

**LinkedIn is different.** LinkedIn actively detects automated collection and
**restricts or permanently bans the accounts that do it**. The cost does not
land on this extension — it lands on your personal LinkedIn account, including
your history and your connections.

This adapter is deliberately conservative: it reads only the cards already
rendered on the page you are looking at, never opens individual profiles, and
stops immediately on a login wall or a security check. That reduces the risk.
It does not remove it. Keep runs small and infrequent, and decide knowing the
failure mode is a banned account, not a broken script.

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

Needs Chrome (or Edge) **116 or newer** — the UI is a side panel.

To build a `.zip` for the Chrome Web Store:

```bash
npm run package     # -> dist/maps-lead-scraper-v1.0.0.zip
```

## Use it

1. Click the extension icon. The **side panel** opens on the right and stays
   there while you work — unlike a popup, it does not close when you click into
   the Maps tab the run is driving.
2. On the **One search** tab, enter a **Category** (`dentists`, `gyms`,
   `IT training institutes`) and a **City** (`Chennai`, `Austin, TX`).
   Or switch to **Batch** and paste one search per line:

   ```
   dentists, Chennai
   dental clinics, Chennai
   orthodontists in Coimbatore
   ```

3. Optionally narrow by **Category**. A search like `wholesale store` comes
   back as furniture wholesalers, produce markets and phone-accessory shops;
   typing `wholesale` keeps only the ones you meant. Pick from the list or
   type your own, separate several with commas, and **leave it blank to keep
   everything** — which is exactly how the run behaved before this existed.

   The list offers the categories your last run actually produced, ahead of a
   standing list — a guess at category names is far less useful than the ones
   Google really used.

4. Pick a **Coverage** level (see below) and leave **Max per search** at `0`.
5. Press **Start**. A Google Maps tab opens and drives itself.
6. When it finishes, choose Excel / CSV / JSON and press **Download**.

The panel can be closed while it runs — the job lives in the extension's
background worker, so reopening it shows live progress. **Leave the Google Maps
tab open**, though; that tab is doing the work.

Switch to the **Results** tab at any point to watch rows arrive, filter them,
and download. The table is virtualised, so twenty thousand rows scroll as
smoothly as twenty.

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

The extension also watches itself: it measures how often each field actually
comes back, and if something Maps shows for every listing (a name, a place
link) is suddenly mostly missing, the run **pauses** rather than filling a
spreadsheet with blank columns. Expand **Extraction health** in the panel to
see the per-field rates.

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
| `src/lib/store.js` | IndexedDB: job metadata, records, the cross-run seen index |
| `src/lib/health.js` | Extraction fill rates and the gate that stops a broken run |
| `src/lib/categories.js` | Optional category narrowing, and the suggestions behind the picker |
| `src/lib/export.js` | CSV / JSON serialisation and file naming |
| `src/lib/xlsx.js` | A real .xlsx writer — OOXML in a ZIP, no dependencies |
| `src/content/engine.js` | The source-agnostic half: harvest loop, detail pass, progress, cancellation |
| `src/content/adapters/` | The source-specific half: one adapter per site |
| `src/lib/sources.js` | What differs per source — URL shape, whether a grid applies, health gates |
| `src/panel/` | The side panel UI — see [DESIGN.md](DESIGN.md) |

Three design notes worth knowing:

- **Adapters own the DOM; the engine owns the process.** Google Maps and
  LinkedIn differ in every DOM detail and in almost none of the process — both
  render a virtualised list that grows as you scroll. The engine runs that
  loop; an adapter answers questions about the page.
- **The run is a queue, not a loop.** Batch entries × grid cells become a list
  of tasks written to storage after every one. That is what makes a run
  resumable rather than restartable, and it is why one failed grid cell does
  not sink the other twenty-four.
- **The job lives in the service worker, not the popup.** Chrome kills a popup
  the moment it loses focus, so a popup-owned scrape would die every time you
  clicked away. A keepalive ping stops MV3 evicting the worker mid-run.
- **Records live in IndexedDB, not in the job object.** They used to share
  one blob in `chrome.storage.local`, which meant every progress update
  re-serialised the whole result set — about 5.3 GB of writes over a
  5,000-row run. Now only the rows a task touched are written, and the panel
  reads the database directly instead of pulling everything through a
  message.
- **The file is built in the panel, not the worker.** Blob URLs need a
  document, and service workers do not have one.

---

## Design

The UI follows [DESIGN.md](DESIGN.md): one accent colour, five type sizes, a
4px space scale, and three rules — one primary action per view, anything with a
sensible default is disclosed rather than displayed, and controls name the
outcome rather than the mechanism. Every value is a token in
`src/panel/tokens.css`.

## Development

```bash
npm test          # 144 unit tests — geo, queue, dedupe, parsing, email, verify, health, xlsx, export
npm run test:dom  # browser tests of the DOM wiring (see below)
npm run icons     # regenerate the PNG icons
npm run package   # build the distributable zip
```

`npm run test:dom` runs everything that needs a real browser: the content
script against a synthetic Maps-shaped page (selectors, scroll loop, the
click-into-detail-and-back cycle), the IndexedDB layer against a real database,
the side panel's virtualised table — including a check that only a window of
rows is ever in the DOM — and the LinkedIn adapter against a synthetic page
that hydrates lazily the way the real one does. It needs a browser:

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
| The run paused itself | The extraction health gate fired: a field Maps always shows came back mostly empty, which means a selector broke. See `docs/SELECTORS.md`. Your partial results are kept. |
| The panel does not open | Chrome 116+ is required. Check `chrome://extensions` for a manifest error. |
| LinkedIn: "You are signed out" | Sign in to LinkedIn in that tab and rerun. |
| LinkedIn: "security check" | Solve it in the tab, then rerun — and take it as a signal to slow down. |
| LinkedIn results stop early | The adapter stops if the query or filters change mid-run, rather than blending two searches into one file. |

---

## Please scrape responsibly

This extension automates a browser you are already allowed to use: it reads the
same public pages you would see by hand, at a deliberately unhurried pace. That
does not make it unlimited.

- Scraping Google Maps is contrary to Google's Terms of Service, and scraping
  LinkedIn is contrary to theirs — with the account consequences described at
  the top of this file. You are responsible for how you use this.
- Emails come from business websites. Contacting them puts you under GDPR, the
  CAN-SPAM Act, India's DPDP Act and similar laws — which generally require a
  lawful basis, accurate sender details and a working opt-out.
- Do not raise the speed. The pacing is what keeps this looking like a person
  browsing rather than an attack.

---

## Licence

MIT — see [LICENSE](LICENSE).
