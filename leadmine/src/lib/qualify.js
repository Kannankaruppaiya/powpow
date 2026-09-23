/**
 * The lead judge.
 *
 * A run hands back six hundred businesses and nothing about which of them are
 * worth a call. Reading every row is the job this does instead: each lead is
 * read against the user's own description of a good one, and comes back with
 * a verdict and — the part that matters — the reason for it, in a sentence
 * the user can disagree with. That idea is OpenOutreach's: the reason is the
 * product, and correcting the description is how a wrong verdict is fixed.
 *
 * The same call also reads what the business's own website says (collected
 * during the email pass) and pulls out what a spreadsheet cannot: what they
 * actually sell, who runs the place, and how big it looks. For posts, it is a
 * second opinion on the keyword classifier — "is this person asking for what
 * I offer?" is a question words-in-a-list answer badly.
 *
 * The user's own thumbs-up and thumbs-down travel with every call as worked
 * examples, so the judge learns what this user means by "fit" rather than
 * what the model assumes. No model is trained; the examples are the memory.
 *
 * Runs in the side panel, never the worker: the API key lives there and only
 * there (see ai.js), and a judge the user did not press is a bill they did not
 * choose.
 */

import { requestJson, responseSpec, DEFAULT_PROVIDER } from './ai.js';

export const VERDICTS = ['fit', 'maybe', 'no_fit'];

/** How many leads go in one request. Large enough to be cheap, small enough to answer well. */
export const BATCH_SIZE = 12;

/** How many of the user's own judgements ride along as examples. */
export const MAX_EXAMPLES = 8;

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** What kind of lead a record is — the prompt asks different things of each. */
export function kindOf(record) {
  if (!record) return 'business';
  if (record.source === 'posts') return 'post';
  if (record.source === 'linkedin' || record.source === 'web') return 'person';
  return 'business';
}

/**
 * One lead as the model reads it: the fields that bear on fit, nothing else.
 *
 * Phones and emails are left out on purpose. They say nothing about fit, and
 * a prompt is a third party — the less contact data leaves the browser for a
 * judgement that does not need it, the better.
 */
export function leadDigest(record) {
  const kind = kindOf(record);
  if (kind === 'post') {
    return [
      `Author: ${clip(record.author || record.name, 80)}`,
      record.ageDays !== '' && record.ageDays !== undefined ? `Posted: ${record.ageDays} days ago` : '',
      `Post: ${clip(record.text || record.summary || record.headline, 900)}`,
    ].filter(Boolean).join('\n');
  }
  if (kind === 'person') {
    return [
      `Name: ${clip(record.name, 80)}`,
      record.headline ? `Headline: ${clip(record.headline, 200)}` : '',
      record.company ? `Company: ${clip(record.company, 100)}` : '',
      record.location ? `Location: ${clip(record.location, 80)}` : '',
      record.summary ? `Context: ${clip(record.summary, 300)}` : '',
      record.openToWork ? 'Open to work: yes' : '',
    ].filter(Boolean).join('\n');
  }
  return [
    `Business: ${clip(record.name, 100)}`,
    record.category ? `Category: ${clip(record.category, 80)}` : '',
    [record.area, record.city].filter(Boolean).length
      ? `Where: ${clip([record.area, record.city].filter(Boolean).join(', '), 100)}`
      : '',
    record.rating ? `Rating: ${record.rating} (${record.reviews || 0} reviews)` : '',
    record.website ? `Website: ${clip(record.website, 100)}` : 'Website: none',
    record.employees ? `Employees: ${clip(record.employees, 30)}` : '',
    record.sitePeople ? `People named on the site: ${clip(record.sitePeople, 200)}` : '',
    record.siteDescription ? `Says about itself: ${clip(record.siteDescription, 300)}` : '',
    record.siteText ? `Website text: ${clip(record.siteText, 900)}` : '',
  ].filter(Boolean).join('\n');
}

