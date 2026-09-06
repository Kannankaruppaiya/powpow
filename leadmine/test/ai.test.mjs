/**
 * Tests for the search planner.
 *
 * The model is the one part of this codebase that cannot be made
 * deterministic, so everything around it is: a fake fetch drives every failure
 * the two providers can produce, and the normaliser is tested against the
 * answers a model actually gives — padded lists, near-duplicates, missing
 * fields, JSON wrapped in a code fence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planSearches,
  normalisePlan,
  parseJsonish,
  searchKey,
  planToBatch,
  providerFor,
  cleanModel,
  wrongProviderFor,
  PROVIDERS,
} from '../src/lib/ai.js';
import { buildUserPrompt, DEPTH_LIMITS } from '../src/lib/plan-prompt.js';

/* ------------------------------------------------------------- fake server */

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const res = await handler(calls.length, calls[calls.length - 1]);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.json,
      text: async () => (typeof res.text === 'string' ? res.text : JSON.stringify(res.json || {})),
    };
  };
  fn.calls = calls;
  return fn;
}

const geminiReply = (obj) => ({
  status: 200,
  json: { candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] },
});

const groqReply = (obj) => ({
  status: 200,
  json: { choices: [{ message: { content: JSON.stringify(obj) } }] },
});

const READY = {
  status: 'ready',
  understood: 'Bulk buyers for industrial cleaning chemicals near Chennai.',
  searches: [
    { query: 'facility management companies', city: 'Chennai', tier: 1, reason: 'Buy in bulk.' },
    { query: 'janitorial supply wholesalers', city: 'Chennai', tier: 2, reason: 'Resell it.' },
  ],
};

const base = {
  brief: 'I make industrial floor cleaning chemicals and want bulk buyers',
  apiKey: 'test-key',
  sleepImpl: async () => {},
};

/* ------------------------------------------------------------- the request */

test('the Gemini request carries the key in a header, never the URL', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  await planSearches({ ...base, provider: 'gemini', apiKey: 'AIza-secret', fetchImpl });

  const [call] = fetchImpl.calls;
  // A key in a query string is a key in every log and history entry it passes.
  assert.ok(!call.url.includes('AIza-secret'), 'the key must not be in the URL');
  assert.equal(call.init.headers['x-goog-api-key'], 'AIza-secret');
  assert.match(call.url, /generativelanguage\.googleapis\.com/);
});

test('the Gemini request asks the API to enforce the JSON shape', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  await planSearches({ ...base, provider: 'gemini', fetchImpl });

  const { generationConfig } = fetchImpl.calls[0].body;
  assert.equal(generationConfig.responseMimeType, 'application/json');
  assert.ok(generationConfig.responseSchema, 'a schema is the only reliable way to get JSON back');
});

test('the Groq request uses bearer auth and JSON mode', async () => {
  const fetchImpl = fakeFetch(() => groqReply(READY));
  await planSearches({ ...base, provider: 'groq', apiKey: 'gsk_secret', fetchImpl });

  const [call] = fetchImpl.calls;
  assert.equal(call.init.headers.authorization, 'Bearer gsk_secret');
  assert.ok(!call.url.includes('gsk_secret'));
  assert.equal(call.body.response_format.type, 'json_object');
  // Groq cannot enforce a schema, so the shape has to be in the prompt.
  assert.match(call.body.messages[0].content, /"searches"/);
});

test('a blank model falls back to the provider default', async () => {
  const fetchImpl = fakeFetch(() => groqReply(READY));
  await planSearches({ ...base, provider: 'groq', model: '  ', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.model, PROVIDERS.groq.defaultModel);
});

test('both sources and the typed city reach the prompt', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  await planSearches({ ...base, source: 'linkedin', city: 'Coimbatore', fetchImpl });

  const user = fetchImpl.calls[0].body.contents[0].parts[0].text;
  assert.match(user, /linkedin \(people\)/);
  assert.match(user, /Coimbatore/);
});

test('the depth cap is stated to the model as well as enforced here', () => {
  assert.match(buildUserPrompt({ brief: 'x', depth: 'quick' }), /at most 4 searches/);
  assert.match(buildUserPrompt({ brief: 'x', depth: 'deep' }), /at most 16 searches/);
  // An unknown depth must not produce "at most undefined".
  assert.match(buildUserPrompt({ brief: 'x', depth: 'nonsense' }), /at most 8 searches/);
});

/* --------------------------------------------------------------- responses */

test('a plan comes back ready to run', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  const plan = await planSearches({ ...base, fetchImpl });

  assert.equal(plan.status, 'ready');
  assert.equal(plan.searches.length, 2);
  assert.equal(plan.searches[0].query, 'facility management companies');
  assert.equal(plan.searches[0].city, 'Chennai');
});

test('a plan converts to the batch box format the queue already parses', () => {
  const text = planToBatch([
    { query: 'facility management companies', city: 'Chennai' },
    { query: 'hotel housekeeping suppliers', city: '' },
  ]);
  assert.equal(text, 'facility management companies, Chennai\nhotel housekeeping suppliers');
});

