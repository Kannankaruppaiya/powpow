# Selectors: what breaks, and how to fix it

Google ships Maps with minified, rotating class names. `div.Nv2PK` and
`span.MW4etd` are build artefacts — they change without notice and take the
scraper with them.

Everything the content script matches on lives in the `SEL` object at the top of
`src/content/scraper.js`. Fix it there and nothing else needs touching.

## The stability ladder

Prefer selectors from the top of this list. The scraper already does, falling
back down the ladder only when it has to.

**1. `data-item-id` — the most stable thing in the Maps DOM.**
These are semantic identifiers, not build output, and they have survived years
of redesigns:

| Selector | Field |
| --- | --- |
| `button[data-item-id="address"]` | Full address |
| `button[data-item-id^="phone:tel:"]` | Phone — the attribute *is* the number, e.g. `phone:tel:+914423456789` |
| `a[data-item-id="authority"]` | Website |
| `button[data-item-id="oloc"]` | Plus code |

Fields without a `data-item-id` fall back to ARIA:
`[aria-label*="Hours"]` (the whole week, semicolon separated),
`[aria-label*="Price"]`, and a "Claim this business" link, whose *presence*
means the listing is unclaimed.

Reading the phone out of the attribute rather than the button text is
deliberate: the text is formatted for display and varies by locale, the
attribute is E.164.

**2. ARIA and roles.** `div[role="feed"]` for the results list,
`div[role="main"]` for the panel, `span[role="img"][aria-label]` for the star
rating. These carry accessibility guarantees, so Google has a reason to keep
them.

**3. Semantic HTML.** `h1` for the business name in the detail panel,
`a[href*="/maps/place/"]` for a result card's link.

**4. Hashed classes — last resort only.** `div.W4Efsd`, `span.MW4etd`,
`div.F7nice`, `div.qBF1Pd`. These appear only as secondary options behind a
comma in a selector list. If one stops matching, the field degrades; it does
not crash the run.

## The map centre in the URL

`src/lib/geo.js` reads `@lat,lng,zoom` out of the tab's URL — Maps writes its
own viewport there once results settle, and that is where the grid search gets
its coordinates. It is a URL format, not a DOM selector, but it breaks the same
way: if `parseMapUrl` starts returning `null`, grid coverage silently drops to
one search per term and the run reports "Could not read the map centre". Check
what the URL actually looks like before assuming the scraper is at fault; the
altitude form (`,1500m`) is already handled alongside the zoom form (`,12z`).

## Why the search URL forces `hl=en`

`buildSearchUrl()` in the service worker appends `?hl=en`. Several aria-labels
are parsed for their English prefix — `"Address: …"`, `"Phone: …"`,
`"4.5 stars 128 Reviews"`. Without the language pin, a user with a non-English
Google locale silently gets empty ratings and unparsed addresses.

If you add locales, extend `parseRatingLabel` and the prefix strips in
`extractDetailPanel` rather than dropping `hl=en`.

## Diagnosing a break

1. Open a Maps search, then DevTools on that tab.
2. Check what still matches:

   ```js
   document.querySelectorAll('div[role="feed"]').length          // 1 expected
   document.querySelectorAll('a[href*="/maps/place/"]').length   // one per card
   ```

3. Click a listing and check the panel:

   ```js
   [...document.querySelectorAll('[data-item-id]')].map((e) => e.dataset.itemId)
   ```

   If `address`, `phone:tel:…` and `authority` are gone, Google has changed
   something significant; find the new hooks and update `SEL`.

4. Reproduce your fix in the test fixture before trusting it:

   ```bash
   npm run test:dom
   ```

   The fixture in `test/dom.e2e.mjs` mirrors the Maps structure. Update it to
   match the new DOM, watch the test fail, then fix `SEL` until it passes.

## Two failure modes to keep apart

- **A selector matched nothing.** The field comes back as `''`. The run
  continues and the other columns are still good. This is the intended
  degradation.
- **`div[role="feed"]` matched nothing.** There is no list to walk, so the run
  stops with "No results list found on this page." That message means the page
  shape changed, the tab is not on a results page, or a consent screen is up.

The scraper never throws on a missing field. If you add extraction, keep that
property — a partial row is worth far more than a failed run.


## LinkedIn selectors

The same ladder applies, with one extra hazard: LinkedIn hydrates its result
list lazily. An `<li>` can exist with no content at all, so *absence of a
profile link is not a broken selector* — it means that card has not rendered
yet. The adapter treats it as "not ready" and picks it up on a later round;
never "fix" that by loosening the check.

Ranked by stability:

| Selector | Field | Why |
| --- | --- | --- |
| `a[href*="/in/"]` | Identity | The profile URL is the one thing that cannot change shape |
| `item.innerText` lines | Name, headline, location, degree, "Current:" | See below — every class-named extractor written for this card has been broken by LinkedIn within weeks |
| `[class*="open-to-work"]`, `img[alt*="open to work"]` | Open to work | Best effort — it is a photo frame, not text |
| `img[src*="licdn"]` | Photo | The CDN host outlives any class name |

