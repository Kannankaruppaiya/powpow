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
