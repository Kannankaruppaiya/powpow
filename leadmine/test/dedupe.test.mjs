import test from 'node:test';
import assert from 'node:assert/strict';

import { recordKey, mergeRecords, dedupeRecords, addToSeen, filterUnseen, absorbInto } from '../src/lib/dedupe.js';

const withUrl = (url, extra = {}) => ({ name: 'Some Place', mapsUrl: url, ...extra });

test('recordKey prefers the feature id embedded in the place URL', () => {
  const a = withUrl('https://www.google.com/maps/place/X/data=!4m5!3m4!1s0x3a5265ea4f0d3b1d:0x9f8e7d6c!8m2');
  const b = withUrl('https://www.google.com/maps/place/X-different-slug/data=!3m1!1s0x3A5265EA4F0D3B1D:0X9F8E7D6C');
  assert.equal(recordKey(a), 'fid:0x3a5265ea4f0d3b1d:0x9f8e7d6c');
  assert.equal(recordKey(a), recordKey(b), 'same business, different slug and case');
});

test('recordKey falls back to cid, then phone, then name plus place', () => {
  assert.equal(recordKey(withUrl('https://maps.google.com/?cid=12345')), 'cid:12345');
  assert.equal(recordKey({ name: 'X', phone: '+91 98765 43210' }), 'tel:9876543210');
  assert.equal(
    recordKey({ name: 'Bright Smile', address: '12 Anna Nagar' }),
    'name:brightsmile@12annanagar'
  );
});

test('recordKey treats the same number written two ways as one business', () => {
  assert.equal(
    recordKey({ name: 'A', phone: '+91 98765 43210' }),
    recordKey({ name: 'A', phone: '098765 43210' })
  );
});

test('recordKey separates two branches of one chain', () => {
  const adyar = { name: 'Cafe Chain', address: '1 Adyar Main Rd' };
  const kilpauk = { name: 'Cafe Chain', address: '9 Kilpauk Garden Rd' };
  assert.notEqual(recordKey(adyar), recordKey(kilpauk));
});

test('recordKey is empty when there is nothing to match on', () => {
  assert.equal(recordKey({}), '');
  assert.equal(recordKey(null), '');
});

test('mergeRecords fills blanks without overwriting good values', () => {
  const merged = mergeRecords(
    { name: 'A', phone: '123', email: '', rating: '4.5' },
    { name: 'A', phone: '', email: 'a@b.test', rating: '4.1' }
  );
  assert.equal(merged.phone, '123', 'an existing value is kept');
  assert.equal(merged.email, 'a@b.test', 'a blank is filled');
  assert.equal(merged.rating, '4.5');
});

test('mergeRecords lets a deep-scraped sighting win over a list-only one', () => {
  const merged = mergeRecords(
    { name: 'A', category: 'Cafe', address: 'Short st', detailScraped: false },
    { name: 'A', category: 'Coffee shop', address: 'Full address, Anna Nagar', detailScraped: true }
  );
  assert.equal(merged.category, 'Coffee shop');
  assert.equal(merged.address, 'Full address, Anna Nagar');
  assert.equal(merged.detailScraped, true);
});

test('mergeRecords keeps the longer address between two list sightings', () => {
  const merged = mergeRecords(
    { name: 'A', address: 'Anna Nagar' },
    { name: 'A', address: '12, 2nd Ave, Anna Nagar' }
  );
  assert.equal(merged.address, '12, 2nd Ave, Anna Nagar');
});

test('dedupeRecords collapses overlapping grid cells into one row each', () => {
  const fid = (n) => `https://www.google.com/maps/place/P/data=!1s0x${n}:0x${n}`;
  const out = dedupeRecords([
    { name: 'A', mapsUrl: fid('1'), phone: '' },
    { name: 'B', mapsUrl: fid('2') },
    { name: 'A', mapsUrl: fid('1'), phone: '044 1111 1111', detailScraped: true },
  ]);

  assert.equal(out.length, 2);
  assert.equal(out.find((r) => r.name === 'A').phone, '044 1111 1111');
});

test('dedupeRecords keeps unidentifiable records rather than dropping them', () => {
  const out = dedupeRecords([{ foo: 1 }, { foo: 2 }]);
  assert.equal(out.length, 2);
});

test('dedupeRecords preserves first-sighting order', () => {
  const out = dedupeRecords([
    { name: 'First', phone: '1111111111' },
    { name: 'Second', phone: '2222222222' },
    { name: 'First', phone: '1111111111' },
  ]);
  assert.deepEqual(out.map((r) => r.name), ['First', 'Second']);
});

test('addToSeen accumulates keys and stays inside its limit', () => {
  const first = addToSeen([], [{ name: 'A', phone: '1111111111' }]);
  const second = addToSeen(first, [
    { name: 'A', phone: '1111111111' }, // already known
    { name: 'B', phone: '2222222222' },
  ]);
  assert.equal(second.length, 2, 'no duplicate keys');

  const many = Array.from({ length: 12 }, (_, i) => ({ name: `n${i}`, phone: `${1000000000 + i}` }));
  const capped = addToSeen([], many, 5);
  assert.equal(capped.length, 5);
  assert.ok(capped.includes('tel:1000000011'), 'the newest keys survive the trim');
});

