import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFile, annotate, ANNOTATION_COLUMNS, MAPS_COLUMNS } from '../src/lib/export.js';
import { suppressionChecker } from '../src/lib/crm.js';

const records = [
  { key: 'b1', source: 'maps', name: 'Acme Training', email: 'info@acme.in', website: 'https://acme.in', phone: '+91 1', siteDescription: 'Corporate SAP training.' },
  { key: 'b2', source: 'maps', name: 'Quiet Co' },
];

test('without notes the file is exactly what it was', async () => {
  const { content } = await buildFile(records, 'csv', {}, { notes: new Map() });
  const header = content.replace(/^﻿/, '').split('\r\n')[0];
  assert.equal(header.split('","').length, MAPS_COLUMNS.length, 'no empty annotation columns tacked on');
  assert.match(header, /Website Description/);
});

test('notes become columns: verdict, reason, status, follow-up, do-not-contact', async () => {
  const notes = new Map([
    ['b1', { verdict: 'fit', reason: 'Trains SAP teams.', services: 'SAP courses', status: 'contacted', followUpOn: '2026-09-30' }],
    ['b2', { verdict: 'fit', feedback: 'bad' }],
  ]);
  const rows = annotate(records, { notes, isSuppressed: suppressionChecker([{ value: 'email:info@acme.in' }]) });
  assert.equal(rows[0].fit, 'Fit');
  assert.equal(rows[0].fitReason, 'Trains SAP teams.');
  assert.equal(rows[0].status, 'Contacted');
  assert.equal(rows[0].followUpOn, '2026-09-30');
  assert.equal(rows[0].doNotContact, 'Yes');
  assert.equal(rows[1].fit, 'Not a fit', 'the user’s mark wins');

  const { content } = await buildFile(records, 'json', {}, { notes });
  const parsed = JSON.parse(content);
  assert.deepEqual(Object.keys(parsed[0]).slice(-ANNOTATION_COLUMNS.length), ANNOTATION_COLUMNS.map((c) => c.key));
});

test('a linked person carries the business’s phone and site; a business names its people', () => {
  const person = { key: 'p1', source: 'linkedin', name: 'Priya', headline: 'Head of L&D' };
  const rows = annotate([records[0], person], {
    linked: new Map([['p1', records[0]]]),
    people: new Map([['b1', [person]]]),
  });
  assert.equal(rows[0].linked, 'Priya (Head of L&D)');
  assert.equal(rows[1].linked, 'Works at Acme Training · +91 1 · https://acme.in');
});

test('the cold-email format has the importers’ columns and says how many rows it wrote', async () => {
  const file = await buildFile(records, 'sequencer', { category: 'training', city: 'Chennai' }, { notes: new Map() });
  assert.match(file.filename, /_cold-email\.csv$/);
  assert.equal(file.count, 1);
  const [header, row] = file.content.replace(/^﻿/, '').split('\r\n');
  assert.match(header, /^"email","first_name","last_name","company"/);
  assert.match(row, /^"info@acme\.in"/);
});