### Why the fields come off innerText, not selectors

**The whole card now sits inside the `/in/` anchor.** A user's export caught
this: the Name column held the entire card with the person's name printed
twice, and Headline, Company, Location and Connection were all empty. Two
faults, one cause — every `.entity-result__*` selector missed, so extraction
fell through to reading the anchor's text, and the anchor *is* the card.

So fields are read from the card's rendered lines and their order:

- The **name** is the first line. LinkedIn prints it twice — once visible, once
  for assistive tech — in adjacent inline spans, which `innerText` joins into
  one line with *no separator*: `Priya SharmaPriya Sharma`. The second copy is
  sometimes link text instead (`View Anubha Goel's profile`). Both are undone
  before the line is used, and dropping repeated *lines* does not catch either.
- The **location** is recognised by shape, not position: short, two to four
  comma-separated parts, none longer than 32 characters, no `| @ : /`. That
  test is what keeps `Technical Corporate Trainer|C,C++,Java FSD,Python FSD,DSA`
  out of the Location column despite its commas.
- The **headline** is the first remaining line that is not the degree badge,
  the location, a `Current:`/`Past:` context line or the mutual-connection
  footer.
- The **company** comes from the `Current:` line first and the headline second,
  because a headline often has no employer in it at all. If neither yields one,
  the column stays empty rather than guessing.

Buttons (`Connect`, `Message`, `Follow`) and follower counts are dropped as
chrome before any of this runs.

`readFilters()` deliberately reads two sources and merges them: the pills in
the filter bar (via `aria-pressed` and `aria-label`) and the URL's own facet
parameters. Neither alone is complete, and neither is ever hardcoded to a list
of expected filters — whatever the user applied is what gets reported.

### The search fingerprint

Maps is driven by the extension, so the query cannot drift. LinkedIn is driven
by the *user*, who can retype the search or change a filter while a run is
going. `fingerprint()` is checked every round; if it changes, the run stops
rather than blending two different searches into one export.

**It must never be built from the whole URL.** It was, once — every query
parameter except a four-item denylist — and that is what capped every run at
exactly 20 profiles. LinkedIn rewrites its own URL as you page, appending
tracking and session parameters (`searchId`, `heroEntityKey` and friends). The
fingerprint changed on its own at page two, the adapter concluded the user had
changed the search, and the run ended reporting *"the source said there are no
more"* — a sentence about LinkedIn describing a decision this file had made.

Two rules came out of that:

- The fingerprint reads **keywords, an allowlist of real facet parameters
  (`FACET_PARAMS`), and the applied filter pills**. An allowlist fails in the
  right direction: a parameter nobody has heard of cannot end a run. At worst
  an unknown facet edit goes unnoticed, and the pills catch most of those.
- When an adapter stops for a reason of its own it says so, through
  `endReason`. "The source said there are no more" is reserved for the source
  actually saying it.

A denylist cannot work here. It has to be complete to be correct, and it is
competing with a site that adds parameters whenever it likes.


## LinkedIn pagination

Two things broke a live run here, and both are worth knowing before touching
this code.

**`window.scrollTo` is a guess that the page scrolls.** When the results sit in
their own scrollable panel it does nothing, and the lazy list never hydrates
past the first screenful. `scrollToEnd()` scrolls the window *and* the nearest
scrolling ancestor of the list.

**The list node does not survive paging.** LinkedIn replaces the results
wholesale, so a container captured on page one is detached on page two and
reports zero results — which looks exactly like reaching the end. The engine
re-resolves a detached container each round (`container.isConnected === false`),
and the adapter's `liveList()` does the same for any node handed to it. If a
run stops at exactly one page, suspect this first.

**`button[aria-label="Next"]` matched nothing.** The control is now found by
what it says — `aria-label` or text matching "next", and also "show more
results" / "see more results", because LinkedIn ships both a numbered
pagination layout and a list that grows behind a button. A pagination
container is a *hint about where to look first*, never a restriction: scoping
the search to it meant that if any other element happened to carry a
"pagination" class, the real button was invisible. After clicking it the adapter waits for
the *first result to change* rather than sleeping, because a fixed delay is
either too short on a slow connection or wasted on a fast one.

**A run that stops early now says why.** The engine records which of its four
exits it took — the row limit, the source reporting no more, four rounds adding
nothing, or no next page — and the panel prints it under the search line
("stopped because there was no next page"). A LinkedIn run that ends at 20 rows
with a limit of 100 is not self-explanatory otherwise.

Exhaustion is `loadMore`'s decision alone. `reachedEnd()` deliberately returns
false except when the search fingerprint changes: the absence of a Next button
does not mean the current page has finished hydrating, and treating it that way
truncated the last cards of every final page.
