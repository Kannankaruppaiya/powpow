# LeadMine

**LeadMine — Google Maps & LinkedIn Lead Scraper**

A Chrome extension that turns a search you could run by hand into **one
downloadable file**.

Four sources:

- **Google Maps** — every business listing for a city and a category: name,
  phone, verified email, area, rating, website, hours and more. It works around
  Google's ~120-results-per-search cap by splitting the city into a **grid** of
  map viewports and searching each one, then merging the results into a single
  deduplicated list.
- **LinkedIn People search** — the results of a people search you have already
  set up: name, headline, company, location, connection degree, open-to-work
  and profile URL. **Read the warning below before using this one.**
- **Public web** — the same people, found through a search engine instead of
  through LinkedIn. No login and no connection degree, so it names people a
  signed-in search shows only as "LinkedIn Member". See
  [Reaching people outside your network](#reaching-people-outside-your-network).
- **Posts** — recent LinkedIn posts that *ask for something*: "SAP FI trainer
  required, Mumbai", "looking for freelance corporate trainers". Each post is
  dated to the minute from its own id, anything older than the window you
  pick (3–30 days) is set aside, and a classifier keeps the posts that ask and
  sets aside the ones that sell, advertise a course or say thank you. See
  [Recent posts that ask for something](#recent-posts-that-ask-for-something).

Type `dentists` + `Chennai`, press start, and you get a spreadsheet.

Then it helps with what comes after the spreadsheet: an AI **judge** says which
leads fit what you are after and **why**, reading each business's own website;
an optional **email finder** gets work addresses for the people worth writing
to; each lead carries a **status and a follow-up date**; a **do-not-contact**
list is honoured by every future run; a **cold-email** export goes straight
into Instantly or Smartlead; and a search can **run on its own every morning**
and send what it found to your phone through **PowPow**. See
[After the run](#after-the-run-judge-follow-up-find-emails).

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
| Website Description / People Named On Website / Employees | The site's own schema.org data — what it says about itself, who it names (founder, director), its headcount |
| Plus Code | Detail panel |
| Google Maps URL | Results list |

## What you get per person

Both people sources — LinkedIn and the public web — write the same columns, so
one file can hold rows from both.

| Column | LinkedIn | Public web |
| --- | --- | --- |
| Name | Result card | Result title |
| Headline | Result card | Result title, after the dash |
| Company | Result card | The "… at Company" in the headline |
| Location | Result card | The place in the snippet |
| Connection | 1st / 2nd / 3rd+ | — no degree exists off LinkedIn |
| Open To Work | The badge on the card | — not shown on a public profile |
| Match Context | The line under the headline | The result snippet |
| Profile URL | Result card | The result link |
| Found Via | `linkedin` | `web` |

An empty **Connection** on a public-web row is a fact about the source, not a
missed field — which is why **Found Via** is a column and not a footnote.

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
2. Pick a **source**: Google Maps for businesses, LinkedIn for people you can
   already see, or Public web for people you cannot — see
   [Reaching people outside your network](#reaching-people-outside-your-network).

3. Type what you are looking for — `dentists`, `gyms`, `IT training
   institutes`. Or press **+ Search several at once** and paste one search per
   line:

   ```
   dentists, Chennai
   dental clinics, Chennai
   orthodontists in Coimbatore
   ```

4. **Where?** — pick a country, then a state, then the town, or just type the
   town if you already know it (`Chennai`, `Austin, TX`). The two dropdowns
   only decide what the town box suggests; the box is what gets searched, and
   it stays editable. A town picked for Maps comes qualified with its state
   ("Chennai, Tamil Nadu"), because "dentists in Springfield" is a question
   with twenty answers.

5. Optionally narrow by **Category**. A search like `wholesale store` comes
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

6. Pick a **Coverage** level (see below).

   On a **people** search there is no grid, so the panel asks **How many
   profiles?** instead — leave it blank for everything the source will show
   you, or type a number to stop there.
7. Press **Start**. A tab opens on the source you picked and drives itself.
8. When it finishes, choose Excel / CSV / JSON and press **Download**.

The panel can be closed while it runs — the job lives in the extension's
background worker, so reopening it shows live progress. **Leave the tab it
opened alone**, though; that tab is doing the work.

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
| **Open sites that block a plain visit in a background tab** | When a site answers with a 403, a challenge page or an empty JavaScript shell, opens it in a background tab, reads what the browser built, and closes it. One tab at a time, at most 150 a run. |
| **Verify emails** | Looks up the domain's MX records over DNS-over-HTTPS and labels each address. |
| **Skip businesses from earlier runs** | Remembers what you have already exported and leaves it out of the next run. |

The extension also watches itself: it measures how often each field actually
comes back, and if something Maps shows for every listing (a name, a place
link) is suddenly mostly missing, the run **pauses** rather than filling a
spreadsheet with blank columns. Expand **Extraction health** in the panel to
see the per-field rates.

---

## After the run: judge, follow up, find emails

Collecting is half the job. Six hundred rows with nothing saying which are
worth a call is a spreadsheet you still have to read, so the Results tab now
carries what happens next. It is behind **Judge, find emails, GCC list, do not contact**,
because Download is still that view's one action.

Every lead card has a fourth line: the verdict, the reason, where the
conversation stands, and your own 👍 / 👎.

### Judge leads (AI)

Say in a sentence or two what a good lead is — *"companies in Chennai with 20+
staff that train their own teams, not institutes selling courses"* — and press
**Judge leads**. Each lead comes back **Fit**, **Maybe** or **Not a fit**, with
one sentence saying *why*, naming the evidence. The reason is the point (the
idea is OpenOutreach's): a verdict can only be accepted, a reason can be
disagreed with, and the fix for a wrong one is to say more precisely what you
want.

- **Businesses** are judged on their listing *and their own website* — the text
  the email pass already read. The same call pulls out what they actually
  sell, a named owner or director, and how big they look.
- **People** are judged on their headline, company and location.
- **Posts** get a second opinion on the keyword classifier: is the author
  *asking* for what you offer, or selling it, or thanking a client?
- **Your 👍 and 👎 are the memory.** The newest of them go with every call as
  worked examples, and your mark always beats the model's — in the filter, the
  email finder and every export.

It uses the same free Gemini or Groq key as the search planner, twelve leads
per request. Phones and emails are never sent to the model; they have nothing
to do with fit. Verdicts arrive batch by batch and are kept if a run is
stopped or a key runs out halfway.

The filter beside the search box shows **Fit**, **Fit + maybe**, **Not judged**,
**Follow up due** or **In conversation**.

### Work emails for people (paid, optional)

LinkedIn, public-web and post rows name a person and a profile and nothing you
can write to. **Find work emails** looks the profile up with an email finder —
**Apollo** (`people/match`, a miss is free) or **BetterContact** (async, one
credit per lookup) — using your own key. Request and response shapes follow
OpenOutFind's clients, which were written against the providers' docs.

Rules, all about money: only leads judged **Fit** (tick *maybe* to widen it),
only ones with a profile link and no email yet, never anyone on the
do-not-contact list, capped at the number you type — and the button takes two
presses, the first saying how many credits it will spend. Only the profile link
is sent. A "guessed" address counts as a miss: an invented first.last@ would
sit in the Email column looking exactly like a real one, and bounce.

### Follow-ups

Each card has a status: New → Contacted → Followed up → Replied → Meeting →
Won, or Not interested / Do not contact. **Contacted** sets a follow-up three
working days out; **Followed up** sets the next one five working days after
that; the third unanswered email is where it stops (the rhythm is
OpenOutSend's). When something is due, Results says so first: *"3 leads are
due a follow-up today"*. Statuses live in their own store, so re-scraping the
same street never wipes them.

### Do not contact

A list of addresses, whole domains, LinkedIn profiles and phone numbers,
one per line. Marking a card **Do not contact** adds its email, profile and
phone. Everyone on it is **set aside by every future run** before any website
is fetched (never deleted — shown with the reason), and **never written into a
cold-email export**. An opt-out follows the person, not the row: the same
number written differently, the same person found through a post, or an address
a finder returned later are all caught. Free-mail domains (gmail.com and the
like) cannot be blocked whole, because that would block everyone.

### People ↔ businesses

A person whose company matches a business you found on Maps — by website
domain, or by company name with "Pvt Ltd", "Inc" and punctuation ignored — is
linked to it across runs. The person's card says *at Acme Training (Maps)*, the
business's card says *2 people on LinkedIn*, and the export fills a **Linked**
column with the business's phone and website, or the names of its people. A
name two businesses share (a chain) links to neither.

### Exports

When anything has been judged, marked or linked, the Excel, CSV and JSON files
gain **Fit, Why, What They Do / Need, Decision Maker, Size, Person Email,
Linked, Status, Follow Up On, Do Not Contact**. A file with nothing to add gets
no empty columns.

**Cold-email tool (.csv)** is a fourth format, in the column names Instantly
and Smartlead import without mapping — `email, first_name, last_name, company,
title, website, linkedin_url, phone, location, reason, …` — and only the rows it
is right to write to: an address, not on the do-not-contact list, not judged or
marked a poor fit, not closed, not certain to bounce. `reason` arrives as a
custom variable, which is the best first line a cold email can have. Turn on
your sequencer's import dedupe.

---

## GCC leads first

India's Global Capability Centres — the captive tech, finance and operations
centres that Wells Fargo, Goldman Sachs, Walmart and the rest run for
themselves — are the first priority. A lead from one is marked **GCC** on its
card, listed first, and a GCC's requirement post goes above everything else.
**Show → GCC companies** lists only them; the export gets a **GCC** column
saying which one and how that was decided.

A lead counts as a GCC when:

| What | Example |
| --- | --- |
| The company field names one | `Wells Fargo International Solutions Pvt Ltd` |
| The headline says who they work for | `Talent Acquisition at Goldman Sachs` |
| A post's author works at one | author headline `HR Manager at Bank of America` |
| A post names one as the employer or client | `for our client Deutsche Bank, Pune`, `SAP Labs India` |
| A post says GCC without naming it | `for a leading GCC in Chennai` — the Gulf's "GCC countries" does not count |

Names that are also products people train on — SAP, Oracle, Salesforce,
ServiceNow — only count with a company around them: "SAP FICO trainer needed"
is about the software, "trainer needed at SAP Labs India" is about the
company. Names that are ordinary words (Target, Shell, Visa) only count in a
company field, and only whole.

The judge is told which leads are GCCs and that they come first; a GCC name
does not make a lead a fit by itself. A PowPow message puts GCC leads first
and tags them `[GCC: …]`.

**Your own names.** Add a centre the list misses under **Your GCC companies**;
it is matched like the built-in ones, and a common word you add is trusted.

### Where the list comes from

`src/data/gcc.json` holds **817** companies with their India cities and
aliases, merged from the public lists that could be read without an account:
Flexiple (all-India and city pages for Bengaluru, Hyderabad, Delhi NCR,
Mumbai, Chennai and Pune), ANSR's Fortune 500 list, GCC Index, OceanFrogs,
Business of GCC, Wisemonk, Mind2Markets, a Hyderabad list on GitHub, and
2025–26 launch news. Service vendors and staffing firms those lists mix in
(Accenture, Capgemini, Adecco …) are left out.

India has about 2,100 GCCs. The complete lists — AIM's GCC Explorer, GCCPROs,
KAS — sit behind a sign-up or a sale, so the long tail of small centres is
not here. Add the ones you meet under **Your GCC companies**.

---

## Running on its own, and PowPow

### A schedule

Under **More options → Run it on its own**, tick **Repeat this search
automatically** and pick weekdays or every day, and a time. The search is saved
as it stands at that moment; **Schedule the search that is in the form now**
replaces it. Each scheduled run skips everything you have already downloaded,
so it brings only what is new — *"who posted this week that they need a SAP
trainer?"*, every morning. Chrome has to be open at that time; a missed time
runs when Chrome next starts (that is how Chrome alarms work). A search that
reads "the tab I'm on" cannot be scheduled, and says so.

### Send results to PowPow

[PowPow](../README.md) is the gateway between an agent and Telegram, WhatsApp,
Slack and the rest. Its `POST /hooks/agent` endpoint (see
`docs/automation/webhook.md`) takes a message, runs an agent turn on it, and
delivers the reply to a channel. Tick **Send results to PowPow**, and a finished
run is posted there: the leads, best first, with contact details and the
judge's reasons — and the agent sends you the short version on your phone.

1. In the gateway config: `hooks: { enabled: true, token: "<secret>" }`.
2. In LeadMine: the hook address (default
   `http://127.0.0.1:18789/hooks/agent`), the same token, and optionally a
   channel and recipient. **Send a test** checks the whole path.
3. By default only scheduled runs are sent; a run you started by hand has you
   right there.

The token goes in an `Authorization` header, never in the URL. Unlike the AI
and email-finder keys it is readable by the background worker — a scheduled
run finishes with nobody looking at the panel — and it is kept in its own slot,
never in a job, a record or an export. The agent is told not to contact anyone
itself.

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
| `src/lib/search-cache.js` | What a LinkedIn search already returned, so it is never paid for twice |
| `src/lib/posts.js` | Post ids to dates, the DEMAND/SUPPLY/RECAP classifier, contacts in a post, the date and intent narrowing |
| `src/lib/email.js` | Fetches business websites, extracts/ranks emails (incl. Cloudflare-hidden, `[at]` spellings, entities, JSON-LD), finds social links, keeps the page text for the judge, and says when a page needs a real tab |
| `src/lib/verify.js` | Email verification over DNS-over-HTTPS |
| `src/lib/store.js` | IndexedDB: job metadata, records, the cross-run seen index, notes (verdicts, marks, statuses — never wiped by a re-scrape) and the do-not-contact list |
| `src/lib/qualify.js` | The lead judge: digests, the prompt, your marks as examples, and checking what the model says |
| `src/lib/enrich.js` | Work emails for people through Apollo or BetterContact, behind the spend gate |
| `src/lib/crm.js` | Statuses and follow-up dates, the do-not-contact list, and the cold-email export rows |
| `src/lib/link.js` | Joining people to the businesses they work at, across runs |
| `src/lib/schedule.js` | When the saved search runs next, and what an unattended run may do |
| `src/lib/powpow.js` | Handing a finished run to PowPow's `/hooks/agent` |
| `src/content/heal.js` | Self-healing selectors: remembers what working elements look like and finds them again when Maps moves them |
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

- **Adapters own the DOM; the engine owns the process.** Google Maps, LinkedIn
  and a search engine's results page differ in every DOM detail and in almost
  none of the process — each renders a list of results that grows as you
  scroll or page. The engine runs that loop; an adapter answers questions
  about the page. Adding the public web as a third source needed one new file
  in `src/content/adapters/`, and no change to the engine at all.
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
so **there is no table to ship** — and LeadMine does not need one.

**Type any place and press Start.** The run lands on the plain keyword search
and then works LinkedIn's own filter panel the way a person would: opens
Locations, types the name, waits for the options, ticks the one it asked for
and presses Show results. LinkedIn writes the URL, ids and all. Nothing had to
be looked up in advance.

Every pairing it sees on the way is kept — the label on the checkbox and the id
in the URL — so the same search skips all of that next time and goes straight
to a URL. One applied filter teaches the whole list it came from: typing "usa"
into LinkedIn's box renders ten places at once, each carrying its id, and
options rendered together belong to the same facet.

**It never guesses.** A filter that will not apply fails the task and says so,
rather than scraping on unfiltered: a wrong or missing location filter does not
error, it hands back a spreadsheet of the wrong people that looks entirely
correct. Two ids ship as seeds because both were read off a live page with the
label and the id visible together.

**The town in "Where?" is not thrown away.** Once a filter exists the town
stops going into the keywords — rightly, since `keywords` is not a location
filter — and it used to be dropped there and then: a service category chosen
with no location meant a **worldwide** search from a form reading "Chennai".
It becomes a real location filter now, applied by driving LinkedIn's panel.

And when a location filter *is* chosen and it is not that town, the panel says
which place will actually be searched — *"Searching India. 'Chennai' is not
being used"* — with one click to swap. LinkedIn ORs its locations, so adding
the town to a country narrows nothing; the choice has to be the user's. A
nationwide search is also how a run comes back nearly empty: almost everyone
it finds is outside your network, and LinkedIn will not name them.

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

## LinkedIn's monthly allowance

A free LinkedIn account gets roughly **300 people searches a calendar month**.
Past that, LinkedIn serves **three results per search** and anonymises every
result after them — the card reads "LinkedIn Member" with no name and no
profile link. It resets at midnight PST on the 1st.

Nothing was counting that. A month's allowance went in eight days of testing,
and the run looked broken rather than out of budget: three rows from a page
showing twelve, every time, on every version of this extension — and on none
of them, with the extension turned off entirely.

**What a run actually costs**, which was invisible before:

| | Search pages |
| --- | --- |
| One run, filters already learned | 1 per page of results |
| One run, two filters LinkedIn has to apply | +2 — each "Show results" is a search |
| "One search per location", four places | ×4 |
| Re-running the same query | full price again |

**A search already answered costs nothing.** Most of the allowance did not go
on new searches — it went on the same ones: a run stops early and is re-run, a
filter is adjusted and the whole thing starts from page one again. None of
those needed to touch LinkedIn; the results were already on disk.

Answers are keyed on what the search *is* — its keywords and its filters, with
LinkedIn's own tracking parameters stripped, since `origin`, `searchId` and
`spellCorrectionEnabled` change between two runs of the identical search and
would make every repeat a miss. Pages are held individually and age
individually, so a repeat of the same depth spends nothing, going deeper pays
only for the difference, and a page older than a week is refetched rather than
served beside a fresh one.

**The wait between pages is a range, not a number.** Everything else about a
run already looks like a person — the user's own Chrome, their own address,
their own signed-in session, no headless browser and no automation framework
to fingerprint. The clock was the one thing that did not: ten pages at a fixed
1200ms is twenty seconds of perfectly even spacing, and evenness is the
signal. It is a range now, and it lengthens as a run goes on.

**A run stops at the budget rather than discovering the wall.** Paging by URL
made reaching all 100 pages reliable for the first time, which is exactly the
danger — at 100 pages a run, three runs spend a month, and the version before
this one only avoided that by failing to find its own Next button. A LinkedIn
run goes ten pages deep by default (a hundred people), and refuses to start
once the month's budget is gone. Both numbers are yours to change; LinkedIn
does not publish its allowance and does not hold it fixed, so 300 is a place
to stop, not a fact.

The panel shows what has been spent, beside **Start**, where the decision
is made. LinkedIn's own counter cannot be read from here, so this is not it —
it counts every people-search page LeadMine itself asks for, which is the
whole of what is knowable and moves in step with theirs.

### Paging is arithmetic, not a button

LinkedIn's Network panel settles what turning a page is: **one `document`
request** for `…&page=N`, and no XHR at all.

The adapter used to scroll to the foot of the page, wait, scroll again, wait,
then hunt for a control whose label reads like "next" for four more seconds —
all to add one to a number in the URL. When the hunt failed, the run stopped
and reported *"the next page did not load"*, as though LinkedIn had refused.

The worker turns the page now, by URL. A navigation destroys the content
script, so paging cannot live inside the scrape loop; each page is scraped on
its own and merged. It stops on the first page that adds nobody new, which is
also what LinkedIn does at the end rather than erroring.

---

## Reaching people outside your network

LinkedIn's own people search has a limit no filter can lift: **it will not tell
you who anyone outside your network is.** The card comes back reading
*"LinkedIn Member"*, with no name and no profile URL. A search that reaches
every corner of the site still hands back rows nobody can act on. This is not
rate limiting — LinkedIn is not withholding the data because the run was too
fast. It withholds identity by degree, and no pacing changes that.

**LeadMine counts them and says so.** A run that finds twelve results and
exports three looks exactly like a broken scraper, and the natural response is
to run it again — and get three again. So the panel says, in a line of its
own: *"LinkedIn would not name 9 people it showed."* Nothing was lost in the
scrape. Those nine are precisely the people the Public web source exists to
find.

The same person's **public profile page names them**, and search engines have
indexed hundreds of millions of those pages. So the answer is not a bigger
search on LinkedIn; it is a different door.

The **Public web** source searches for public profiles instead of asking
LinkedIn:

```
site:linkedin.com/in corporate trainer Chennai
```

**Google, and nothing is quoted.** Both were decided by running them, not by
reasoning about them. Bing was the first choice, on the argument that Google
challenges automated queries hardest — the live run had Bing answer with *"One
last step — please solve the challenge"* while Google returned a full page of
trainers. And the quoted form, `"kotlin corporate trainer"`, came back from
Google as **No results found**, because almost nobody writes those three words
in that order; it then quietly re-ran the query without the quotes and found
plenty. A query that only works because the engine ignored it is not a query.
Unquoted, the engine ranks on all the words and LeadMine's own **Category**
filter does the narrowing — the same division of labour the LinkedIn source
uses.

A result already carries what a card would have: the title is LinkedIn's own
page title, `Priya Sharma - Corporate Trainer at Acme Corp | LinkedIn`, and the
snippet under it usually carries the location. Name, headline, company,
location, profile URL — with no login, no connection degree and nobody
anonymised.

**What it does not get.** Only profiles the person made public and the engine
indexed. No connection degree, no open-to-work badge, no email. It is a
discovery pass, not a replacement for the LinkedIn source — which is why both
merge into one list.

**One person, one row.** Records are keyed on the profile slug, so somebody
found both ways appears once, not twice, whichever source saw them first.

### Everything is found by shape

Three engines, three layouts, and every one of them rewrites its class names
without warning. So nothing here is named:

- **A result is any link that resolves to `linkedin.com/in/<slug>`** — through
  DuckDuckGo's `/l/?uddg=` wrapper, a generic `?url=` redirect, or straight out.
- **A result is titled, and page furniture is not.** Every engine puts the
  title in a heading, on one side of the link or the other, with a line of
  text underneath; a navigation link has neither. Without this rule, a search
  that matched nothing came back with one row — the engine's own header link,
  named "LinkedIn".
- **The results region is the deepest element holding a majority of them.**
  Chrome is a lone link; results come in a cluster.
- **The title is the heading, not the link text.** Google wraps the site line
  *and* the heading in one anchor, so reading the link put "LinkedIn · Priya
  Sharma 500+ followers Priya Sharma - Corporate Trainer…" in the Name column.
- **A result's own links are all of them, not the first.** The same profile is
  linked two or three times per result — the title, the breadcrumb URL under
  it, a thumbnail. Taking the first put `linkedin.com › in › priya-sharma` in
  the Name column; leaving the breadcrumb in the snippet put it in the
  Location column.
- **A snippet stops where the next person starts** — the block is climbed
  until it links to a second person, not until it exceeds a character count.
- **The next page has to be on the search engine.** `findNext` searches every
  link on the page, and on a search engine the links are *results* — content
  anyone can rank and title. A result titled "Show more results for kotlin
  trainers" matches the label as well as the engine's own control does, and
  sits above it in document order. Followed, that URL was fetched **with
  credentials** and its markup imported into the live page: a request to
  somebody else's server carrying whatever cookies the user has there, and
  their HTML dropped into the engine's own origin. The next page of a search
  is on the search engine; anything else is not a next page, whatever it calls
  itself. Redirects are checked where they land, not where they start.
- **Imported markup is made inert first.** `DOMParser` runs nothing, but these
  nodes are about to be inserted into a live document, where an `onerror` on
  an `<img>` fires immediately — in the page's own origin, not the content
  script's isolated world. Scripts, frames and event handlers do not survive
  the trip.
- **The next page is fetched, not clicked.** On a search engine Next is a full
  navigation, and a navigation destroys the content script mid-run: the scrape
  would be abandoned with page one and no error anywhere. LeadMine requests
  the next page's URL and appends its results to the ones already on screen.

Profiles are never opened. The title already carries the name and the
headline, so opening each result would multiply the request count for very
little — the same call the LinkedIn adapter makes.

If the engine puts up a CAPTCHA the run stops and says so, rather than
scraping the challenge page into the spreadsheet.

---

## Recent posts that ask for something

The question this source answers is *"who posted in the last ten days that
they need a corporate trainer?"* Both halves are harder than they look.

### When: the post's id, not the engine's date

A search engine's "past week" is **its** date — when it first saw the page —
not when the post was written. Engines index LinkedIn posts one to three
weeks late: asked on 23 September for the last ten days, the newest
"trainer requirement" post one engine held was from the 7th. So the engine's
filter both lets old posts through and cannot promise new ones.

What does not drift is the post's own id. LinkedIn ids are snowflakes: the
top 41 bits are the millisecond the post was created.

```
https://www.linkedin.com/posts/…-activity-7500139413100740609-4Xw3
7500139413100740609 >> 22  =  1788172581935 ms  =  2026-08-31 10:36:21 UTC
```

That is the date LinkedIn shows for the post, read off the URL alone. The
run asks the engine for a slightly wider window (`tbs=qdr:dN`, two days of
margin) and then makes the exact cut from each id.

### Asks for something: DEMAND, SUPPLY, RECAP

The words that mark a requirement also mark its opposites, and a keyword
search for "corporate training" returns all four of these:

| Post | Intent |
| --- | --- |
| "Urgent corporate trainer requirement – Pune. Share your profile…" | **DEMAND** — kept |
| "I am a certified corporate trainer, available for sessions. If you require…" | SUPPLY — set aside |
| "New batch starts Monday, enrol now, limited seats" | SUPPLY — set aside |
| "Successfully conducted a corporate training at Acme. Thank you for the opportunity" | RECAP — set aside |

Each post is scored on cues for each side, and the **Why** column lists the
cues that fired (`requirement, urgent, share your profile, commercials`, or
`not: introduces self`), so a row can be judged by reading its reason.
Untick *Only posts that ask for something* to keep everything.

### Two doors

- **Through Google, no login** (the default). Every search runs once per
  intent group — `(required OR requirement OR urgent OR needed)` and
  `("looking for" OR hiring OR seeking OR "share your profile")` — because
  one query holding all of them ranks worse and runs into Google's 32-word
  limit. The results are read by the Public web adapter's shape rules, with
  a result being any link to a post instead of a profile.
- **LinkedIn's own post search, from your tab.** The only place a post from
  yesterday can be found before any engine has indexed it. Open LinkedIn
  search → **Posts** → sort by **Latest** → **Past week**, tick **Use the tab
  I'm on**, press Start. The run reads the posts on that page and the ones
  behind "Show more results"; it never opens a post or a profile. The
  account warning at the top of this file applies here.

### What comes back

| Column | Where it comes from |
| --- | --- |
| Posted On / Age (Days) | Decoded from the post id |
| Intent / Score / Why | The classifier, with the cues it saw |
| Author / Author Profile | The result title; the profile link on LinkedIn's own page |
| Author Headline | The line under the author's name on LinkedIn's own page — "HR at Wells Fargo" |
| Post | Title and snippet from the engine; the whole text on LinkedIn's page |
| Emails In Post / Phones In Post | Written in the post text |
| Post URL | The post itself — where a reply goes |
| Set Aside Because | "older than 10 days", "not a requirement post (supply)", "a copy of a newer post" |

One post, one row: the id is the key, so a post found by both doors — and
by both intent groups — is merged, keeping the longer text. A repost carries
a new id but the same text; the newer copy is kept and the older set aside.
Tick **Skip ones I've already downloaded** and a daily run returns only the
posts that are new since yesterday's.

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
npm test          # unit tests — geo, queue, dedupe, parsing, posts, email, verify, health, xlsx, export,
                  # the judge, the email finder, follow-ups and do-not-contact, linking, healing,
                  # the schedule and the PowPow hand-off
npm run test:dom  # browser tests of the DOM wiring (see below)
npm run icons     # regenerate the PNG icons
npm run package   # build the distributable zip
```

`npm run test:dom` runs everything that needs a real browser: the content
script against a synthetic Maps-shaped page (selectors, scroll loop, the
click-into-detail-and-back cycle), the IndexedDB layer against a real database,
the side panel's virtualised lead list — including a check that only a window
of cards is ever in the DOM, and that **Start** is on screen the moment the
panel opens — the LinkedIn adapter against a synthetic page that hydrates
lazily the way the real one does, and the public-web adapter against a
synthetic results page that blends both engines' quirks (a Google anchor
wrapping the site line and the title heading together, a DuckDuckGo `uddg`
redirect, a breadcrumb URL above the title, a profile link in the header, a
challenge page in Bing's wording, and a Next that is a real link to a page
served over the network). It needs a browser:

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
| "Maps moved part of its page … found it again" | A selector stopped matching and `heal.js` found the element by how it looks. The results are fine; update the selector in `docs/SELECTORS.md` anyway. Only elements every search has — the feed, the result links, the Back button — are ever healed. |
| Judge leads is greyed out | It needs the Gemini or Groq key from More options on the Search tab. |
| Lookup says "no credits" or "rejected the API key" | That is the email finder's answer. It stops at the first one rather than failing on every lead; what was found before is kept. |
| PowPow test fails with 401 / 404 | 401: the token differs from `hooks.token`. 404: `hooks.enabled` is off, or the path is not `/hooks/agent`. |
| A scheduled run did not happen | Chrome was closed at that time — it runs when Chrome next starts. |
| The panel does not open | Chrome 116+ is required. Check `chrome://extensions` for a manifest error. |
| LinkedIn: "You are signed out" | Sign in to LinkedIn in that tab and rerun. |
| LinkedIn: "security check" | Solve it in the tab, then rerun — and take it as a signal to slow down. |
| LinkedIn results stop early | The adapter stops if the query or filters change mid-run, rather than blending two searches into one file. |
| LinkedIn cards say "LinkedIn Member" | They are outside your network, and LinkedIn will not name them. The panel says how many; run the same search on the **Public web** source to find those by name. |
| A LinkedIn run exports far fewer rows than the page shows | Check that line. If it accounts for the gap, nothing is broken — LinkedIn withheld those identities. |
| Public web: "asking for a CAPTCHA" | Solve it in the tab, then press Resume. Fewer, slower runs avoid it. |
| Public web: "returned no results for this query" | The engine matched nothing — not a pagination problem. Try the rarer word alone, or a different city spelling. |
| Public web finds far fewer than LinkedIn | Only public, indexed profiles are there at all. It is a different set, not a smaller copy of the same one. |
| Posts: nothing from the last few days | Engines index posts days late. Use LinkedIn's own post search in your tab (see [Two doors](#two-doors)). |
| Posts: a lead was set aside | Open Results and press **Show them** — every set-aside post says why. Untick *Only posts that ask for something* if the classifier is too strict for your search. |

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
- The judge, the email finder and PowPow send lead data to services you chose
  (Gemini or Groq, Apollo or BetterContact, your own gateway). Only what each
  needs is sent — no contact details to the judge, only a profile link to the
  finder — but it does leave your browser.
- Honour opt-outs. The do-not-contact list exists so that "no" is permanent;
  put every opt-out you receive on it.

---

## Licence

MIT — see [LICENSE](LICENSE).
