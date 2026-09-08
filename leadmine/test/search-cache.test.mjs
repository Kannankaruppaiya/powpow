/**
 * The search cache, keyed on what a search actually is.
 *
 * Every URL below was read off the live site during one session, including
 * the noise LinkedIn appends to it. Two runs of the identical search produce
 * different URLs, which is exactly why the raw URL cannot be the key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { cacheKey, isFresh, planFrom, absorb, depthOf, emptyEntry } from '../src/lib/search-cache.js';

const PLAIN = 'https://www.linkedin.com/search/results/people/?keywords=kotlin%20chennai';
const NOISY =
  'https://www.linkedin.com/search/results/people/?keywords=kotlin%20chennai&page=9&spellCorrectionEnabled=true&prioritizeMessage=false';
const FACETED =
  'https://www.linkedin.com/search/results/people/?keywords=playwright%20Typescript&origin=FACETED_SEARCH&geoUrn=%5B%22102713980%22%5D&serviceCategory=%5B%2220016%22%5D';

test('the same search on a different page is the same search', () => {
  // Page is where you are in the answer, not part of the question.
  assert.equal(cacheKey(PLAIN), cacheKey(NOISY));
});

test('LinkedIn’s own tracking parameters are not part of the question', () => {
  // origin, searchId, spellCorrectionEnabled and the rest change between two
  // runs of the identical search. Keyed on the raw URL, no repeat would ever
  // hit the cache.
  const withTracking = `${PLAIN}&origin=SWITCH_SEARCH_VERTICAL&searchId=1788&heroEntityKey=urn%3Ali%3Afsd_profile%3AABC`;
  assert.equal(cacheKey(withTracking), cacheKey(PLAIN));
});

test('a different filter is a different search', () => {
  // The whole risk of a cache: serving one search's answer for another. A
  // location filter is the difference between Chennai and the country.
  assert.notEqual(cacheKey(FACETED), cacheKey(PLAIN));
  const other = FACETED.replace('102713980', '101138777');
  assert.notEqual(cacheKey(FACETED), cacheKey(other), 'two places share a key');
});

test('the order two places were typed in does not make a new search', () => {
  const a = 'https://www.linkedin.com/search/results/people/?keywords=x&geoUrn=%5B%22101138777%22%2C%22106888327%22%5D';
  const b = 'https://www.linkedin.com/search/results/people/?keywords=x&geoUrn=%5B%22106888327%22%2C%22101138777%22%5D';
  assert.equal(cacheKey(a), cacheKey(b));
});

test('a search with nothing in it is not cached', () => {
  assert.equal(cacheKey('https://www.linkedin.com/search/results/people/'), '');
  assert.equal(cacheKey('not a url'), '');
});

test('an old answer is not served as a fresh one', () => {
  const now = Date.now();
  assert.equal(isFresh({ when: now - 2 * 86400000 }, now), true);
  assert.equal(isFresh({ when: now - 9 * 86400000 }, now), false);
  assert.equal(isFresh(null, now), false);
  assert.equal(isFresh({}, now), false, 'a page with no timestamp is not fresh');
});

test('each page ages on its own, not on the entry', () => {
  const now = Date.now();
  // Fetching one new deep page used to reset the age of everything already
  // held: page one could be a month old while the entry called itself fresh.
  let entry = absorb(emptyEntry(), 1, [{ name: 'old' }], now - 30 * 86400000);
  entry = absorb(entry, 2, [{ name: 'new' }], now);
  assert.equal(depthOf(entry, now), 0, 'a stale page one still counted as depth');
  assert.equal(planFrom(entry, 5, now).from, 1, 'the run must go back for page one');
});

/** An entry holding `pages` pages, one person each. */
function held(pages, now) {
  let entry = emptyEntry();
  for (let page = 1; page <= pages; page += 1) entry = absorb(entry, page, [{ name: `p${page}` }], now);
  return entry;
}

test('a repeat of the same depth costs no search at all', () => {
  const now = Date.now();
  const plan = planFrom(held(10, now), 10, now);
  assert.equal(plan.from, 11, 'nothing left to fetch, so the loop starts past the end');
  assert.equal(plan.reused, 10);
  assert.equal(plan.have.length, 10);
});

test('going deeper than last time pays only for the difference', () => {
  const now = Date.now();
  const plan = planFrom(held(4, now), 10, now);
  assert.equal(plan.from, 5, 'pages one to four are already held');
  assert.equal(plan.reused, 4);
});

test('a stale answer is re-fetched from the first page', () => {
  const now = Date.now();
  const plan = planFrom(held(10, now - 30 * 86400000), 10, now);
  assert.equal(plan.from, 1);
  assert.equal(plan.have.length, 0, 'stale records must not be mixed into a fresh run');
});

/*
 * The parts a source-text assertion cannot reach: what actually happens to an
 * entry as pages arrive, fail, or arrive out of order.
 */

test('a page is only held once its records have arrived', () => {
  const now = Date.now();
  // A scrape that failed hands back nothing. The page is recorded as empty
  // rather than not at all — it was fetched and it was genuinely empty, and
  // paying for it twice helps nobody — but a page never passed to absorb is
  // never held.
  const entry = absorb(emptyEntry(), 1, [{ name: 'a' }], now);
  assert.equal(depthOf(entry), 1);
  assert.equal(depthOf(absorb(entry, 'not a page', [{}], now)), 1, 'a bad page number must not extend the depth');
});

test('a gap in the pages is not depth', () => {
  const now = Date.now();
  // Pages 1, 2 and 7 are not seven pages. Resuming at eight would leave
  // three of them permanently unvisited, and nothing would ever say so.
  let entry = absorb(emptyEntry(), 1, [{ name: 'a' }], now);
  entry = absorb(entry, 2, [{ name: 'b' }], now);
  entry = absorb(entry, 7, [{ name: 'g' }], now);
  assert.equal(depthOf(entry), 2);
  assert.equal(planFrom(entry, 10, now).from, 3, 'the run must resume at the gap');
});

test('asking for fewer pages than are held returns fewer people', () => {
  const now = Date.now();
  let entry = emptyEntry();
  for (let page = 1; page <= 5; page += 1) entry = absorb(entry, page, [{ name: `p${page}` }], now);

  const shallow = planFrom(entry, 2, now);
  assert.equal(shallow.reused, 2);
  assert.deepEqual(shallow.have.map((r) => r.name), ['p1', 'p2'], 'deeper pages leaked into a shallower run');

  const deep = planFrom(entry, 5, now);
  assert.equal(deep.have.length, 5);
});

test('a month-old page is never served alongside a fresh one', () => {
  const now = Date.now();
  const old = absorb(emptyEntry(), 1, [{ name: 'last month' }], now - 30 * 86400000);
  const fresh = absorb(old, 2, [{ name: 'today' }], now);
  const plan = planFrom(fresh, 5, now);
  assert.equal(plan.reused, 0);
  assert.deepEqual(plan.have, [], 'a month-old page was handed back as this run’s answer');
});