test('a clarification is passed through instead of being turned into searches', async () => {
  const fetchImpl = fakeFetch(() =>
    geminiReply({ status: 'needs_clarification', question: 'Suppliers of what?' })
  );
  const plan = await planSearches({ ...base, brief: 'I need suppliers', fetchImpl });

  assert.equal(plan.status, 'needs_clarification');
  assert.equal(plan.question, 'Suppliers of what?');
  assert.deepEqual(plan.searches, []);
});

test('JSON wrapped in a code fence is still read', () => {
  const parsed = parseJsonish('```json\n{"status":"ready"}\n```');
  assert.deepEqual(parsed, { status: 'ready' });
});

test('JSON after a chatty preamble is still read', () => {
  const parsed = parseJsonish('Sure! Here you go:\n{"status":"ready","searches":[]}');
  assert.equal(parsed.status, 'ready');
});

test('unreadable output is reported rather than half-used', async () => {
  // A model that answers in prose instead of JSON, twice.
  const fetchImpl = fakeFetch(() => ({
    status: 200,
    json: { candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] } }] },
  }));
  await assert.rejects(
    planSearches({ ...base, fetchImpl }),
    /unreadable/i
  );
});

/* ------------------------------------------------------------ normalising */

test('near-duplicate searches collapse to one', () => {
  const plan = normalisePlan({
    status: 'ready',
    searches: [
      { query: 'cleaning products', city: 'Chennai', tier: 1, reason: 'a' },
      { query: 'Cleaning Product', city: 'Chennai', tier: 1, reason: 'b' },
      { query: 'products cleaning', city: 'chennai', tier: 2, reason: 'c' },
      { query: 'janitorial suppliers', city: 'Chennai', tier: 2, reason: 'd' },
    ],
  });
  // Three spellings of one search would triple the run time for nothing.
  assert.equal(plan.searches.length, 2);
});

test('the same category in two cities is two searches, not a duplicate', () => {
  const plan = normalisePlan({
    status: 'ready',
    searches: [
      { query: 'facility management companies', city: 'Chennai', tier: 1, reason: 'a' },
      { query: 'facility management companies', city: 'Coimbatore', tier: 1, reason: 'b' },
    ],
  });
  assert.equal(plan.searches.length, 2);
});

test('the plan is capped at the depth the user chose', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    query: `category number ${i}`,
    tier: 2,
    reason: 'x',
  }));
  assert.equal(normalisePlan({ status: 'ready', searches: many }, { depth: 'quick' }).searches.length,
    DEPTH_LIMITS.quick);
  assert.equal(normalisePlan({ status: 'ready', searches: many }, { depth: 'deep' }).searches.length,
    DEPTH_LIMITS.deep);
});

test('the highest-intent searches survive the cap', () => {
  const plan = normalisePlan(
    {
      status: 'ready',
      searches: [
        { query: 'general shops', tier: 4, reason: 'wide' },
        { query: 'hotel housekeeping suppliers', tier: 3, reason: 'volume' },
        { query: 'facility management companies', tier: 1, reason: 'direct' },
        { query: 'janitorial wholesalers', tier: 2, reason: 'resell' },
      ],
    },
    { depth: 'quick' }
  );
  assert.deepEqual(
    plan.searches.map((s) => s.tier),
    [1, 2, 3, 4],
    'a truncated list must keep the best of it, so it is sorted before slicing'
  );
});

test('the form’s city fills in for a search that did not name one', () => {
  const plan = normalisePlan(
    { status: 'ready', searches: [{ query: 'gyms', reason: 'x' }] },
    { city: 'Thanjavur' }
  );
  assert.equal(plan.searches[0].city, 'Thanjavur');
});

test('a search with no query is dropped, not run as an empty search', () => {
  const plan = normalisePlan({
    status: 'ready',
    searches: [{ query: '   ', reason: 'x' }, { query: 'gyms', reason: 'y' }],
  });
  assert.equal(plan.searches.length, 1);
});

test('"ready" with nothing in it is an error, not an empty run', () => {
  assert.throws(() => normalisePlan({ status: 'ready', searches: [] }), /no searches/i);
});

test('a missing tier sorts last rather than crashing the sort', () => {
  const plan = normalisePlan({
    status: 'ready',
    searches: [{ query: 'gyms', reason: 'x' }, { query: 'dentists', tier: 1, reason: 'y' }],
  });
  assert.equal(plan.searches[0].query, 'dentists');
  assert.equal(plan.searches[1].tier, 4);
});

test('an over-long query is clipped rather than sent to Maps whole', () => {
  const plan = normalisePlan({
    status: 'ready',
    searches: [{ query: 'a'.repeat(400), reason: 'b'.repeat(900) }],
  });
  assert.ok(plan.searches[0].query.length <= 80);
  assert.ok(plan.searches[0].reason.length <= 200);
});

test('searchKey treats plurals and word order as the same search', () => {
  assert.equal(searchKey('Cleaning Products'), searchKey('product cleaning'));
  assert.notEqual(searchKey('dentists'), searchKey('gyms'));
  // "ss" endings are not plurals — business must not become busines-adjacent.
  assert.equal(searchKey('business'), 'business');
});

