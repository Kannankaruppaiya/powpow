import test from 'node:test';
import assert from 'node:assert/strict';

import { SOURCES, sourceFor, supportsGrid, buildUrl, DEFAULT_SOURCE } from '../src/lib/sources.js';
import { gatesFor } from '../src/lib/health.js';

test('sourceFor falls back to the default for anything unknown', () => {
  assert.equal(sourceFor('maps').id, 'maps');
  assert.equal(sourceFor('linkedin').id, 'linkedin');
  assert.equal(sourceFor('nonsense').id, DEFAULT_SOURCE);
  assert.equal(sourceFor(undefined).id, DEFAULT_SOURCE);
});

test('only the geographic source supports a grid', () => {
  assert.equal(supportsGrid('maps'), true);
  assert.equal(supportsGrid('linkedin'), false);
});

test('buildUrl produces a real search URL per source', () => {
  assert.match(buildUrl('maps', 'dentists in Chennai'), /google\.com\/maps\/search\//);
  assert.match(
    buildUrl('linkedin', 'java developer'),
    /linkedin\.com\/search\/results\/people\/\?keywords=java%20developer/
  );
});

test('buildUrl ignores a map point where the grid does not apply', () => {
  const url = buildUrl('linkedin', 'java', { lat: 51.5, lng: -0.12, zoom: 14 });
  assert.ok(!url.includes('51.5'), 'coordinates must not leak into a people search');
});

test('buildUrl centres a Maps search on the point it is given', () => {
  assert.match(buildUrl('maps', 'cafes', { lat: 13.0827, lng: 80.2707, zoom: 14 }), /@13\.082700,80\.270700,14z/);
});

test('email enrichment only applies where results have a website', () => {
  assert.equal(SOURCES.maps.supportsEmails, true);
  assert.equal(SOURCES.linkedin.supportsEmails, false, 'people have no site to read an address off');
});

test('each source gates on the fields it always has', () => {
  const maps = gatesFor(SOURCES.maps);
  assert.ok(maps.gates.name > 0 && maps.gates.mapsUrl > 0);

  const linkedin = gatesFor(SOURCES.linkedin);
  assert.ok(linkedin.gates.profileUrl > 0);
  assert.equal(linkedin.gates.mapsUrl, undefined, 'a person has no place link to gate on');
});

test('gatesFor falls back to sane defaults for an unknown source', () => {
  const out = gatesFor(undefined);
  assert.ok(out.gates.name > 0);
  assert.ok(Array.isArray(out.watched) && out.watched.length);
});

test('each source phrases a search the way that site expects', async () => {
  const { buildTerm } = await import('../src/lib/sources.js');
  // Maps reads "in" as natural language and does the right thing.
  assert.equal(buildTerm('maps', 'dentists', 'Chennai'), 'dentists in Chennai');
  // LinkedIn matches keywords literally, so "in" would be hunted for as a word.
  assert.equal(buildTerm('linkedin', 'java developer', 'London'), 'java developer London');
  assert.equal(buildTerm('linkedin', 'java developer', ''), 'java developer');
  assert.equal(buildTerm('maps', 'cafes', ''), 'cafes');
});
