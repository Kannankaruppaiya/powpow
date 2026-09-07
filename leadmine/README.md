# LeadMine

**LeadMine — Google Maps & LinkedIn Lead Scraper**

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
npm run package     # -> dist/leadmine-v5.0.0.zip
```

## Use it

1. Click the extension icon. The **side panel** opens on the right and stays
   there while you work — unlike a popup, it does not close when you click into
   the Maps tab the run is driving.
   The version LeadMine is actually running is shown next to the name in the
   panel's header. After a `git pull` and a **Reload** in `chrome://extensions`,
   check that number changed — it is read from the manifest, so it cannot
   disagree with what is loaded.
2. Type what you are looking for — `dentists`, `gyms`, `IT training
   institutes`. Or press **+ Search several at once** and paste one search per
   line:

   ```
   dentists, Chennai
   dental clinics, Chennai
   orthodontists in Coimbatore
   ```

3. **Where?** — pick a country, then a state, then the town, or just type the
   town if you already know it (`Chennai`, `Austin, TX`). The two dropdowns
   only decide what the town box suggests; the box is what gets searched, and
   it stays editable. A town picked for Maps comes qualified with its state
   ("Chennai, Tamil Nadu"), because "dentists in Springfield" is a question
   with twenty answers.

4. Optionally narrow by **Category**. A search like `wholesale store` comes
   back as furniture wholesalers, produce markets and phone-accessory shops;
   typing `wholesale` keeps only the ones you meant. Pick from the list or
   type your own, separate several with commas, and **leave it blank to keep
   everything** — which is exactly how the run behaved before this existed.

   The list offers the categories your last run actually produced, ahead of a
   standing list — a guess at category names is far less useful than the ones
   Google really used.

   **Nothing is deleted by narrowing.** Rows that do not match are *set aside*,
   not thrown away: the Results tab shows a notice saying how many, which
   filter did it, and which categories were actually found, with a **Show
   them** toggle. If your filter matches nothing at all — 235 found, 235 set
   aside — the rows are shown by default, because that is a wrong filter and
   not a failed scrape. The download always writes exactly what the list is
   showing.

   A filter you have set shows as a chip beside the **Start** button — it is
   saved between runs, and an input holding a value from three weeks ago looks
   exactly like an empty one. Click the chip to clear it.

5. Pick a **Coverage** level (see below).

   On a **LinkedIn** search there is no grid, so the panel asks **How many
   profiles?** instead — leave it blank for every profile LinkedIn will show
   you, or type a number to stop there.
6. Press **Start**. A Google Maps tab opens and drives itself.
7. When it finishes, choose Excel / CSV / JSON and press **Download**.

The panel can be closed while it runs — the job lives in the extension's
background worker, so reopening it shows live progress. **Leave the Google Maps
tab open**, though; that tab is doing the work.

When a run finishes the panel switches to **Results** by itself — that is what
the run was for. You can go there at any point during a run too, to watch leads
arrive, filter them and download. Each lead is a card: name, phone, email,
area, category, all readable without opening anything, and clicking a phone
number, an email or a LinkedIn name copies it to the clipboard. The list is
virtualised, so twenty thousand leads scroll as smoothly as twenty.

If a run is interrupted — you press Stop, Chrome evicts the worker, the browser
restarts — the queue and everything collected so far are already on disk. Open
the popup and press **Resume** to carry on from the search it stopped at.

---

## The search planner (optional AI)

Most people know their business perfectly well and still cannot guess which
Maps searches find its customers. *"I make industrial floor-cleaning
chemicals"* is not a search. **"facility management companies"** is.

Describe the business at the top of the Search tab and press **Plan my
searches**. You get back the searches most likely to surface real buyers, each
with the reason it is there:

| Search | Why |
| --- | --- |
| facility management companies | They buy cleaning chemicals in bulk for the sites they run |
| janitorial supply wholesalers | They resell to hundreds of smaller buyers |
| hotel housekeeping suppliers | Hotels consume floor cleaner daily |
| commercial cleaning companies | Contract cleaners buy their own supplies |

Nothing runs automatically. The plan is a list of tick-boxes: untick what you
do not want, press **Use these searches**, and it lands in the batch box where
you can still edit it by hand before pressing Start.

If one missing fact would change every search — *"I need suppliers"*, suppliers
of what? — it asks that one question instead of guessing.

On LinkedIn the same box plans **people** searches: job titles and skills
rather than business categories.

### Setting it up

You bring your own key; there is no server in the middle and nothing to pay
for. Both providers have a free tier that is far more than this needs — one
plan is a single request of about a thousand tokens.

