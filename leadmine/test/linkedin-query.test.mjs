import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUrl, buildUrl, partition, dropFromKeywords } from '../src/lib/linkedin-query.js';

// The one real URL. Everything below is measured against it, not against a
// remembered idea of what LinkedIn accepts.
const REAL =
  'https://www.linkedin.com/search/results/people/?keywords=finance%20head%20theni' +
  '&origin=FACETED_SEARCH&geoUrn=%5B%22101138777%22%5D';

test('a real URL parses into the query it stands for', () => {
  assert.deepEqual(parseUrl(REAL), {
    scalars: { keywords: 'finance head theni', origin: 'FACETED_SEARCH' },
    facets: { geoUrn: ['101138777'] },
    order: ['keywords', 'origin', 'geoUrn'],
  });
});

test('and building it back gives the same URL, byte for byte', () => {
  assert.equal(buildUrl(parseUrl(REAL)), REAL);
});

// A second real one: the same search with two locations ticked.
const REAL_TWO =
  'https://www.linkedin.com/search/results/people/?keywords=finance%20head%20theni' +
  '&origin=FACETED_SEARCH&geoUrn=%5B%22101138777%22%2C%22106888327%22%5D';

test('two locations in one facet, from the real page', () => {
  const q = parseUrl(REAL_TWO);
  assert.deepEqual(q.facets.geoUrn, ['101138777', '106888327']);
  assert.equal(q.scalars.keywords, 'finance head theni');
  assert.equal(buildUrl(q), REAL_TWO, 'and back out byte for byte');
});

test('a two-location search splits into two single-location searches', () => {
  // Which is the point: one search stops after a fixed number of pages, so
  // two places in one search share that ceiling instead of getting one each.
  const q = parseUrl(REAL_TWO);
  const urls = partition(q, 'geoUrn', q.facets.geoUrn).map((one) => buildUrl(one));
  assert.equal(urls.length, 2);
  assert.match(urls[0], /geoUrn=%5B%22101138777%22%5D/);
  assert.match(urls[1], /geoUrn=%5B%22106888327%22%5D/);
  assert.ok(urls.every((u) => u.includes('keywords=finance%20head%20theni')));
});

// A third real one: a different facet entirely, alongside the first.
const REAL_SERVICE =
  'https://www.linkedin.com/search/results/people/?keywords=kotlin%20' +
  '&origin=FACETED_SEARCH&geoUrn=%5B%22102713980%22%5D&serviceCategory=%5B%2220016%22%5D';

test('a facet this code has never been told about needs no code', () => {
  // Only geoUrn was known when this was written. serviceCategory arrived
  // later and cost nothing, because what is modelled here is the encoding,
  // not a list of facet names.
  const q = parseUrl(REAL_SERVICE);
  assert.deepEqual(q.facets.geoUrn, ['102713980']);
  assert.deepEqual(q.facets.serviceCategory, ['20016']);
  assert.equal(q.scalars.keywords, 'kotlin ', 'even the trailing space survives');
  assert.equal(buildUrl(q), REAL_SERVICE);
});

test('a query built from nothing encodes the way LinkedIn does', () => {
  const url = buildUrl({
    scalars: { keywords: 'finance head', origin: 'FACETED_SEARCH' },
    facets: { geoUrn: ['101138777'] },
  });
  assert.match(url, /keywords=finance%20head/, 'spaces are %20, not +');
  assert.match(url, /geoUrn=%5B%22101138777%22%5D/, 'a facet is an encoded JSON array');
});

test('several values in one facet, and several facets at once', () => {
  const url = buildUrl({
    scalars: { keywords: 'finance head' },
    facets: { geoUrn: ['101138777', '102784390'], network: ['S', 'O'] },
  });
  const back = parseUrl(url);
  assert.deepEqual(back.facets.geoUrn, ['101138777', '102784390']);
  assert.deepEqual(back.facets.network, ['S', 'O']);
});

test('a rebuilt URL keeps the page’s own parameter order', () => {
  // Not cosmetic: this codec reads a search, changes one thing and runs it
  // again, so everything it did not touch has to come back untouched.
  const shuffled =
    'https://www.linkedin.com/search/results/people/?geoUrn=%5B%22101138777%22%5D' +
    '&sid=abc&keywords=finance%20head';
  assert.equal(buildUrl(parseUrl(shuffled)), shuffled);
});

