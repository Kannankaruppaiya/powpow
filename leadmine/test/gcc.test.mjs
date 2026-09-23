/** India's Global Capability Centres, and telling a GCC lead from the rest. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gccKey,
  buildGccIndex,
  gccForCompany,
  gccInText,
  mentionsGcc,
  gccOf,
  gccFirst,
  gccLabel,
  gccMatcher,
  parseExtra,
  loadGccMatcher,
} from '../src/lib/gcc.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'gcc.json');
const list = JSON.parse(readFileSync(DATA, 'utf8'));
const index = buildGccIndex(list);

test('the built-in list is hundreds of companies, each named once', () => {
  assert.ok(list.length >= 800, `expected 800+ GCCs, got ${list.length}`);
  const keys = list.map((e) => gccKey(e.n));
  assert.equal(new Set(keys).size, keys.length, 'no company listed twice');
  for (const e of list) {
    assert.ok(e.n && e.n.length >= 2, `a name, not ${JSON.stringify(e)}`);
    for (const city of e.c || []) assert.doesNotMatch(city, /Bangalore|Gurgaon/, 'one spelling per city');
  }
  for (const name of ['Wells Fargo', 'Goldman Sachs', 'Walmart Global Tech', 'Bank of America', 'Western Union', 'Western Digital']) {
    assert.ok(gccForCompany(name, index), `${name} is on the list`);
  }
  assert.equal(gccForCompany('Accenture', index), null, 'a services vendor is not a GCC');
});

test('a company field matches past legal suffixes and centre words', () => {
  assert.equal(gccForCompany('Wells Fargo International Solutions Pvt Ltd', index).name, 'Wells Fargo');
  assert.equal(gccForCompany('JP Morgan Services India', index).name, 'JPMorgan');
  assert.equal(gccForCompany('Honeywell Technology Solutions Lab', index).name, 'Honeywell');
  assert.equal(gccForCompany('L’Oréal', index).name, "L'Oréal");
  assert.equal(gccForCompany('Oracle Dental Clinic', index), null, 'another business that shares a first word');
  assert.equal(gccForCompany('Target Tuition Centre', index), null, 'a common word is trusted only whole');
  assert.equal(gccForCompany('Target Corporation', index).name, 'Target');
});

test('free text names a GCC only where the words around it say it is the company', () => {
  assert.equal(gccInText('We need an Azure trainer for our client Wells Fargo in Hyderabad.', index).name, 'Wells Fargo');
  assert.equal(gccInText('Morgan Stanley is looking for a trainer', index).name, 'Morgan Stanley');
  assert.equal(gccInText('Urgent requirement: SAP FICO trainer for a 5 day batch.', index), null, 'SAP the product');
  assert.equal(gccInText('Looking for an Oracle DBA trainer.', index), null, 'Oracle the database');
  assert.equal(gccInText('Trainer needed at SAP Labs India, Bengaluru.', index).name, 'SAP', 'SAP the employer');
  assert.equal(gccInText('Target audience: freshers.', index), null);
  assert.equal(gccInText('the target is sap', index), null, 'lower case is not a name');
});

test('a post about a GCC it does not name still counts, the Gulf does not', () => {
  assert.equal(mentionsGcc('Python trainer for a leading GCC in Chennai'), true);
  assert.equal(mentionsGcc('Our global capability center needs a Kafka trainer'), true);
  assert.equal(mentionsGcc('Hiring for GCC countries, Dubai based'), false);
  assert.equal(mentionsGcc('Sales role across the GCC region'), false);
});

test('each kind of lead is checked where its company is written', () => {
  assert.deepEqual(
    [gccOf({ source: 'linkedin', company: 'Goldman Sachs' }, index).via, gccOf({ source: 'linkedin', company: 'Goldman Sachs' }, index).name],
    ['works there', 'Goldman Sachs']
  );
  assert.equal(gccOf({ source: 'web', headline: 'Talent Acquisition at Bank of America | Hiring' }, index).name, 'Bank of America');
  const post = gccOf({ source: 'posts', authorHeadline: 'HR Manager at Wells Fargo', text: 'Need a trainer' }, index);
  assert.deepEqual([post.name, post.via], ['Wells Fargo', 'author works there']);
  assert.equal(gccOf({ source: 'posts', text: 'Need a Java trainer for our client Deutsche Bank, Pune' }, index).via, 'named in the post');
  assert.deepEqual(gccOf({ source: 'posts', text: 'Requirement for a GCC in Hyderabad' }, index), {
    name: '', via: 'a GCC, not named', cities: [], sector: '', mine: false,
  });
  assert.deepEqual(Object.values(gccOf({ source: 'maps', name: 'Honeywell Technology Solutions Lab' }, index)).slice(0, 2), ['Honeywell', 'the business is one']);
  assert.equal(gccOf({ source: 'maps', name: 'Bright Smile Dental' }, index), null);
  assert.equal(gccOf({ source: 'posts', text: 'Need an SAP trainer' }, index), null);
});

test('the user’s own names count, even ones that look like ordinary words', () => {
  const mine = buildGccIndex(list, ['Acme Captive', 'Orbit']);
  assert.equal(gccOf({ source: 'linkedin', company: 'Orbit' }, mine).mine, true);
  assert.equal(gccOf({ source: 'posts', text: 'A trainer for the Acme Captive team' }, mine).name, 'Acme Captive');
  assert.deepEqual(parseExtra(' Acme Captive \n\nOrbit, Acme Captive; Zed '), ['Acme Captive', 'Orbit', 'Zed']);
});

test('GCC requirement posts come first, then other GCC leads, then everything else in its order', () => {
  const records = [
    { key: 'a', source: 'posts', intent: 'DEMAND', text: 'Need a trainer' },
    { key: 'b', source: 'posts', intent: 'SUPPLY', authorHeadline: 'Trainer at Wells Fargo', text: 'I offer training' },
    { key: 'c', source: 'posts', intent: 'DEMAND', text: 'Need a trainer' },
    { key: 'd', source: 'posts', intent: 'DEMAND', authorHeadline: 'HR at Goldman Sachs', text: 'Need a trainer' },
  ];
  const gccFor = gccMatcher(index);
  assert.deepEqual(gccFirst(records, gccFor).map((r) => r.key), ['d', 'b', 'a', 'c']);
  assert.equal(gccLabel(gccFor(records[3])), 'Goldman Sachs');
  assert.equal(gccLabel({ name: '' }), 'GCC (unnamed)');
  assert.equal(gccLabel(null), '');
});

test('a list that cannot load leaves every lead unmarked rather than failing', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    const gccFor = await loadGccMatcher({ get: async () => ({}) });
    assert.equal(gccFor({ source: 'linkedin', company: 'Wells Fargo' }), null);
  } finally {
    globalThis.fetch = saved;
  }
});