const KIND_RULES = {
  business: `Each lead is a business. Judge whether it is a likely BUYER or USER of what
the user offers. Also fill in, from the website text only (never invent):
- services: what the business actually sells or does, in under 12 words
- decision_maker: a named owner, founder, director or manager if the text names one, else ""
- size: "solo", "small", "medium" or "large" from the evidence, else ""`,
  person: `Each lead is a person. Judge whether this person fits who the user is looking
for — the role, the skill, the seniority, the place. A headline is self-description,
so weigh what they say they do, not keywords alone. Leave services, decision_maker and
size as "".`,
  post: `Each lead is a social media post. Judge whether the author is ASKING for what the
user offers — a genuine requirement or opening — rather than selling it, advertising
a course, celebrating a finished session, or posting about something else. In
"services", say in under 12 words what the post is asking for. Leave decision_maker
and size as "".`,
};

export const JUDGE_SYSTEM = `You are the lead judge for a lead-generation tool. The user describes
what a good lead looks like for them. You read a batch of leads and decide, for each one,
whether it fits.

Verdicts:
- "fit": clearly worth contacting for this user's purpose
- "maybe": plausible, but something important is missing or unclear
- "no_fit": clearly not what the user wants

The reason is the most important field. One plain sentence, under 25 words, that names
the specific evidence — "Runs a 40-seat corporate training centre in Guindy; needs
trainers" — not a restatement of the verdict. Say what is missing when it is "maybe".

Judge only from what each lead says. Never invent facts. A lead with too little
information to judge is "maybe", with the reason saying what was missing.

When the user has judged earlier leads themselves, those examples show what THEY mean by
a fit. Follow them over your own assumptions.

Return one result per lead, using the lead's id exactly as given.`;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: VERDICTS },
          reason: { type: 'string' },
          services: { type: 'string' },
          decision_maker: { type: 'string' },
          size: { type: 'string' },
        },
        required: ['id', 'verdict', 'reason'],
      },
    },
  },
  required: ['results'],
};

const JUDGE_HINT = `Reply with JSON only, in this exact shape:
{"results":[{"id":"L1","verdict":"fit","reason":"one sentence naming the evidence",
  "services":"","decision_maker":"","size":""}]}
verdict is exactly one of "fit", "maybe", "no_fit".`;

export const JUDGE_SPEC = responseSpec(JUDGE_SCHEMA, JUDGE_HINT);

/**
 * The user's own judgements, as examples the judge must follow.
 *
 * Newest first, both kinds represented when there are both — eight thumbs-up
 * teach nothing about where the line is.
 */
export function examplesFrom(records, notes, { kind, limit = MAX_EXAMPLES } = {}) {
  const byKey = new Map((records || []).map((r) => [r.key, r]));
  const marked = [...(notes instanceof Map ? notes.values() : notes || [])]
    .filter((n) => n && (n.feedback === 'good' || n.feedback === 'bad') && byKey.has(n.key))
    .filter((n) => !kind || kindOf(byKey.get(n.key)) === kind)
    .sort((a, b) => (b.feedbackAt || b.updatedAt || 0) - (a.feedbackAt || a.updatedAt || 0));

  const good = marked.filter((n) => n.feedback === 'good');
  const bad = marked.filter((n) => n.feedback === 'bad');
  const out = [];
  // Alternate, so a short list still shows both sides of the line.
  while (out.length < limit && (good.length || bad.length)) {
    if (good.length) out.push(good.shift());
    if (out.length < limit && bad.length) out.push(bad.shift());
  }
  return out.map((note) => ({
    digest: leadDigest(byKey.get(note.key)),
    verdict: note.feedback === 'good' ? 'fit' : 'no_fit',
    why: clip(note.feedbackWhy || '', 160),
  }));
}

/** The user message for one batch. Ids are ours, short, and positional. */
export function buildJudgePrompt({ brief, kind, leads, examples = [] }) {
  const parts = [
    `WHAT THE USER IS LOOKING FOR:\n${clip(brief, 1500)}`,
    KIND_RULES[kind] || KIND_RULES.business,
  ];
  if (examples.length) {
    parts.push(
      'THE USER JUDGED THESE THEMSELVES — follow their judgement:\n' +
        examples
          .map((ex, i) => `Example ${i + 1} → ${ex.verdict}${ex.why ? ` (${ex.why})` : ''}\n${ex.digest}`)
          .join('\n\n')
    );
  }
  parts.push(
    'LEADS TO JUDGE:\n' + leads.map((lead) => `[${lead.id}]\n${lead.digest}`).join('\n\n')
  );
  return parts.join('\n\n');
}