/* ------------------------------------------------------------- the failures */

test('a rejected key says so, and does not retry', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401, json: {}, text: 'unauthorised' }));
  await assert.rejects(planSearches({ ...base, fetchImpl }), /key was rejected/i);
  assert.equal(fetchImpl.calls.length, 1, 'a bad key will be just as bad the second time');
});

test('a wrong model name points at the setting that is wrong', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 404, json: {}, text: 'not found' }));
  await assert.rejects(planSearches({ ...base, fetchImpl }), /rejected the model/i);
});

test('a rate limit is retried once, then reported', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 429, json: {}, text: 'slow down' }));
  await assert.rejects(planSearches({ ...base, fetchImpl }), /rate-limiting/i);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a transient server error is retried and can succeed', async () => {
  const fetchImpl = fakeFetch((n) =>
    n === 1 ? { status: 503, json: {}, text: 'busy' } : geminiReply(READY)
  );
  const plan = await planSearches({ ...base, fetchImpl });
  assert.equal(plan.searches.length, 2);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a network failure is reported in words that suggest a fix', async () => {
  const fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    planSearches({ ...base, fetchImpl, sleepImpl: async () => {} }),
    /Could not reach the planner/i
  );
});

test('a timeout says it timed out rather than failing silently', async () => {
  const fetchImpl = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  await assert.rejects(
    planSearches({ ...base, fetchImpl, sleepImpl: async () => {} }),
    /took too long/i
  );
});

test('an error message never echoes the API key back', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 400, json: {}, text: 'bad request' }));
  await assert.rejects(
    planSearches({ ...base, apiKey: 'AIza-super-secret', fetchImpl }),
    (err) => !err.message.includes('AIza-super-secret')
  );
});

test('no key and no brief are caught before any request is made', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  await assert.rejects(planSearches({ ...base, apiKey: '', fetchImpl }), /Add an API key/i);
  await assert.rejects(planSearches({ ...base, brief: '  ', fetchImpl }), /Describe what/i);
  assert.equal(fetchImpl.calls.length, 0);
});

test('an unknown provider falls back rather than throwing on a typo', () => {
  assert.equal(providerFor('nope').id, 'gemini');
  assert.equal(providerFor('groq').id, 'groq');
});

/* ------------------------------------------------------ model and key shape */

test('a model name that cannot be one falls back to the default', () => {
  // The live failure: something that was not a model name reached the API and
  // came back as "unexpected model name format", which explains nothing.
  assert.equal(cleanModel('gsk_abc123DEF', 'gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(cleanModel('', 'gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(cleanModel('   ', 'gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(cleanModel('a model with spaces', 'gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(cleanModel('x'.repeat(200), 'gemini-2.5-flash'), 'gemini-2.5-flash');
});

test('a real model name is kept, however the docs write it', () => {
  assert.equal(cleanModel('gemini-2.5-pro', 'x'), 'gemini-2.5-pro');
  assert.equal(cleanModel('  llama-3.3-70b-versatile  ', 'x'), 'llama-3.3-70b-versatile');
  // The docs write "models/gemini-2.5-flash"; the URL adds that prefix itself.
  assert.equal(cleanModel('models/gemini-2.5-flash', 'x'), 'gemini-2.5-flash');
});

test('junk in the model box never reaches the request', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  await planSearches({ ...base, apiKey: 'AIza-test', model: 'not a model!!', fetchImpl });
  assert.match(fetchImpl.calls[0].url, /models\/gemini-2\.5-flash:generateContent/);
});

test('a key belonging to the other provider is named as such', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  // Both keys are opaque strings in a password box; pasting the wrong one is
  // easy, and the provider's own reply for it explains nothing.
  await assert.rejects(
    planSearches({ ...base, provider: 'gemini', apiKey: 'gsk_abc', fetchImpl }),
    /looks like a Groq key.*Google Gemini is selected/i
  );
  await assert.rejects(
    planSearches({ ...base, provider: 'groq', apiKey: 'AIzaSyAbc', fetchImpl }),
    /looks like a Google Gemini key.*Groq is selected/i
  );
  assert.equal(fetchImpl.calls.length, 0, 'caught before spending a request');
});

test('the matching key is not mistaken for the wrong provider’s', async () => {
  const fetchImpl = fakeFetch(() => geminiReply(READY));
  await planSearches({ ...base, provider: 'gemini', apiKey: 'AIzaSyAbc', fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(wrongProviderFor('some-other-format'), null, 'an unknown shape is not blocked');
});

test('a model the provider rejects points at the box to clear', async () => {
  const fetchImpl = fakeFetch(() => ({
    status: 400,
    json: {},
    text: '{"error":{"message":"* GenerateContentRequest.model: unexpected model name format"}}',
  }));
  await assert.rejects(
    planSearches({ ...base, apiKey: 'AIza-test', model: 'gemini-9-turbo', fetchImpl }),
    /rejected the model "gemini-9-turbo".*Clear the Model box/is
  );
});