test('filterUnseen skips businesses from earlier runs', () => {
  const seen = addToSeen([], [{ name: 'Old', phone: '1111111111' }]);
  const out = filterUnseen(
    [{ name: 'Old', phone: '1111111111' }, { name: 'New', phone: '2222222222' }],
    seen
  );
  assert.deepEqual(out.map((r) => r.name), ['New']);
});

test('filterUnseen is a no-op with an empty index', () => {
  const records = [{ name: 'A', phone: '1111111111' }];
  assert.deepEqual(filterUnseen(records, []), records);
});

test('absorbInto merges overlapping grid cells and counts only new businesses', async () => {
  const { absorbInto } = await import('../src/lib/dedupe.js');
  const records = [];

  const cellA = absorbInto(records, [
    { name: 'A', phone: '1111111111' },
    { name: 'B', phone: '2222222222' },
  ]);
  // The neighbouring cell sees A again, plus one business of its own.
  const cellB = absorbInto(records, [
    { name: 'A', phone: '1111111111', website: 'https://a.test' },
    { name: 'C', phone: '3333333333' },
  ]);

  assert.equal(cellA.added, 2);
  assert.equal(cellB.added, 1, 'the repeat sighting of A is not a new business');
  assert.equal(cellB.touched.length, 2, 'both the updated and the new record must be persisted');
  assert.equal(records.length, 3);
  assert.equal(records.find((r) => r.name === 'A').website, 'https://a.test', 'A was enriched in place');
});

test('absorbInto does not mutate the records it is handed', async () => {
  const { absorbInto } = await import('../src/lib/dedupe.js');
  const incoming = [{ name: 'A', phone: '1111111111' }];
  const records = [];
  absorbInto(records, incoming);
  records[0].name = 'changed';
  assert.equal(incoming[0].name, 'A', 'the caller’s objects must stay untouched');
});

test('absorbInto keeps unidentifiable records instead of dropping them', async () => {
  const { absorbInto } = await import('../src/lib/dedupe.js');
  const records = [];
  assert.equal(absorbInto(records, [{ note: 'no name' }, { note: 'also none' }]).added, 2);
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.key), 'every stored record needs a primary key');
});

test('absorbInto stamps each record with its identity as the primary key', async () => {
  const { absorbInto, recordKey } = await import('../src/lib/dedupe.js');
  const records = [];
  const incoming = { name: 'A', phone: '+91 98765 43210' };
  absorbInto(records, [incoming]);
  assert.equal(records[0].key, recordKey(incoming));
});

test('absorbInto keeps the key stable when a record is merged again', async () => {
  const { absorbInto } = await import('../src/lib/dedupe.js');
  const records = [];
  absorbInto(records, [{ name: 'A', phone: '1111111111' }]);
  const firstKey = records[0].key;
  absorbInto(records, [{ name: 'A', phone: '1111111111', website: 'https://a.test' }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].key, firstKey, 'a merge must not re-key the row');
});

test('one person found two ways is one row, not two', () => {
  // The logged-in search anonymises anyone outside your network — "LinkedIn
  // Member", no name — while their public profile page names them. So the
  // same person can arrive twice by different routes, and the profile slug is
  // the only thing both records reliably share.
  const fromSearch = {
    name: 'Raghu Vaidyanathan',
    headline: 'Manager Finance at Visesh Cargo',
    location: 'Chennai, Tamil Nadu, India',
    profileUrl: 'https://www.linkedin.com/in/raghu-vaidyanathan-48812716/',
    source: 'linkedin',
    degree: '3rd+',
  };
  const fromWeb = {
    name: 'Raghu Vaidyanathan',
    headline: 'Manager Finance',
    // A different form of the same URL: no trailing slash, tracking attached.
    profileUrl: 'https://in.linkedin.com/in/raghu-vaidyanathan-48812716?trk=abc',
    source: 'web',
  };

  assert.equal(recordKey(fromSearch), recordKey(fromWeb));
  assert.match(recordKey(fromSearch), /^li:raghu-vaidyanathan-48812716$/);

  const merged = [];
  absorbInto(merged, [fromSearch]);
  absorbInto(merged, [fromWeb]);
  assert.equal(merged.length, 1, 'one person, one row');
  // And the fuller record wins the fields it has.
  assert.equal(merged[0].degree, '3rd+');
});

test('a profile URL outranks a name that two people share', () => {
  const a = { name: 'Anand Kumar', profileUrl: 'https://www.linkedin.com/in/anand-kumar-1' };
  const b = { name: 'Anand Kumar', profileUrl: 'https://www.linkedin.com/in/anand-kumar-2' };
  assert.notEqual(recordKey(a), recordKey(b), 'two different people stay two rows');
});