test('a parameter this code has never seen still survives the trip', () => {
  // Only geoUrn was ever observed. Everything else must pass through rather
  // than be dropped by a guess about which names are real.
  const odd = `${REAL}&somethingNew=%5B%22abc%22%5D&sid=xyz`;
  assert.equal(buildUrl(parseUrl(odd)), odd);
  assert.deepEqual(parseUrl(odd).facets.somethingNew, ['abc']);
});

test('one search becomes one search per city', () => {
  const base = parseUrl(REAL);
  const urls = partition(base, 'geoUrn', ['101138777', '102784390', '106402362']).map((q) =>
    buildUrl(q)
  );
  assert.equal(urls.length, 3);
  assert.ok(urls.every((u) => u.includes('keywords=finance%20head%20theni')), 'same search');
  assert.equal(new Set(urls).size, 3, 'three different places');
  assert.match(urls[1], /geoUrn=%5B%22102784390%22%5D/);
});

test('the place comes out of the keywords once a facet carries it', () => {
  const q = dropFromKeywords(parseUrl(REAL), ['theni', 'Tamil Nadu']);
  assert.equal(q.scalars.keywords, 'finance head');
  // And the facet is untouched — the filter is still there, only the
  // accidental second filter is gone.
  assert.deepEqual(q.facets.geoUrn, ['101138777']);
});

test('dropping a word that is not there changes nothing', () => {
  const q = dropFromKeywords(parseUrl(REAL), ['Chennai']);
  assert.equal(q.scalars.keywords, 'finance head theni');
});

/*
 * Paging, against the URLs LinkedIn actually produced during a live session —
 * not invented ones. Each was read off the address bar while paging by hand.
 */
const REAL_PAGED = [
  'https://www.linkedin.com/search/results/people/?keywords=kotlin',
  'https://www.linkedin.com/search/results/people/?keywords=kotlin%20chennai&page=2&spellCorrectionEnabled=true&prioritizeMessage=false',
  'https://www.linkedin.com/search/results/people/?keywords=QA%20automation%20engineer&origin=SWITCH_SEARCH_VERTICAL',
  'https://www.linkedin.com/search/results/people/?keywords=playwright%20Typescript&origin=FACETED_SEARCH&geoUrn=%5B%22102713980%22%5D&serviceCategory=%5B%2220016%22%5D',
];

test('page one carries no page param, the way LinkedIn writes it', async () => {
  const { pageOf, pageUrl } = await import('../src/lib/linkedin-query.js');
  assert.equal(pageOf('https://www.linkedin.com/search/results/people/?keywords=kotlin'), 1);
  assert.equal(pageOf(REAL_PAGED[1]), 2);
  // Going back to one removes it rather than writing page=1.
  assert.ok(!pageUrl(REAL_PAGED[1], 1).includes('page='));
});

test('a page is reached by arithmetic, not by clicking through to it', async () => {
  const { pageUrl, pageOf } = await import('../src/lib/linkedin-query.js');
  for (const url of REAL_PAGED) {
    // Page seven directly — no walk through six, no Next button anywhere.
    const seven = pageUrl(url, 7);
    assert.equal(pageOf(seven), 7, seven);
  }
});

test('paging keeps every filter and parameter the search had', async () => {
  const { pageUrl, parseUrl } = await import('../src/lib/linkedin-query.js');
  for (const url of REAL_PAGED) {
    const before = parseUrl(url);
    const after = parseUrl(pageUrl(url, 7));
    // A location filter dropped by paging would hand back the right number of
    // the wrong people, and nothing would error.
    assert.deepEqual(after.facets, before.facets, url);
    for (const [key, value] of Object.entries(before.scalars)) {
      if (key !== 'page') assert.equal(after.scalars[key], value, `${key} lost from ${url}`);
    }
  }
});

test('the spaces stay %20 when paging, as they must', async () => {
  const { pageUrl } = await import('../src/lib/linkedin-query.js');
  const out = pageUrl(REAL_PAGED[1], 3);
  assert.ok(out.includes('keywords=kotlin%20chennai'), out);
  assert.ok(!out.includes('+'), out);
});
