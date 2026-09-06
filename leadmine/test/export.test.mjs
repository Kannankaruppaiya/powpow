import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toCsv,
  toJson,
  toRows,
  buildFile,
  columnsFor,
  COLUMNS,
  MAPS_COLUMNS,
  LINKEDIN_COLUMNS,
} from '../src/lib/export.js';

const sample = [
  {
    name: 'Bright Smile "Dental"',
    category: 'Dental clinic',
    phone: '+91 98765 43210',
    email: 'info@bright.test',
    area: 'Anna Nagar',
    city: 'Chennai',
    address: '12, 2nd Ave, Anna Nagar, Chennai',
    rating: '4.6',
    reviews: '284',
    website: 'https://bright.test',
    allEmails: ['hi@bright.test', 'admin@bright.test'],
    mapsUrl: 'https://maps.google.com/?cid=1',
  },
];

test('toCsv writes a BOM, a header row and one row per record', () => {
  const csv = toCsv(sample);
  assert.ok(csv.startsWith('﻿'), 'expected a UTF-8 BOM for Excel');
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('"Business Name"'));
  assert.ok(lines[0].includes('"Email"'));
});

test('toCsv doubles embedded quotes', () => {
  assert.ok(toCsv(sample).includes('"Bright Smile ""Dental"""'));
});

test('toCsv neutralises spreadsheet formula injection', () => {
  const csv = toCsv([{ name: '=cmd|calc', phone: '+15551234567', email: '-2+3' }]);
  assert.ok(csv.includes(`"'=cmd|calc"`), 'leading = must be escaped');
  assert.ok(csv.includes(`"'+15551234567"`), 'leading + must be escaped');
  assert.ok(csv.includes(`"'-2+3"`), 'leading - must be escaped');
});

test('toCsv joins list fields and blanks missing ones', () => {
  const csv = toCsv(sample);
  assert.ok(csv.includes('hi@bright.test; admin@bright.test'));
  assert.ok(csv.includes('""'), 'plusCode is absent and should serialise as empty');
});

test('toJson emits every column in a stable order', () => {
  const rows = JSON.parse(toJson(sample));
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), COLUMNS.map((c) => c.key));
  assert.equal(rows[0].plusCode, '');
});

test('toRows lines the values up with the header labels', () => {
  const { headers, rows } = toRows(sample);
  assert.equal(headers.length, COLUMNS.length);
  assert.equal(rows[0].length, COLUMNS.length);
  assert.equal(headers[0], 'Business Name');
  assert.equal(rows[0][0], 'Bright Smile "Dental"');
  assert.equal(rows[0][headers.indexOf('Other Emails')], 'hi@bright.test; admin@bright.test');
});

test('toRows blanks missing fields instead of writing undefined', () => {
  const { headers, rows } = toRows([{ name: 'Only a name' }]);
  assert.equal(rows[0][headers.indexOf('Phone')], '');
});

test('buildFile names the download after the search and picks the right mime', async () => {
  const meta = { city: 'Chennai', category: 'Dental Clinics' };
  const csv = await buildFile(sample, 'csv', meta);
  assert.match(csv.filename, /^dental-clinics_chennai_[\d-]+\.csv$/);
  assert.match(csv.mime, /^text\/csv/);

  assert.equal((await buildFile(sample, 'json', meta)).mime, 'application/json');
});

test('buildFile emits a real xlsx, not an HTML table named .xls', async () => {
  const out = await buildFile(sample, 'xlsx', { city: 'Chennai', category: 'Dentists' });
  assert.match(out.filename, /\.xlsx$/);
  assert.equal(out.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  // "PK" — the ZIP magic every real xlsx starts with.
  assert.equal(out.content[0], 0x50);
  assert.equal(out.content[1], 0x4b);
});

test('buildFile upgrades a saved "xls" preference to xlsx', async () => {
  // Settings stored by an older version must not break the download.
  const out = await buildFile(sample, 'xls', {});
  assert.match(out.filename, /\.xlsx$/);
});

test('buildFile prefixes the source when one is given', async () => {
  const out = await buildFile(sample, 'csv', { source: 'linkedin', category: 'Java', city: 'London' });
  assert.match(out.filename, /^linkedin_java_london_/);
});

test('buildFile falls back to a generic name without search metadata', async () => {
  assert.match((await buildFile(sample, 'csv', {})).filename, /^leads_[\d-]+\.csv$/);
});

test('buildFile takes the source from the records when meta omits it', async () => {
  const out = await buildFile([{ source: 'linkedin', name: 'Priya' }], 'csv', { category: 'Java' });
  assert.match(out.filename, /^linkedin_java_/);
});

test('buildFile defaults to CSV for an unknown format', async () => {
  assert.match((await buildFile(sample, 'nonsense', {})).mime, /^text\/csv/);
});

test('columnsFor picks the column set the records actually need', () => {
  assert.equal(columnsFor([{ source: 'maps' }]), MAPS_COLUMNS);
  assert.equal(columnsFor([{ source: 'linkedin' }]), LINKEDIN_COLUMNS);
  // An untagged set is a Maps run from before sources existed.
  assert.equal(columnsFor([{ name: 'x' }]), MAPS_COLUMNS);
  assert.equal(columnsFor([]), MAPS_COLUMNS);
  assert.equal(COLUMNS, MAPS_COLUMNS, 'the default export stays Maps for older callers');
});

test('a LinkedIn export uses people columns, not blank business ones', () => {
  const people = [
    {
      source: 'linkedin',
      name: 'Priya Sharma',
      headline: 'Staff Engineer at Acme',
      company: 'Acme',
      location: 'Chennai, Tamil Nadu, India',
      degree: '2nd',
      openToWork: 'Yes',
      profileUrl: 'https://www.linkedin.com/in/priya',
    },
  ];

  const csv = toCsv(people);
  const [header, row] = csv.trimEnd().split('\r\n');
  assert.ok(header.includes('"Headline"'));
  assert.ok(header.includes('"Connection"'));
  assert.ok(!header.includes('"Plus Code"'), 'business-only columns must not appear');
  assert.ok(row.includes('Priya Sharma'));
  assert.ok(row.includes('2nd'));
});

test('toJson and toRows follow the same source-aware columns', () => {
  const people = [{ source: 'linkedin', name: 'Priya', company: 'Acme' }];
  assert.deepEqual(Object.keys(JSON.parse(toJson(people))[0]), LINKEDIN_COLUMNS.map((c) => c.key));
  assert.deepEqual(toRows(people).headers, LINKEDIN_COLUMNS.map((c) => c.label));
});
