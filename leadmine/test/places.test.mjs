/**
 * The "Where?" picker's lists, and the data behind them.
 *
 * Two things are being checked, and the second matters as much as the first:
 * the functions that shape a list, and the *generated data* they shape. The
 * data is committed rather than fetched, so nothing else would notice if a
 * rebuild dropped half the world.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { citiesFor, regionsFor, CITY_LIMIT } from '../src/lib/places.js';

const GEO = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'geo');
const read = (name) => JSON.parse(readFileSync(join(GEO, name), 'utf8'));

const countries = read('countries.json');
const india = read('IN.json');

test('every country in the index has a file to open', () => {
  const files = new Set(readdirSync(GEO));
  assert.ok(countries.length > 200, `expected the world, got ${countries.length} countries`);
  for (const country of countries) {
    assert.match(country.c, /^[A-Z]{2}$/, `${country.n} needs an ISO code`);
    assert.ok(country.n, 'a country with no name cannot be offered');
    assert.ok(files.has(`${country.c}.json`), `no data file for ${country.n}`);
  }
});

test('the index is in reading order, not byte order', () => {
  const names = countries.map((c) => c.n);
  const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  assert.deepEqual(names, sorted);
});

test('a country file carries its states and their towns', () => {
  assert.equal(india.n, 'India');
  const names = regionsFor(india);
  assert.ok(names.includes('Tamil Nadu'), 'Tamil Nadu is missing from India');
  assert.ok(names.includes('Kerala'));
  assert.ok(names.length > 25, `expected the states and union territories, got ${names.length}`);

  const towns = citiesFor(india, 'Tamil Nadu', { source: 'linkedin' });
  assert.ok(towns.includes('Chennai'));
  assert.ok(towns.includes('Coimbatore'));
});

test('a town is offered exactly as it will be searched', () => {
  // Maps: "dentists in Springfield" is a question with twenty answers.
  const maps = citiesFor(india, 'Tamil Nadu');
  assert.ok(maps.includes('Chennai, Tamil Nadu'));

  // LinkedIn matches keywords literally, and no profile says "Tamil Nadu"
  // just because the person is in Chennai.
  const linkedin = citiesFor(india, 'Tamil Nadu', { source: 'linkedin' });
  assert.ok(linkedin.includes('Chennai'));
  assert.ok(!linkedin.some((name) => name.includes(',')));
});

test('no state offers the same town twice', () => {
  for (const region of india.s) {
    const lower = region.c.map((name) => name.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, `${region.n} lists a town twice`);
  }
});

test('a whole country is capped, and the cap is the only thing that truncates', () => {
  const all = citiesFor(india, '');
  assert.equal(all.length, CITY_LIMIT, 'India has more towns than anyone will scroll');

  const small = citiesFor(india, '', { limit: 5 });
  assert.equal(small.length, 5);

  // Several states concatenated are not sorted by accident.
  const merged = citiesFor(india, '', { limit: 200, source: 'linkedin' });
  assert.deepEqual(merged, [...merged].sort((a, b) => a.localeCompare(b, 'en')));
});

test('a missing or state-less country yields nothing rather than throwing', () => {
  assert.deepEqual(regionsFor(null), []);
  assert.deepEqual(citiesFor(null, 'Anywhere'), []);
  assert.deepEqual(citiesFor({ n: 'Nowhere' }, ''), []);
});

test('a state that is not in this country is not silently searched', () => {
  // Picking India → Tamil Nadu and then switching to Singapore must not leave
  // Tamil Nadu selected, and asking for it anyway must return nothing.
  const singapore = read('SG.json');
  assert.deepEqual(citiesFor(singapore, 'Tamil Nadu'), []);
});
