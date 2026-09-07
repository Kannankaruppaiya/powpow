/**
 * The learned-id table.
 *
 * The property under test is mostly a negative one: that nothing is ever
 * invented. A wrong geoUrn does not throw — it silently searches the wrong
 * city and produces a spreadsheet that looks right, so "miss rather than
 * approximate" is the whole design.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { withSeed, lookup, labelsFor, learn, SEED } from '../src/lib/urns.js';

test('the seeds are only what was seen on a live page', () => {
  assert.equal(lookup(withSeed({}), 'geoUrn', 'India'), '102713980');
  assert.equal(lookup(withSeed({}), 'serviceCategory', 'Corporate Training'), '20016');

  // Two more ids have been observed, but not which label belongs to which.
  // Seeding that inference is the one thing this file must not do.
  const seeded = JSON.stringify(SEED);
  assert.ok(!seeded.includes('101138777'), 'an inferred pairing must not be seeded');
  assert.ok(!seeded.includes('106888327'));
});

test('a label that has never been seen misses, rather than guessing', () => {
  const table = withSeed({});
  assert.equal(lookup(table, 'geoUrn', 'Munnar'), '');
  assert.equal(lookup(table, 'geoUrn', 'Ind'), '', 'a prefix is not a match');
  assert.equal(lookup(table, 'nothing', 'India'), '');
});

test('labels are matched however they were typed', () => {
  const table = withSeed({});
  assert.equal(lookup(table, 'geoUrn', '  india  '), '102713980');
  assert.equal(lookup(table, 'serviceCategory', 'CORPORATE   TRAINING'), '20016');
});

test('an observed pair is remembered', () => {
  const { table, changed } = learn(withSeed({}), [
    { facet: 'geoUrn', label: 'Theni, Tamil Nadu, India', id: '101138777' },
  ]);
  assert.equal(changed, true);
  assert.equal(lookup(table, 'geoUrn', 'Theni, Tamil Nadu, India'), '101138777');
  // And it does not disturb what was already there.
  assert.equal(lookup(table, 'geoUrn', 'India'), '102713980');
});

test('half an observation is not stored', () => {
  const { table, changed } = learn(withSeed({}), [
    { facet: 'geoUrn', label: 'Munnar', id: '' },
    { facet: '', label: 'Munnar', id: '123' },
    { facet: 'geoUrn', label: '', id: '123' },
    null,
  ]);
  assert.equal(changed, false, 'nothing here was a complete pair');
  assert.equal(lookup(table, 'geoUrn', 'Munnar'), '');
});

test('learning the same pair twice is not a change', () => {
  const first = learn(withSeed({}), [{ facet: 'geoUrn', label: 'Theni', id: '101138777' }]);
  const again = learn(first.table, [{ facet: 'geoUrn', label: 'Theni', id: '101138777' }]);
  assert.equal(again.changed, false, 'a run that learned nothing must not write');
});

test('LinkedIn changing an id updates it rather than keeping the stale one', () => {
  const first = learn(withSeed({}), [{ facet: 'geoUrn', label: 'Theni', id: '111' }]);
  const again = learn(first.table, [{ facet: 'geoUrn', label: 'Theni', id: '222' }]);
  assert.equal(again.changed, true);
  assert.equal(lookup(again.table, 'geoUrn', 'Theni'), '222');
});

test('what has been learned is offerable, in reading order', () => {
  const { table } = learn(withSeed({}), [
    { facet: 'geoUrn', label: 'Theni, Tamil Nadu, India', id: '101138777' },
    { facet: 'geoUrn', label: 'Chennai, Tamil Nadu, India', id: '106888327' },
  ]);
  assert.deepEqual(labelsFor(table, 'geoUrn'), [
    'Chennai, Tamil Nadu, India',
    'India',
    'Theni, Tamil Nadu, India',
  ]);
  assert.deepEqual(labelsFor(table, 'never-used'), []);
});
