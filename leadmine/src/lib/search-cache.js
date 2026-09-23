/** What a search already returned, so it is never paid for twice. */

import { parseUrl } from './linkedin-query.js';

// Everything a URL carries that is not the question being asked.
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

/** The identity of a search: its keywords and its filters, nothing else. */
export function cacheKey(href) {
  let query;
  let vertical = '';
  try {
    query = parseUrl(href);
    // Which kind of search.
    const match = new URL(href).pathname.match(/\/search\/results\/([^/]+)/);
    vertical = match && match[1] !== 'people' ? match[1] : '';
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
  if (!parts.length) return '';
  return vertical ? `search/${vertical}:${parts.join('&')}` : `search:${parts.join('&')}`;
}

/** A day in milliseconds, so the ages below read as what they are. */
const DAY = 24 * 60 * 60 * 1000;

/** Is this page's answer still worth serving? */
export function isFresh(page, now = Date.now(), maxAgeDays = 7) {
  return Boolean(page) && Number.isFinite(page.when) && now - page.when < maxAgeDays * DAY;
}

/** An entry holding nothing. */
export const emptyEntry = () => ({ pages: {} });

/** Fold one page's results into an entry. */
export function absorb(entry, page, records, now = Date.now()) {
  const pages = (entry && entry.pages) || {};
  // Everything else the entry knows — where the search ends — survives a new page.
  const rest = { ...(entry || {}) };
  delete rest.pages;
  const n = Number(page);
  if (!Number.isFinite(n) || n < 1) return { ...rest, pages };
  return { ...rest, pages: { ...pages, [n]: { when: now, records: Array.isArray(records) ? records : [] } } };
}

/** Record that a search has no results past `lastPage`. */
export function markEnd(entry, lastPage) {
  const n = Number(lastPage);
  const base = entry || emptyEntry();
  if (!Number.isFinite(n) || n < 1) return base;
  return { ...base, end: n };
}

/** Forget a recorded end: a page past it turned out to have people on it. */
export function clearEnd(entry) {
  if (!entry || entry.end === undefined) return entry;
  const next = { ...entry };
  delete next.end;
  return next;
}

/** How many pages an entry holds, unbroken and still fresh, from page one. */
export function depthOf(entry, now = Date.now(), maxAgeDays = 7) {
  const pages = (entry && entry.pages) || {};
  let depth = 0;
  while (isFresh(pages[depth + 1], now, maxAgeDays)) depth += 1;
  return depth;
}

/** What still has to be fetched, given what is already held. */
export function planFrom(entry, wantPages, now = Date.now(), maxAgeDays = 7) {
  const depth = depthOf(entry, now, maxAgeDays);
  const reused = Math.min(depth, Math.max(0, wantPages));
  const have = [];
  for (let page = 1; page <= reused; page += 1) have.push(...entry.pages[page].records);
  // The whole search is held.
  const end = Number(entry && entry.end);
  const complete = Number.isFinite(end) && end >= 1 && depth >= end;
  return { from: reused + 1, have, reused, complete };
}
