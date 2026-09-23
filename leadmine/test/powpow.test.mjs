/** Handing a run to PowPow's /hooks/agent endpoint. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  leadLine,
  buildHookMessage,
  hookPayload,
  shouldSend,
  sendToPowPow,
  DEFAULT_HOOK,
} from '../src/lib/powpow.js';

const business = { key: 'b1', source: 'maps', name: 'Acme Training', category: 'Training centre', area: 'Guindy', rating: '4.6', phone: '+91 98765 43210', email: 'info@acme.in', website: 'https://acme.in' };
const post = { key: 'p1', source: 'posts', author: 'Arun', ageDays: 1, text: 'Need an SAP FI trainer in Pune next week.', postUrl: 'https://www.linkedin.com/posts/x', emails: 'hr@corp.in' };

test('a lead line carries who, what, why and how to reach them', () => {
  const line = leadLine(business, { verdict: 'fit', reason: 'Trains corporate teams.' });
  assert.match(line, /Acme Training — Training centre, Guindy ★4\.6/);
  assert.match(line, /fit: Trains corporate teams\./);
  assert.match(line, /info@acme\.in · \+91 98765 43210 · https:\/\/acme\.in/);
  assert.match(leadLine(post), /Arun \(1d ago\): "Need an SAP FI trainer/);
});

test('the message puts fits first, leaves out the rejected, and asks for a summary', () => {
  const records = [
    { ...business, key: 'a', name: 'Maybe Co' },
    { ...business, key: 'b', name: 'Fit Co' },
    { ...business, key: 'c', name: 'Rejected Co' },
  ];
  const notes = new Map([
    ['a', { verdict: 'maybe' }],
    ['b', { verdict: 'fit' }],
    ['c', { verdict: 'fit', feedback: 'bad' }],
  ]);
  const message = buildHookMessage({ records, notes, config: { source: 'maps', category: 'training', city: 'Chennai' }, scheduled: true });
  assert.match(message, /^LeadMine scheduled run finished: 2 businesses for training in Chennai\./);
  assert.ok(message.indexOf('Fit Co') < message.indexOf('Maybe Co'), 'best first');
  assert.ok(!message.includes('Rejected Co'), 'the user said no to this one');
  assert.match(message, /Do not contact any of these leads yourself\./);
});

test('a long run is cut to the lead limit and says how many more', () => {
  const records = Array.from({ length: 40 }, (_, i) => ({ ...business, key: `k${i}`, name: `Biz ${i}` }));
  const message = buildHookMessage({ records, config: {}, maxLeads: 5 });
  assert.match(message, /…and 35 more in LeadMine\./);
  assert.ok(message.length < 12000);
});

test('the payload names LeadMine and only sets channel and recipient when given', () => {
  assert.deepEqual(hookPayload({ channel: 'last', to: '' }, 'hi'), { message: 'hi', name: 'LeadMine', deliver: true, wakeMode: 'now' });
  assert.deepEqual(hookPayload({ channel: 'telegram', to: ' 12345 ' }, 'hi'), {
    message: 'hi', name: 'LeadMine', deliver: true, wakeMode: 'now', channel: 'telegram', to: '12345',
  });
});

test('only scheduled runs are sent by default', () => {
  const on = { ...DEFAULT_HOOK, enabled: true, token: 't' };
  assert.equal(shouldSend(on, { scheduled: true }), true);
  assert.equal(shouldSend(on, { scheduled: false }), false);
  assert.equal(shouldSend({ ...on, when: 'always' }, { scheduled: false }), true);
  assert.equal(shouldSend({ ...on, token: '' }, { scheduled: true }), false, 'no token, nothing sent');
  assert.equal(shouldSend({ ...on, enabled: false }, { scheduled: true }), false);
});

test('the token goes in the Authorization header, never the URL', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 202 };
  };
  const res = await sendToPowPow({ url: 'http://127.0.0.1:18789/hooks/agent?token=leak', token: ' secret ', channel: 'last' }, 'hello', { fetchImpl });
  assert.deepEqual(res, { ok: true, status: 202, error: '' });
  assert.equal(calls[0].url, 'http://127.0.0.1:18789/hooks/agent', 'a query-string token is stripped');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.equal(JSON.parse(calls[0].init.body).message, 'hello');
});

test('a gateway refusal becomes a sentence, and a dead gateway never throws', async () => {
  const status = (s) => async () => ({ ok: false, status: s });
  assert.match((await sendToPowPow({ url: 'http://x/hooks/agent', token: 't' }, 'm', { fetchImpl: status(401) })).error, /rejected the token/);
  assert.match((await sendToPowPow({ url: 'http://x/hooks/agent', token: 't' }, 'm', { fetchImpl: status(404) })).error, /hooks\.enabled/);
  const down = await sendToPowPow({ url: 'http://x/hooks/agent', token: 't' }, 'm', {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(down.ok, false);
  assert.match(down.error, /Is the gateway running/);
  assert.match((await sendToPowPow({ url: 'not a url', token: 't' }, 'm')).error, /not a URL/);
});
