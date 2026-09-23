/** The paid email finder. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  profileUrlOf,
  readApollo,
  readBetterContact,
  findPersonEmail,
  lookupTargets,
  findEmails,
} from '../src/lib/enrich.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const res = await handler(url, init, calls.length);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.json || {} };
  };
  return { fetchImpl, calls };
}

test('the profile link is normalised, and a post author’s works too', () => {
  assert.equal(profileUrlOf({ profileUrl: 'https://in.linkedin.com/in/priya-r?trk=x' }), 'https://www.linkedin.com/in/priya-r');
  assert.equal(profileUrlOf({ authorUrl: 'https://www.linkedin.com/in/arun/' }), 'https://www.linkedin.com/in/arun');
  assert.equal(profileUrlOf({ profileUrl: 'https://www.linkedin.com/company/acme' }), '', 'a company page is not a person');
  assert.equal(profileUrlOf({}), '');
});

test('Apollo: only a verified address counts, and the locked placeholder never does', () => {
  assert.deepEqual(readApollo({ person: { email: 'Priya@Acme.in', email_status: 'verified', first_name: 'Priya', last_name: 'Raman', title: 'CTO' } }), {
    found: true, email: 'priya@acme.in', status: 'verified', firstName: 'Priya', lastName: 'Raman', title: 'CTO',
  });
  assert.equal(readApollo({ person: { email: 'p@acme.in', email_status: 'guessed' } }).found, false);
  assert.equal(readApollo({ person: { email: 'email_not_unlocked@domain.com', email_status: 'verified' } }).found, false);
  assert.equal(readApollo({ person: null }).found, false);
});

test('BetterContact: valid, deliverable and catch-all-safe count; anything else is a miss', () => {
  const row = (status) => ({ data: [{ contact_email_address: 'a@b.in', contact_email_address_status: status, contact_first_name: 'A' }] });
  assert.equal(readBetterContact(row('deliverable')).found, true);
  assert.equal(readBetterContact(row('catch_all_safe')).found, true);
  assert.equal(readBetterContact(row('catch_all_not_safe')).found, false);
  assert.equal(readBetterContact({ data: [] }).found, false);
});

test('Apollo is sent the profile link and nothing else, with the key in a header', async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, json: { person: { email: 'x@y.in', email_status: 'verified' } } }));
  const result = await findPersonEmail({ finder: 'apollo', apiKey: 'KEY', profileUrl: 'https://www.linkedin.com/in/x', fetchImpl });
  assert.equal(result.email, 'x@y.in');
  assert.equal(calls[0].url, 'https://api.apollo.io/api/v1/people/match');
  assert.deepEqual(calls[0].body, { linkedin_url: 'https://www.linkedin.com/in/x' });
  assert.equal(calls[0].init.headers['x-api-key'], 'KEY');
  assert.ok(!calls[0].url.includes('KEY'), 'never in the URL');
});

test('BetterContact submits, then polls until the job terminates', async () => {
  const { fetchImpl, calls } = fakeFetch((url, init, n) => {
    if (init.method === 'POST') return { status: 200, json: { request_id: 'req-1' } };
    if (n === 2) return { status: 200, json: { status: 'in progress' } };
    return { status: 200, json: { status: 'terminated', data: [{ contact_email_address: 'z@q.in', contact_email_address_status: 'valid' }] } };
  });
  const result = await findPersonEmail({
    finder: 'bettercontact', apiKey: 'K', profileUrl: 'https://www.linkedin.com/in/z', fetchImpl, sleepImpl: async () => {},
  });
  assert.equal(result.email, 'z@q.in');
  assert.deepEqual(calls[0].body, { data: [{ linkedin_url: 'https://www.linkedin.com/in/z' }], enrich_email_address: true, enrich_phone_number: false });
  assert.equal(calls[2].url, 'https://app.bettercontact.rocks/api/v2/async/req-1');
});

test('a refusal says what to do about it', async () => {
  for (const [status, re] of [[401, /rejected the API key/], [402, /no credits left/], [429, /rate-limiting/]]) {
    const { fetchImpl } = fakeFetch(() => ({ status }));
    await assert.rejects(findPersonEmail({ finder: 'apollo', apiKey: 'K', profileUrl: 'https://www.linkedin.com/in/x', fetchImpl }), re);
  }
});

test('the spend gate: fit people with a profile, no email, not suppressed, capped', () => {
  const people = [
    { key: 'a', profileUrl: 'https://www.linkedin.com/in/a' },
    { key: 'b', profileUrl: 'https://www.linkedin.com/in/b' },
    { key: 'c', profileUrl: 'https://www.linkedin.com/in/c' },
    { key: 'd', profileUrl: 'https://www.linkedin.com/in/d' },
    { key: 'e' },
    { key: 'f', profileUrl: 'https://www.linkedin.com/in/f', email: 'has@one.in' },
    { key: 'g', profileUrl: 'https://www.linkedin.com/in/g' },
  ];
  const notes = new Map([
    ['a', { verdict: 'fit' }],
    ['b', { verdict: 'maybe' }],
    ['c', { verdict: 'fit', feedback: 'bad' }],
    ['d', { verdict: 'fit', personEmailTried: 1 }],
    ['e', { verdict: 'fit' }],
    ['f', { verdict: 'fit' }],
    ['g', { verdict: 'fit' }],
  ]);
  const suppressed = (r) => r.key === 'g';
  assert.deepEqual(lookupTargets(people, notes, { isSuppressed: suppressed }).map((r) => r.key), ['a']);
  assert.deepEqual(lookupTargets(people, notes, { include: ['fit', 'maybe'], isSuppressed: suppressed }).map((r) => r.key), ['a', 'b']);
  assert.deepEqual(lookupTargets(people, notes, { include: ['fit', 'maybe'], limit: 1 }).map((r) => r.key), ['a']);
});

test('a batch stops on the first refusal, keeping what it found', async () => {
  const { fetchImpl, calls } = fakeFetch((url, init, n) =>
    n === 1 ? { status: 200, json: { person: { email: 'one@x.in', email_status: 'verified' } } } : { status: 402 }
  );
  const got = [];
  await assert.rejects(
    findEmails({
      records: [
        { key: 'a', profileUrl: 'https://www.linkedin.com/in/a' },
        { key: 'b', profileUrl: 'https://www.linkedin.com/in/b' },
        { key: 'c', profileUrl: 'https://www.linkedin.com/in/c' },
      ],
      finder: 'apollo',
      apiKey: 'K',
      fetchImpl,
      onEach: (patch) => got.push(patch),
    }),
    /no credits/
  );
  assert.equal(calls.length, 2, 'the third was never tried');
  assert.equal(got.length, 1);
  assert.equal(got[0].personEmail, 'one@x.in');
});
