/**
 * What a search already returned, so it is never paid for twice.
 *
 * A LinkedIn search costs part of a monthly allowance — roughly 300 of them,
 * after which LinkedIn returns three results per query and anonymises the
 * rest. A month's worth went in eight days, and most of it went on running
 * the *same* searches again: a run that stops early is re-run, a filter is
 * adjusted and the whole thing repeats from page one.
 *
 * None of those repeats needed to touch LinkedIn. The results were already on
 * disk. This keys them by what the search actually is, so a repeat is free
 * and only going deeper than last time costs anything.
 */

import { parseUrl } from './linkedin-query.js';

/*
 * Everything a URL carries that is not the question being asked.
 *
 * `page` is where you are in the answer, not part of it. The rest is
 * provenance LinkedIn writes for its own analytics — which panel you came
 * from, which session, whether it corrected your spelling — and it changes
 * between two runs of the identical search. Keyed on the raw URL, no repeat
 * would ever hit the cache.
 */
const NOISE = new Set([
  'page',
  'origin',
  'searchId',
  'sid',
  'trk',
  'heroEntityKey',
  'spellCorrectionEnabled',
  'prioritizeMessage',
  'position',
  'searchSessionId',
]);

/**
 * The identity of a search: its keywords and its filters, nothing else.
 *
 * Facets are sorted, and so are the values inside them, because "these two
 * places" is the same question whichever order they were typed in.
 */
export function cacheKey(href) {
  let query;
  try {
    query = parseUrl(href);
  } catch {
    return '';
  }

  const parts = [];
  for (const [key, value] of Object.entries(query.scalars)) {
    if (!NOISE.has(key) && String(value).trim()) parts.push(`${key}=${String(value).trim().toLowerCase()}`);
  }
  for (const [key, values] of Object.entries(query.facets)) {
    if (NOISE.has(key)) continue;
    parts.push(`${key}=[${[...values].map(String).sort().join(',')}]`);
  }
  parts.sort();
  return parts.length ? `search:${parts.join('&')}` : '';
}

/** A day in milliseconds, so the ages below read as what they are. */
const DAY = 24 * 60 * 60 * 1000;

/**
 * Is this page's answer still worth serving?
 *
 * People change jobs and join LinkedIn, so an old answer drifts. A week is
 * long enough that a fortnight of iterating on one search costs one search,
 * and short enough that a list acted on is not a list from last month.
 *
 * Age is kept per page, not per entry. One timestamp for the whole search
 * meant that fetching a single new deep page reset the age of everything
 * already held — page one could be a month old while the entry reported
 * itself as fresh.
 */
export function isFresh(page, now = Date.now(), maxAgeDays = 7) {
  return Boolean(page) && Number.isFinite(page.when) && now - page.when < maxAgeDays * DAY;
}

/** An entry holding nothing. */
export const emptyEntry = () => ({ pages: {} });

/**
 * Fold one page's results into an entry.
 *
 * Called only once a page has actually been read. Marking a page as held the
 * moment it is navigated to would let a failed scrape — or a cancel — record
 * a page whose people were never collected, and the next run would skip it
 * for good; repeated failures would walk the depth to the end while storing
 * nobody.
 */
export function absorb(entry, page, records, now = Date.now()) {
  const pages = (entry && entry.pages) || {};
  const n = Number(page);
  if (!Number.isFinite(n) || n < 1) return { pages };
  return { pages: { ...pages, [n]: { when: now, records: Array.isArray(records) ? records : [] } } };
}

/**
 * How many pages an entry holds, unbroken and still fresh, from page one.
 *
 * A gap matters: pages 1, 2 and 7 are not seven pages, and resuming at eight
 * would leave three of them permanently unvisited. A stale page is a gap for
 * the same reason.
 */
export function depthOf(entry, now = Date.now(), maxAgeDays = 7) {
  const pages = (entry && entry.pages) || {};
  let depth = 0;
  while (isFresh(pages[depth + 1], now, maxAgeDays)) depth += 1;
  return depth;
}

/**
 * What still has to be fetched, given what is already held.
 *
 * Returns the first page to ask LinkedIn for and the records to start from.
 * A cache that already reaches the wanted depth costs nothing at all — and
 * `have` is exactly the pages being reused, never the deeper ones, so asking
 * for fewer pages than last time really does return fewer people.
 */
export function planFrom(entry, wantPages, now = Date.now(), maxAgeDays = 7) {
  const reused = Math.min(depthOf(entry, now, maxAgeDays), Math.max(0, wantPages));
  const have = [];
  for (let page = 1; page <= reused; page += 1) have.push(...entry.pages[page].records);
  return { from: reused + 1, have, reused };
}
