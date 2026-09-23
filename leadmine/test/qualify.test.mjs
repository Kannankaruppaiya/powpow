/**
 * The lead judge.
 *
 * The model is not deterministic, so everything around it is: the digest it
 * reads, the examples it is shown, the batches it is sent, and — most of all
 * — the checking of what comes back, because a model's answer is untrusted
 * input that ends up in the user's spreadsheet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  kindOf,
  leadDigest,
  examplesFrom,
  buildJudgePrompt,
  normaliseJudgement,
  batchesOf,
  judgeLeads,
  effectiveVerdict,
  JUDGE_SCHEMA,
  JUDGE_SPEC,
} from '../src/lib/qualify.js';

const business = {
  key: 'fid:1', source: 'maps', name: 'Acme Corporate Training', category: 'Training centre',
  area: 'Guindy', city: 'Chennai', rating: '4.6', reviews: '120', website: 'https://acme.in',
  phone: '+91 98765 43210', email: 'info@acme.in',
  siteText: 'Acme runs instructor-led SAP and ServiceNow courses for corporate teams.',
  sitePeople: 'Ravi Kumar (Founder)',
};
const person = {
  key: 'li:priya', source: 'linkedin', name: 'Priya Raman', headline: 'SAP FI Trainer | 12 years',
  company: 'Freelance', location: 'Chennai', profileUrl: 'https://www.linkedin.com/in/priya',
};
const post = {
  key: 'post:7500139413100740609', source: 'posts', author: 'Arun', ageDays: 2,
  text: 'Urgent requirement: SAP FI trainer for a 5-day corporate batch in Pune. Share your profile.',
  emails: 'hr@corp.in',
};

test('each kind of lead is recognised', () => {
  assert.equal(kindOf(business), 'business');
  assert.equal(kindOf(person), 'person');
  assert.equal(kindOf({ source: 'web' }), 'person');
  assert.equal(kindOf(post), 'post');
  assert.equal(kindOf({}), 'business');
});

test('the digest carries what bears on fit and leaves contact details out', () => {
  const d = leadDigest(business);
  assert.match(d, /Business: Acme Corporate Training/);
  assert.match(d, /Website text: Acme runs instructor-led/);
  assert.match(d, /People named on the site: Ravi Kumar/);
  assert.ok(!d.includes('98765'), 'no phone number goes to the model');
  assert.ok(!d.includes('info@acme.in'), 'no email goes to the model');

  assert.match(leadDigest(person), /Headline: SAP FI Trainer/);
  const p = leadDigest(post);
  assert.match(p, /Posted: 2 days ago/);
  assert.ok(!p.includes('hr@corp.in'));
});

test('the user’s own marks become examples, both sides of the line', () => {
  const records = [
    business,
    { ...business, key: 'fid:2', name: 'Bravo Institute' },
    { ...business, key: 'fid:3', name: 'Charlie Cafe' },
    person,
  ];
  const notes = new Map([
    ['fid:1', { key: 'fid:1', feedback: 'good', feedbackAt: 3 }],
    ['fid:2', { key: 'fid:2', feedback: 'good', feedbackAt: 2 }],
    ['fid:3', { key: 'fid:3', feedback: 'bad', feedbackAt: 1 }],
    ['li:priya', { key: 'li:priya', feedback: 'good', feedbackAt: 9 }],
  ]);
  const ex = examplesFrom(records, notes, { kind: 'business', limit: 2 });
  assert.equal(ex.length, 2);
  assert.deepEqual(ex.map((e) => e.verdict), ['fit', 'no_fit'], 'a good one and a bad one, not two good');
  assert.ok(ex.every((e) => e.digest.startsWith('Business:')), 'only examples of the same kind');
});

test('the prompt holds the brief, the rules for the kind, the examples and the leads', () => {
  const prompt = buildJudgePrompt({
    brief: 'Companies that need SAP trainers',
    kind: 'post',
    leads: [{ id: 'L1', digest: leadDigest(post) }],
    examples: [{ digest: 'Author: X', verdict: 'no_fit', why: 'selling a course' }],
  });
  assert.match(prompt, /WHAT THE USER IS LOOKING FOR:\nCompanies that need SAP trainers/);
  assert.match(prompt, /ASKING for what the\nuser offers/);
  assert.match(prompt, /Example 1 → no_fit \(selling a course\)/);
  assert.match(prompt, /\[L1\]\nAuthor: Arun/);
});

test('the model’s answer is checked before anything is written', () => {
  const raw = {
    results: [
      { id: 'L1', verdict: 'fit', reason: '  Runs corporate SAP courses.  ', services: 'SAP courses', decision_maker: 'Ravi Kumar', size: 'Small' },
      { id: 'L2', verdict: 'Not a fit', reason: 'x' },
      { id: 'L3', verdict: 'no-fit', reason: 'A cafe.' },
      { id: 'L9', verdict: 'fit', reason: 'never sent' },
      { id: 'L1', verdict: 'no_fit', reason: 'duplicate' },
      { id: '[L4]', verdict: 'MAYBE', reason: 'r'.repeat(500), size: 'enormous' },
    ],
  };
  const out = normaliseJudgement(raw, ['L1', 'L2', 'L3', 'L4']);
  assert.deepEqual(out.get('L1'), {
    verdict: 'fit', reason: 'Runs corporate SAP courses.', services: 'SAP courses',
    decisionMaker: 'Ravi Kumar', size: 'small',
  });
  assert.equal(out.has('L2'), false, 'a verdict outside the three is dropped');
  assert.equal(out.get('L3').verdict, 'no_fit', 'no-fit is read as no_fit');
  assert.equal(out.has('L9'), false, 'an id we never sent is dropped');
  assert.equal(out.get('L4').verdict, 'maybe');
  assert.equal(out.get('L4').reason.length, 240, 'clipped');
  assert.equal(out.get('L4').size, '', 'an unknown size is blank, not invented');
  assert.equal(normaliseJudgement(null, ['L1']).size, 0);
});

test('batches are one kind each and no larger than asked', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...business, key: `b${i}` }));
  const batches = batchesOf([...many, person, post], 12);
  assert.deepEqual(batches.map((b) => [b.kind, b.records.length]), [
    ['business', 12], ['business', 12], ['business', 1], ['person', 1], ['post', 1],
  ]);
});

test('the schema asks for the three verdicts and the reason', () => {
  assert.deepEqual(JUDGE_SCHEMA.properties.results.items.properties.verdict.enum, ['fit', 'maybe', 'no_fit']);
  assert.equal(JUDGE_SPEC.gemini.type, 'OBJECT', 'converted to Gemini’s dialect');
  assert.match(JUDGE_SPEC.hint, /"verdict":"fit"/);
});

function fakeGemini(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const text = typeof answer === 'function' ? answer(calls.length, calls.at(-1)) : answer;
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(text) }] } }] }),
      text: async () => '',
    };
  };
  return { fetchImpl, calls };
}

test('judging returns note patches and reports each batch as it lands', async () => {
  const records = [business, { ...business, key: 'fid:2', name: 'Charlie Cafe', siteText: 'Coffee.' }];
  const { fetchImpl, calls } = fakeGemini({
    results: [
      { id: 'L1', verdict: 'fit', reason: 'Trains corporate teams on SAP.' },
      { id: 'L2', verdict: 'no_fit', reason: 'A cafe.' },
    ],
  });
  const seen = [];
  const patches = await judgeLeads({
    records,
    brief: 'Companies that train corporate teams on SAP',
    apiKey: 'AIzaTEST',
    fetchImpl,
    sleepImpl: async () => {},
    onBatch: (batch, progress) => seen.push([batch.length, progress.done, progress.total]),
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.generationConfig.responseSchema.properties.results, 'the judge’s schema, not the planner’s');
  assert.match(calls[0].body.contents[0].parts[0].text, /Companies that train corporate teams on SAP/);
  assert.deepEqual(patches.map((p) => [p.key, p.verdict]), [['fid:1', 'fit'], ['fid:2', 'no_fit']]);
  assert.ok(patches.every((p) => p.judgedAt && p.judgedBy.startsWith('gemini')));
  assert.deepEqual(seen, [[2, 2, 2]]);
});

test('a lead the model skipped stays unjudged instead of failing the batch', async () => {
  const { fetchImpl } = fakeGemini({ results: [{ id: 'L2', verdict: 'maybe', reason: 'Unclear.' }] });
  const patches = await judgeLeads({
    records: [business, { ...business, key: 'fid:2', name: 'Bravo' }],
    brief: 'x',
    apiKey: 'AIzaTEST',
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.deepEqual(patches.map((p) => [p.key, p.verdict]), [['fid:2', 'maybe']], 'only the answered lead');
});

test('judging needs a brief and stops when asked', async () => {
  await assert.rejects(judgeLeads({ records: [business], brief: ' ', apiKey: 'AIzaTEST' }), /good lead looks like/);
  const { fetchImpl, calls } = fakeGemini({ results: [] });
  await judgeLeads({
    records: [business, person, post],
    brief: 'x',
    apiKey: 'AIzaTEST',
    fetchImpl,
    sleepImpl: async () => {},
    shouldStop: () => calls.length >= 1,
  });
  assert.equal(calls.length, 1, 'no batch after the stop');
});

test('a key for the other provider is caught before any request', async () => {
  const { fetchImpl, calls } = fakeGemini({ results: [] });
  await assert.rejects(
    judgeLeads({ records: [business], brief: 'x', provider: 'gemini', apiKey: 'gsk_groqkey', fetchImpl }),
    /Groq key/
  );
  assert.equal(calls.length, 0);
});

test('the user’s own mark beats the model’s verdict', () => {
  assert.equal(effectiveVerdict({ verdict: 'fit', feedback: 'bad' }), 'no_fit');
  assert.equal(effectiveVerdict({ verdict: 'no_fit', feedback: 'good' }), 'fit');
  assert.equal(effectiveVerdict({ verdict: 'maybe' }), 'maybe');
  assert.equal(effectiveVerdict(null), '');
});