/**
 * Re-check the model's answer before it is written anywhere.
 *
 * Model output is untrusted input: an id we did not send is dropped, a verdict
 * outside the three is dropped, every string is clipped. Returns a Map from
 * our id to a clean result.
 */
export function normaliseJudgement(raw, ids) {
  const wanted = new Set(ids);
  const out = new Map();
  for (const item of (raw && Array.isArray(raw.results) ? raw.results : [])) {
    const id = clip(item && item.id, 20).replace(/^\[|\]$/g, '');
    if (!wanted.has(id) || out.has(id)) continue;
    const verdict = String((item && item.verdict) || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!VERDICTS.includes(verdict)) continue;
    const size = clip(item.size, 20).toLowerCase();
    out.set(id, {
      verdict,
      reason: clip(item.reason, 240),
      services: clip(item.services, 120),
      decisionMaker: clip(item.decision_maker, 120),
      size: ['solo', 'small', 'medium', 'large'].includes(size) ? size : '',
    });
  }
  return out;
}

/** Split records into batches of one kind each — one prompt, one set of rules. */
export function batchesOf(records, size = BATCH_SIZE) {
  const byKind = new Map();
  for (const record of records || []) {
    const kind = kindOf(record);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(record);
  }
  const out = [];
  for (const [kind, list] of byKind) {
    for (let i = 0; i < list.length; i += size) out.push({ kind, records: list.slice(i, i + size) });
  }
  return out;
}

/**
 * Judge leads, batch by batch, reporting as it goes.
 *
 * Returns note patches — [{ key, verdict, reason, services, decisionMaker,
 * size, judgedAt, judgedBy }] — for the caller to store. `onBatch` receives
 * each batch's patches as soon as they exist, so a long run shows verdicts
 * arriving and a failure halfway keeps everything already judged.
 *
 * A batch the model answers only in part is not an error: the leads it
 * skipped simply stay unjudged and can be judged again.
 */
export async function judgeLeads({
  records,
  brief,
  notes = new Map(),
  allRecords = records,
  provider = DEFAULT_PROVIDER,
  apiKey = '',
  model = '',
  batchSize = BATCH_SIZE,
  onBatch = () => {},
  shouldStop = () => false,
  fetchImpl,
  sleepImpl,
} = {}) {
  const text = String(brief || '').trim();
  if (!text) throw new Error('Describe what a good lead looks like first.');
  if (!records || !records.length) return [];

  const patches = [];
  const batches = batchesOf(records, batchSize);
  let done = 0;

  for (const batch of batches) {
    if (shouldStop()) break;
    const leads = batch.records.map((record, i) => ({ id: `L${i + 1}`, record, digest: leadDigest(record) }));
    const examples = examplesFrom(allRecords, notes, { kind: batch.kind });

    const raw = await requestJson({
      provider,
      apiKey,
      model,
      system: JUDGE_SYSTEM,
      user: buildJudgePrompt({ brief: text, kind: batch.kind, leads, examples }),
      spec: JUDGE_SPEC,
      what: 'lead judge',
      timeout: 60000,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(sleepImpl ? { sleepImpl } : {}),
    });

    const results = normaliseJudgement(raw, leads.map((l) => l.id));
    const at = Date.now();
    const batchPatches = [];
    for (const lead of leads) {
      const result = results.get(lead.id);
      if (!result) continue;
      batchPatches.push({
        key: lead.record.key,
        ...result,
        judgedAt: at,
        judgedBy: `${provider}${model ? `:${model}` : ''}`,
      });
    }
    patches.push(...batchPatches);
    done += batch.records.length;
    await onBatch(batchPatches, { done, total: records.length });
  }
  return patches;
}

/**
 * The verdict to show and act on: the user's own mark wins over the model's.
 *
 * A thumbs-down on a "fit" is the user correcting the judge, and everything
 * downstream — the filter, the email finder, the export — has to follow the
 * correction rather than the thing corrected.
 */
export function effectiveVerdict(note) {
  if (!note) return '';
  if (note.feedback === 'good') return 'fit';
  if (note.feedback === 'bad') return 'no_fit';
  return note.verdict || '';
}

export const VERDICT_LABEL = { fit: 'Fit', maybe: 'Maybe', no_fit: 'Not a fit' };
