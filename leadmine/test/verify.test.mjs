import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS,
  splitEmail,
  isDisposable,
  isRoleAccount,
  classify,
  isSendable,
  parseDohAnswer,
  lookupMx,
} from '../src/lib/verify.js';

test('splitEmail accepts real addresses and rejects malformed ones', () => {
  assert.deepEqual(splitEmail('Info@Clinic.COM'), {
    local: 'info',
    domain: 'clinic.com',
    email: 'info@clinic.com',
  });
  assert.equal(splitEmail('no-at-sign'), null);
  assert.equal(splitEmail('a@b'), null, 'a bare TLD-less host is not valid');
  assert.equal(splitEmail('a b@c.com'), null);
  assert.equal(splitEmail(''), null);
});

test('isDisposable catches throwaway providers and their subdomains', () => {
  assert.equal(isDisposable('mailinator.com'), true);
  assert.equal(isDisposable('team.mailinator.com'), true);
  assert.equal(isDisposable('clinic.com'), false);
});

test('isRoleAccount flags shared desk addresses only', () => {
  assert.equal(isRoleAccount('info'), true);
  assert.equal(isRoleAccount('BOOKINGS'), true);
  assert.equal(isRoleAccount('priya'), false);
});

test('classify walks the decision table', () => {
  assert.equal(classify('bad', null).status, STATUS.INVALID);
  assert.equal(classify('a@mailinator.com', ['mx']).status, STATUS.DISPOSABLE);
  assert.equal(classify('a@clinic.com', []).status, STATUS.NO_MX);
  assert.equal(classify('info@clinic.com', ['mx1']).status, STATUS.ROLE);
  assert.equal(classify('priya@clinic.com', ['mx1']).status, STATUS.VALID);
  assert.equal(classify('priya@clinic.com', null).status, STATUS.UNKNOWN);
});

test('classify checks syntax before anything touches the network', () => {
  // A malformed address must not be reported as unknown just because no MX
  // answer was supplied.
  assert.equal(classify('not-an-email', null).status, STATUS.INVALID);
});

test('isSendable keeps unverified addresses in play but drops the dead ones', () => {
  assert.equal(isSendable(STATUS.VALID), true);
  assert.equal(isSendable(STATUS.ROLE), true);
  assert.equal(isSendable(STATUS.UNKNOWN), true, 'a failed lookup is not proof of a bad address');
  assert.equal(isSendable(STATUS.NO_MX), false);
  assert.equal(isSendable(STATUS.INVALID), false);
  assert.equal(isSendable(STATUS.DISPOSABLE), false);
});

test('parseDohAnswer reads MX hosts out of a DoH response', () => {
  const mx = parseDohAnswer({
    Status: 0,
    Answer: [
      { type: 15, data: '10 alt1.aspmx.l.google.com.' },
      { type: 15, data: '1 aspmx.l.google.com.' },
      { type: 1, data: '93.184.216.34' },
    ],
  });
  assert.deepEqual(mx, ['alt1.aspmx.l.google.com', 'aspmx.l.google.com']);
});

test('parseDohAnswer distinguishes "no such domain" from "lookup failed"', () => {
  assert.deepEqual(parseDohAnswer({ Status: 3 }), [], 'NXDOMAIN is a definite empty answer');
  assert.deepEqual(parseDohAnswer({ Status: 0, Answer: [] }), [], 'no MX records');
  assert.equal(parseDohAnswer({ Status: 2 }), null, 'SERVFAIL is unknown, not empty');
  assert.equal(parseDohAnswer(null), null);
});

test('lookupMx caches per domain so a repeated domain costs one query', async () => {
  const cache = new Map();
  cache.set('clinic.com', ['mx1.clinic.com']);
  // A populated cache means no fetch is attempted at all.
  assert.deepEqual(await lookupMx('clinic.com', { cache }), ['mx1.clinic.com']);
  assert.equal(await lookupMx('', { cache }), null);
});

/** A stub resolver returning canned DoH JSON, so the network path is testable. */
function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const type = new URL(url).searchParams.get('type');
    const host = new URL(url).hostname;
    const answer = responses[`${host}:${type}`] ?? responses[type];
    if (answer === 'fail') return { ok: false };
    if (answer === 'throw') throw new Error('blocked');
    return { ok: true, json: async () => answer };
  };
  return { fetchImpl, calls };
}

test('lookupMx returns the MX hosts a resolver reports', async () => {
  const { fetchImpl } = stubFetch({
    MX: { Status: 0, Answer: [{ type: 15, data: '10 aspmx.l.google.com.' }] },
  });
  const mx = await lookupMx('clinic.com', { cache: new Map(), fetchImpl });
  assert.deepEqual(mx, ['aspmx.l.google.com']);
});

test('lookupMx accepts a domain with an A record but no MX', async () => {
  // RFC 5321: with no MX, mail falls back to the address record.
  const { fetchImpl } = stubFetch({
    MX: { Status: 0, Answer: [] },
    A: { Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] },
  });
  assert.deepEqual(await lookupMx('shop.test', { cache: new Map(), fetchImpl }), ['shop.test']);
});

test('lookupMx reports a domain with neither MX nor A as undeliverable', async () => {
  const { fetchImpl } = stubFetch({ MX: { Status: 0, Answer: [] }, A: { Status: 0, Answer: [] } });
  assert.deepEqual(await lookupMx('nowhere.test', { cache: new Map(), fetchImpl }), []);
});

test('lookupMx falls back to the second resolver when the first is blocked', async () => {
  const { fetchImpl, calls } = stubFetch({
    'cloudflare-dns.com:MX': 'throw',
    'dns.google:MX': { Status: 0, Answer: [{ type: 15, data: '5 mail.shop.test.' }] },
  });
  assert.deepEqual(await lookupMx('shop.test', { cache: new Map(), fetchImpl }), ['mail.shop.test']);
  assert.equal(calls.length, 2, 'should have tried both resolvers');
});

test('lookupMx returns unknown when every resolver fails', async () => {
  const { fetchImpl } = stubFetch({ MX: 'fail' });
  assert.equal(await lookupMx('shop.test', { cache: new Map(), fetchImpl }), null);
});

test('lookupMx queries a domain once and serves repeats from cache', async () => {
  const cache = new Map();
  const { fetchImpl, calls } = stubFetch({
    MX: { Status: 0, Answer: [{ type: 15, data: '10 mx.shop.test.' }] },
  });
  await lookupMx('shop.test', { cache, fetchImpl });
  await lookupMx('shop.test', { cache, fetchImpl });
  assert.equal(calls.length, 1, 'the second call must not hit the network');
});

test('lookupMx degrades to unknown where fetch does not exist', async () => {
  assert.equal(await lookupMx('shop.test', { cache: new Map(), fetchImpl: undefined }), null);
});
