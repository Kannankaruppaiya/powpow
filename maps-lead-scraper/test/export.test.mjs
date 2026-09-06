import test from 'node:test';
import assert from 'node:assert/strict';

import { toCsv, toJson, toExcelHtml, buildFile, COLUMNS } from '../src/lib/export.js';

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

test('toExcelHtml escapes markup rather than emitting it', () => {
  const html = toExcelHtml([{ name: '<script>alert(1)</script>', phone: '007' }]);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('mso-number-format'), 'phones need a text format');
});

test('buildFile names the download after the search and picks the right mime', () => {
  const meta = { city: 'Chennai', category: 'Dental Clinics' };
  const csv = buildFile(sample, 'csv', meta);
  assert.match(csv.filename, /^dental-clinics_chennai_[\d-]+\.csv$/);
  assert.match(csv.mime, /^text\/csv/);

  assert.equal(buildFile(sample, 'json', meta).mime, 'application/json');
  assert.match(buildFile(sample, 'xls', meta).filename, /\.xls$/);
});

test('buildFile falls back to a generic name without search metadata', () => {
  assert.match(buildFile(sample, 'csv', {}).filename, /^maps-leads_[\d-]+\.csv$/);
});

test('buildFile defaults to CSV for an unknown format', () => {
  assert.match(buildFile(sample, 'nonsense', {}).mime, /^text\/csv/);
});
