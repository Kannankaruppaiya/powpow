import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fieldRates,
  assessHealth,
  describeBreaches,
  summariseRates,
  DEFAULT_GATES,
  MIN_SAMPLE,
} from '../src/lib/health.js';

const good = (n, overrides = {}) =>
  Array.from({ length: n }, (_, i) => ({
    name: `Business ${i}`,
    mapsUrl: `https://maps.google.com/?cid=${i}`,
    category: 'Dental clinic',
    address: `${i} Some Road`,
    phone: i % 2 ? '044 1111 1111' : '', // half have a phone, which is normal
    rating: '4.5',
    website: '',
    ...overrides,
  }));

test('fieldRates measures how often each field came back', () => {
  const rates = fieldRates(good(10));
  assert.equal(rates.name, 1);
  assert.equal(rates.phone, 0.5);
  assert.equal(rates.website, 0);
});

test('fieldRates treats empty strings and empty arrays as missing', () => {
  const rates = fieldRates([{ name: '   ', allEmails: [] }], ['name', 'allEmails']);
  assert.equal(rates.name, 0);
  assert.equal(rates.allEmails, 0);
});

test('fieldRates on no records reports zero rather than dividing by zero', () => {
  const rates = fieldRates([], ['name']);
  assert.equal(rates.name, 0);
  assert.ok(Number.isFinite(rates.name));
});

test('a healthy run passes and reports its rates', () => {
  const health = assessHealth(good(50));
  assert.equal(health.ok, true);
  assert.deepEqual(health.breaches, []);
  assert.equal(health.rates.name, 1);
});

test('a broken name selector stops the run', () => {
  // What a Maps redesign looks like: everything else fine, names all blank.
  const health = assessHealth(good(50, { name: '' }));
  assert.equal(health.ok, false);
  assert.equal(health.breaches.length, 1);
  assert.equal(health.breaches[0].field, 'name');
  assert.match(health.reason, /name found in only 0%/);
});

test('a missing phone number never stops a run', () => {
  // Plenty of real businesses publish no phone; that is data, not a fault.
  const health = assessHealth(good(50, { phone: '' }));
  assert.equal(health.ok, true);
  assert.equal(health.rates.phone, 0);
});

test('a small sample is never judged', () => {
  const health = assessHealth(good(MIN_SAMPLE - 1, { name: '' }));
  assert.equal(health.ok, true, 'four dentists in a village must not trip the gate');
  assert.match(health.reason, /sample too small/);
});

test('the gate tolerates a few genuinely nameless listings', () => {
  const records = good(100);
  for (let i = 0; i < 5; i += 1) records[i].name = '';
  assert.equal(assessHealth(records).ok, true, '95% is above the 90% gate');
});

test('the gate trips once losses pass the threshold', () => {
  const records = good(100);
  for (let i = 0; i < 15; i += 1) records[i].name = '';
  assert.equal(assessHealth(records).ok, false, '85% is below the 90% gate');
});

test('gates and sample size are configurable', () => {
  const records = good(5, { name: '' });
  const health = assessHealth(records, { minSample: 3, gates: { name: 0.5 } });
  assert.equal(health.ok, false);
});

test('describeBreaches produces something a user can act on', () => {
  const text = describeBreaches([{ field: 'name', rate: 0.1, threshold: 0.9 }]);
  assert.match(text, /Google may have changed the page/);
  assert.match(text, /paused/);
  assert.equal(describeBreaches([]), '');
});

test('summariseRates puts the worst field first', () => {
  const out = summariseRates({ name: 1, phone: 0.2, address: 0.6 });
  assert.deepEqual(out.map((r) => r.field), ['phone', 'address', 'name']);
});

test('the default gates cover the fields Maps always shows', () => {
  assert.ok(DEFAULT_GATES.name > 0.5);
  assert.ok(DEFAULT_GATES.mapsUrl > 0.5);
  assert.equal(DEFAULT_GATES.phone, undefined, 'phone must never be a gate');
});