| Provider | Get a key | Default model |
| --- | --- | --- |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-2.5-flash` |

| **Groq** | [console.groq.com/keys](https://console.groq.com/keys) | `llama-3.3-70b-versatile` |

Paste it under **More options → Search planner**. Two providers are offered
because they run out differently — Gemini's free tier caps per day, Groq's per
minute — so there is always the other one to switch to. Each provider keeps its
own key, so switching does not lose the other.

**Model** is a picker, behind a toggle, and it lists the models *your key can
actually use* — fetched from the provider when you open it, never typed. Leave
it on "Recommended" unless you have a reason. There is no free-text model box:
every model failure this feature has had came from a name that was remembered
rather than read from the provider.

### Where the API shapes come from

Both integrations are written against the providers' own machine-readable
specs, not from memory. Read these before changing `src/lib/ai.js`:

| Provider | Source of truth |
| --- | --- |
| Gemini | `https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta` — the v1beta discovery document |
| Groq | [`groq/groq-typescript`](https://github.com/groq/groq-typescript) — generated from their OpenAPI spec |

Three things that cost a round of guessing, all of them in the specs:

- Gemini's `responseSchema` is an **OpenAPI 3.0 subset, not JSON Schema**.
  `type` is an uppercase enum (`OBJECT`, `ARRAY`, `STRING`, `INTEGER`), and a
  list of allowed values needs `format: "enum"` on a `STRING`. Lowercase
  `"object"` is rejected. `toGeminiSchema()` converts; the schema itself stays
  ordinary JSON Schema for Groq and the prompt.
- The model path parameter is constrained to `^models/[^/]+$`. A name with a
  slash in it — or an empty one — is the *"unexpected model name format"*
  error, which does not mention models at all.
- `system_instruction` works, but `systemInstruction` is the canonical name.
- A blocked or truncated answer is a **200 with no text in it**. It reports
  itself in `promptFeedback.blockReason` or `candidates[0].finishReason`;
  reading only `content.parts` turns every one of those into "unreadable
  answer" and sends you looking in the wrong place.

**Where the key goes:** into `chrome.storage.local` on this machine, and out in
a request header to the provider you picked. It is deliberately kept out of the
run config, so it cannot reach the background worker, a saved job, or an
exported file. It is never put in a URL, because a URL carrying a secret ends
up in every log it passes through.

The planner is entirely optional. Leave the key blank and LeadMine works
exactly as it did before — type a category and a city and press Start.

---

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
| `src/lib/places.js` | The country / state / town lists behind the "Where?" picker |
| `src/lib/tasks.js` | The search queue — batch parsing, grid expansion, resume points |
| `src/lib/dedupe.js` | Stable business identity, record merging, the cross-run seen index |
| `src/lib/email.js` | Fetches business websites, extracts/ranks emails, finds social links |
| `src/lib/verify.js` | Email verification over DNS-over-HTTPS |
| `src/lib/store.js` | IndexedDB: job metadata, records, the cross-run seen index |
| `src/lib/health.js` | Extraction fill rates and the gate that stops a broken run |
| `src/lib/categories.js` | Optional category narrowing, and the suggestions behind the picker |
| `src/data/geo/` | Generated: one small file per country, plus an index. See below |
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

## LinkedIn's own filters

A place typed into a LinkedIn search is **not a location filter**. It is a word
LinkedIn hunts for anywhere in a profile — which is why a search for
`finance head theni` came back full of people in Coimbatore and Chennai whose
profiles merely mention Tamil Nadu.

The real filters are separate, and they take LinkedIn's **internal ids**:

```
?keywords=kotlin&origin=FACETED_SEARCH
  &geoUrn=%5B%22102713980%22%5D          ["102713980"]  = India
  &serviceCategory=%5B%2220016%22%5D     ["20016"]      = Corporate Training
```

Those ids are not published, not documented and not derivable from the name,
so **there is no table to ship**. LeadMine learns them instead. Whenever you
apply a filter on LinkedIn by hand, the content script sees both halves at
once — the label on the checkbox you ticked and the id that lands in the URL —
and pairs them. One filter, applied once, is known forever after.

Ask for a value it has never seen and it says so, naming exactly what to do:

> LinkedIn's id for "Munnar" is not known yet. Apply it once on LinkedIn —
> open the filter, tick it, press Show results — and LeadMine will remember it
> from then on.

**It never guesses.** A wrong id does not fail; it quietly searches somewhere
else and hands back a spreadsheet of the wrong people that looks entirely
correct. Two ids ship as seeds because both were read off a live page with the
label and the id visible together; two more have been observed but which label
belongs to which is an inference, so they are left to be learned properly.

With more than one location chosen, **One search per location** runs them
separately. A people search stops after a fixed number of pages however good
the filter is, so two places in one search share that ceiling instead of
getting one each — the same reason Maps runs get a geographic grid.

### Search the rare word, filter the common one

LinkedIn's free people search is not a boolean engine. `kotlin trainer` does
not mean "both" — it is a relevance ranking over a bag of words, biased hard
towards your own network, so it returns "trainer" matches with no Kotlin
anywhere in them.

Give LinkedIn the *rare* term and let LeadMine narrow on the common one:

```
LinkedIn:   kotlin        + Location: India + Service category: Corporate Training
LeadMine:   Headline contains: trainer
```

The narrowing filter reads a person's headline, their current role and their
employer, not the headline alone — the best result for "kotlin trainer" had
`Software Developer` as its headline and the word *Trainer* only in the line
underneath.

---

## Where the place lists come from

The "Where?" picker offers 250 countries, ~5,300 states and ~152,000 towns.
They come from the [Countries States Cities
Database](https://github.com/dr5hn/countries-states-cities-database), which is
a 46 MB JSON file — almost all of it ids, coordinates, timezones, currencies
and translations that a dropdown has no use for.

`scripts/build-geo.mjs` strips it to names and splits it by country into
`src/data/geo/`, so choosing India reads 48 KB and choosing nothing reads the
11 KB index. The output is committed; the script only needs re-running to
refresh the data:

```bash
node scripts/build-geo.mjs                 # downloads the source
node scripts/build-geo.mjs path/to/csc.json # or reuses a local copy
```

`test/places.test.mjs` checks the generated data as well as the code that
reads it — every country in the index has a file, the index is in reading
order, and no state lists the same town twice.

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
the side panel's virtualised lead list — including a check that only a window
of cards is ever in the DOM, and that **Start** is on screen the moment the
panel opens — and the LinkedIn adapter against a synthetic page
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
