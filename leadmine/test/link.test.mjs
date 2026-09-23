/** Joining people to the businesses they work at. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { companyKey, employerOf, linkRecords, peopleSummary } from '../src/lib/link.js';

test('company names normalise past legal suffixes and punctuation', () => {
  assert.equal(companyKey('Acme Training Pvt. Ltd.'), companyKey('ACME TRAINING Private Limited'));
  assert.equal(companyKey('The Bright Smile Dental Clinic'), companyKey('Bright Smile Dental Clinic'));
  assert.equal(companyKey('Tata & Sons'), companyKey('Tata and Sons'));
  assert.equal(companyKey('A2'), '', 'too short to be a name rather than a coincidence');
});

test('an employer comes from the company field, or the headline’s “at …”', () => {
  assert.equal(employerOf({ company: 'Acme' }), 'Acme');
  assert.equal(employerOf({ headline: 'Head of L&D at Acme Training | SAP' }), 'Acme Training');
  assert.equal(employerOf({ headline: 'Freelance trainer' }), '');
});

test('people join the business they work at, across runs', () => {
  const records = [
    { key: 'b1', source: 'maps', name: 'Acme Training Pvt Ltd', website: 'https://acme.in', phone: '1' },
    { key: 'b2', name: 'Bright Smile Dental' },
    { key: 'p1', source: 'linkedin', name: 'Priya', company: 'ACME Training' },
    { key: 'p2', source: 'web', name: 'Arun', headline: 'Owner at Bright Smile Dental' },
    { key: 'p3', source: 'linkedin', name: 'Stranger', company: 'Elsewhere Ltd' },
  ];
  const { personToBusiness, businessToPeople } = linkRecords(records);
  assert.equal(personToBusiness.get('p1').key, 'b1');
  assert.equal(personToBusiness.get('p2').key, 'b2');
  assert.equal(personToBusiness.has('p3'), false);
  assert.deepEqual(businessToPeople.get('b1').map((p) => p.key), ['p1']);
});

test('a name two businesses share joins neither', () => {
  const records = [
    { key: 'b1', source: 'maps', name: 'Chai Point', address: 'Adyar' },
    { key: 'b2', source: 'maps', name: 'Chai Point', address: 'Velachery' },
    { key: 'p1', source: 'linkedin', name: 'Kumar', company: 'Chai Point' },
  ];
  assert.equal(linkRecords(records).personToBusiness.has('p1'), false, 'no telling which branch');
});

test('the people column names who works there', () => {
  assert.equal(
    peopleSummary([{ name: 'Priya', headline: 'Head of L&D' }, { name: 'Arun' }]),
    'Priya (Head of L&D); Arun'
  );
});
