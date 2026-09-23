/**
 * LinkedIn posts: when they were written, and whether they ask for something.
 *
 * The Posts source exists for one question — "who posted in the last ten days
 * that they need a corporate trainer?" — and both halves of that question are
 * harder than they look.
 *
 * **When.** A search engine's date filter is its own date, not LinkedIn's. It
 * is when the engine first saw the page, and engines index LinkedIn posts one
 * to three weeks late; asked on the 23rd for the last ten days, the newest
 * "trainer requirement" post one engine had was from the 7th. So a "past week"
 * filter both lets old posts through and cannot promise new ones. What does
 * not drift is the post's own id: LinkedIn ids are snowflakes, and the top 41
 * bits are the millisecond the post was created. `id >> 22` is the post time,
 * exactly, from the URL alone — no login, no page load, no guess.
 *
 * **Asks for something.** The same words that mark a requirement mark its
 * opposite. "Corporate trainer required" is a lead; "I am a corporate trainer,
 * available for sessions" is a trainer selling; "Successfully conducted a
 * corporate training at Acme" is a thank-you post; "New batch starts Monday,
 * enrol now" is an institute advertising. All four match a keyword search for
 * "corporate training". The classifier scores cues for each and names the
 * ones it saw, so a row can be judged by reading why it was kept.
 *
 * Pure functions only: the worker runs them over what an adapter collected,
 * and the tests run them without a browser.
 */

/** A post id in any of the URL shapes LinkedIn and the engines use. */
const POST_ID = /(?:activity|ugcPost|share)(?:%3A|:|-)(\d{18,20})(?!\d)/i;

/** Posts only exist since LinkedIn moved to snowflake ids; older is noise. */
const EARLIEST = Date.UTC(2014, 0, 1);
const DAY = 24 * 60 * 60 * 1000;

/** The post id a URL carries, or ''. */
export function postIdFrom(url) {
  let text = String(url || '');
  try {
    text = decodeURIComponent(text);
  } catch {
    /* a stray % — read it as it is */
  }
  const match = text.match(POST_ID);
  return match ? match[1] : '';
}

/**
 * When a post was created, in epoch milliseconds, from its id alone.
 *
 * Returns null for anything that does not decode to a plausible moment — a
 * number that is not a LinkedIn id decodes to 1970 or to the far future, and
 * either would be a confident wrong date.
 */
export function postedAtFromId(id, now = Date.now()) {
  if (!/^\d{18,20}$/.test(String(id || ''))) return null;
  let ms;
  try {
    ms = Number(BigInt(id) >> 22n);
  } catch {
    return null;
  }
  return ms >= EARLIEST && ms <= now + DAY ? ms : null;
}

/** The one URL that opens a post, whichever URL it was found under. */
export function postUrlFor(id) {
  return id ? `https://www.linkedin.com/feed/update/urn:li:activity:${id}/` : '';
}

const collapse = (s) =>
  String(s || '')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/* ------------------------------------------------------------- contacts */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/*
 * Post text is flattened by the engine, so an address and the next word run
 * together: "vandana@gmail.comto us". Only the three commonest endings are
 * repaired, and only when what follows them is too short to be a real ending
 * of its own — ".company" and ".network" are real TLDs and are left alone.
 */
const GLUED_TLD = /\.(com|net|org)([a-z]{1,3})$/i;

function cleanEmail(raw) {
  let email = raw.replace(/[.\-_]+$/, '');
  const glued = email.match(GLUED_TLD);
  if (glued) email = email.slice(0, email.length - glued[2].length);
  return email.toLowerCase();
}

/*
 * A phone number, in the shapes posts actually write them:
 * "88617 81909", "+91-9876543210", "+971 50 123 4567", "(044) 2345 6789".
 * Ten to thirteen digits once separators are gone: fewer is a price or a
 * year, more is a post id or an account number.
 */
const PHONE = /(?<![\w+])\+?\(?\d[\d\s().-]{7,18}\d(?![\w])/g;

function cleanPhones(text) {
  const out = [];
  for (const raw of text.match(PHONE) || []) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) continue;
    // A run of one digit is a placeholder, not a number.
    if (/^(\d)\1+$/.test(digits)) continue;
    // Dates written with dashes or dots: 2026-09-13, 13.09.2026.
    if (/^\d{4}[-.]\d{2}[-.]\d{2}$|^\d{2}[-.]\d{2}[-.]\d{4}$/.test(raw.trim())) continue;
    out.push(collapse(raw));
  }
  return out;
}

/** Every email address and phone number written in a post. */
export function contactsIn(text) {
  const flat = String(text || '');
  const emails = [...new Set((flat.match(EMAIL) || []).map(cleanEmail))];
  const phones = [...new Set(cleanPhones(flat))];
  return { emails, phones };
}

/* --------------------------------------------------------------- intent */

/*
 * Cues, each with the label a row shows when it fires. Weights are small
 * integers on purpose: a cue either says "asking" strongly (2) or only
 * suggests it (1), and a finer scale would be precision nobody measured.
 */
const DEMAND = [
  { re: /\b(?:looking|searching)\s+for\b/i, label: 'looking for', w: 2 },
  { re: /\brequire(?:d|ment|ments)?\b/i, label: 'requirement', w: 2 },
  // "Trainer needed" and "need a trainer" — not "need to thank", which is
  // how half of all thank-you posts open.
  { re: /\bneeded\b|\bneed\s+(?:an?|some|experienced|freelance|certified|good)\b/i, label: 'need', w: 2 },
  { re: /\burgent(?:ly)?\b|\bimmediate(?:ly)?\b|\basap\b/i, label: 'urgent', w: 1 },
  { re: /\bwe(?:'re| are)? hiring\b|\bhiring\b/i, label: 'hiring', w: 1 },
  { re: /\bseeking\b|\bwanted\b/i, label: 'seeking', w: 1 },
  { re: /\b(?:share|send|drop|mail)\s+(?:your|their|me your|us your)?\s*(?:updated\s+)?(?:profile|cv|resume|details)\b/i, label: 'share your profile', w: 2 },
  { re: /\binterested\s+(?:trainers?|candidates?|consultants?|freelancers?|vendors?|professionals?|experts?)\b/i, label: 'interested trainers', w: 2 },
  { re: /\bcommercials?\b|\bper\s+(?:day|hour|session)\b|\bbudget\b/i, label: 'commercials', w: 1 },
  { re: /\b(?:rfp|rfq|empanel(?:ment|led)?|vendor(?:s)?\s+(?:required|needed|wanted))\b/i, label: 'vendor ask', w: 2 },
  { re: /\b(?:can|could)\s+anyone\s+(?:recommend|suggest|refer)\b|\b(?:any|please)\s+(?:recommendations?|referrals?|leads?)\b/i, label: 'asking for referrals', w: 2 },
  { re: /\b(?:dm|inbox|ping|whatsapp)\s+(?:me|us)\b|\bconnect with me\b/i, label: 'contact me', w: 1 },
];

const SUPPLY = [
  { re: /#opentowork|\bopen to (?:work|opportunities|new opportunities)\b/i, label: 'open to work' },
  { re: /\bI(?:'m| am)\s+(?:an?\s+)?(?:\w+\s+){0,4}(?:trainer|consultant|coach|facilitator|freelancer|speaker)\b/i, label: 'introduces self' },
  { re: /\bI(?:'m| am)\s+available\b|\bavailable for\s+(?:corporate\s+)?(?:training|sessions?|workshops?|assignments?)\b/i, label: 'available' },
  { re: /\b(?:my|our)\s+(?:training\s+)?(?:services|offerings|programs?|courses?)\b/i, label: 'own services' },
  { re: /\b(?:we|I)\s+(?:offer|provide|deliver)\b/i, label: 'offers' },
  { re: /\benrol+(?:ment)?(?:\s+now)?\b|\bregister\s+(?:now|here|today)\b|\blimited seats\b/i, label: 'enrol now' },
  { re: /\bnew batch\b|\bbatch (?:starts?|starting)\b|\bdemo (?:class|session)\b|\bcourse fees?\b/i, label: 'course advert' },
  { re: /\bjoin\s+(?:our|us|the|this)\s+(?:\w+\s+)?(?:course|batch|program(?:me)?|workshop|masterclass|webinar|bootcamp)\b/i, label: 'join our course' },
  { re: /\bbook\s+(?:a|your)\s+(?:free\s+)?(?:slot|seat|call|demo)\b/i, label: 'book a slot' },
  // A pitch borrows the buyer's words: "if you require corporate training,
  // contact us" contains "require" and is an advert.
  { re: /\bif\s+(?:you|your\s+(?:team|company|organi[sz]ation))\s+(?:require|need|are looking for|is looking for)\b/i, label: 'if you need' },
  // "Looking for new opportunities" is a job seeker, not a buyer.
  { re: /\blooking for\s+(?:a\s+)?(?:new\s+)?(?:opportunit(?:y|ies)|jobs?|roles?|positions?|assignments|openings)\b/i, label: 'job seeker' },
];

const RECAP = [
  { re: /\b(?:successfully\s+)?(?:conducted|delivered|completed|concluded|wrapped up|facilitated)\b.{0,60}\b(?:session|training|workshop|program(?:me)?|bootcamp)s?\b/i, label: 'session done' },
  { re: /\bthank(?:s| you)\b.{0,80}\bopportunit(?:y|ies)\b/i, label: 'thanks for the opportunity' },
  { re: /\b(?:grateful|honou?red|privileged|humbled)\b/i, label: 'grateful' },
  { re: /\b(?:happy|excited|thrilled|glad|delighted)\s+to\s+(?:share|announce)\b/i, label: 'happy to share' },
  { re: /\bhad\s+(?:a|an)\s+(?:great|amazing|wonderful|fantastic|insightful)\b/i, label: 'had a great' },
];

const STOP = new Set(
  'and or the for with from into over near this that our your their in at on of to a an by is are be required needed looking'.split(' ')
);

/** The words of a search worth checking a post for. */
export function topicWords(text) {
  return [
    ...new Set(
      String(text || '')
        .toLowerCase()
        .replace(/site:\S+/g, ' ')
        .split(/[^a-z0-9+#]+/)
        .filter((w) => w.length >= 3 && !STOP.has(w))
    ),
  ];
}

/*
 * Whether a post is about the searched topic at all.
 *
 * On a stem, not a whole word: "trainer" has to find "training" and
 * "trainers", and a five-letter prefix is the cheapest stemmer that does.
 */
function onTopic(text, words) {
  if (!words.length) return true;
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.length > 5 ? w.slice(0, 5) : w));
}

/**
 * What a post is doing: asking (DEMAND), selling (SUPPLY), reporting a
 * finished session (RECAP), or none of those (OTHER).
 *
 * `signals` names every cue that fired, demand first, so a row carries its own
 * reason. `score` is 0–100 and only orders rows; `intent` is what filters.
 */
export function classifyPost(text, { topic = '' } = {}) {
  const flat = collapse(text);
  const fired = (list) => list.filter((cue) => cue.re.test(flat));

  const demand = fired(DEMAND);
  const supply = fired(SUPPLY);
  const recap = fired(RECAP);
  const ask = demand.reduce((n, cue) => n + cue.w, 0);
  // Selling and thanking are each counted once per cue, at full weight: one
  // "I am a trainer" outweighs one "looking for" in the same post, because a
  // trainer's post saying they are "looking for opportunities" is the classic
  // false positive.
  const against = (supply.length + recap.length) * 2;
  const relevant = onTopic(flat, topicWords(topic));

  let intent = 'OTHER';
  if (ask >= 2 && ask > against) intent = 'DEMAND';
  else if (supply.length && supply.length >= recap.length) intent = 'SUPPLY';
  else if (recap.length) intent = 'RECAP';

  const score = Math.max(0, Math.min(100, ask * 15 - against * 8 + (relevant ? 10 : -20)));
  const signals = [
    ...demand.map((cue) => cue.label),
    ...supply.map((cue) => `not: ${cue.label}`),
    ...recap.map((cue) => `not: ${cue.label}`),
    ...(relevant ? [] : ['off topic']),
  ];
  return { intent, score, signals, relevant };
}

/* ---------------------------------------------------------------- a row */

/** Days between two moments, to one decimal — "3.5", not "3.4999". */
const ageInDays = (from, now) => Math.round(((now - from) / DAY) * 10) / 10;

/**
 * Everything the Posts source knows about one post, derived once.
 *
 * Adapters collect what the page shows; this adds what can be computed from
 * it: the exact time from the id, the age, the intent and its reasons, and
 * the contacts written in the text. Idempotent, so a record merged from two
 * sightings can be annotated again with its longer text.
 */
export function annotatePost(record, { now = Date.now(), topic = '' } = {}) {
  const id = record.postId || postIdFrom(record.postUrl);
  const at = postedAtFromId(id, now);
  const text = collapse(record.text || record.summary || '');
  const { intent, score, signals } = classifyPost(`${record.headline || ''} ${text}`, { topic });
  const { emails, phones } = contactsIn(text);
  return {
    ...record,
    postId: id,
    postUrl: record.postUrl || postUrlFor(id),
    postedAt: at ? new Date(at).toISOString() : '',
    ageDays: at ? ageInDays(at, now) : '',
    intent,
    score,
    signals: signals.join(', '),
    emails: emails.join('; '),
    phones: phones.join('; '),
  };
}

/** Collapse text to what two copies of the same post share. */
const fingerprint = (record) =>
  `${String(record.author || '').toLowerCase().replace(/[^a-z0-9]+/g, '')}|` +
  collapse(record.text).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 120);

/**
 * Split annotated posts into the ones to keep and the ones set aside.
 *
 * Set aside, never deleted — the same rule the category filter follows: a row
 * that is one day too old or that the classifier misread is still there to be
 * shown. Each carries its reason, because "why is this not in my list?" is the
 * first question a thin result raises.
 *
 * Also folds reposts and cross-posted copies: LinkedIn gives a repost its own
 * id, so the same text by the same author can arrive twice under two ids. The
 * newer copy is the one kept — it is the one a reply will reach.
 */
export function narrowPosts(records, { days = 10, intentOnly = true, now = Date.now() } = {}) {
  const kept = [];
  const dropped = [];
  const cutoff = now - days * DAY;
  const byText = new Map();

  const sorted = [...(records || [])].sort((a, b) =>
    String(b.postedAt || '').localeCompare(String(a.postedAt || ''))
  );
  for (const record of sorted) {
    const at = Date.parse(record.postedAt || '');
    let reason = '';
    if (!Number.isFinite(at)) reason = 'no post date';
    else if (at < cutoff) reason = `older than ${days} days`;
    else if (intentOnly && record.intent !== 'DEMAND') {
      reason = `not a requirement post (${String(record.intent || 'OTHER').toLowerCase()})`;
    }

    const print = fingerprint(record);
    if (!reason && print.length > 20 && byText.has(print)) reason = 'a copy of a newer post';
    if (reason) {
      dropped.push({ ...record, setAside: reason });
      continue;
    }
    if (print.length > 20) byText.set(print, record);
    kept.push(record);
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------- searching */

/*
 * How a requirement is phrased, split into groups an engine can take.
 *
 * Google caps a query at 32 words, and one long OR-list also dilutes ranking,
 * so each search runs once per group. Quoted only where the phrase is common
 * enough to exist verbatim: an over-quoted query is answered "No results
 * found", then silently re-run without the quotes.
 */
export const INTENT_GROUPS = [
  '(required OR requirement OR urgent OR needed)',
  '("looking for" OR hiring OR seeking OR "share your profile")',
];

/** One engine query per intent group for a search. */
export function postQueries(category, city) {
  const topic = [category, city].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  return INTENT_GROUPS.map((group) => ['site:linkedin.com/posts', topic, group].filter(Boolean).join(' '));
}

/**
 * The engine's own date window, a little wider than the one asked for.
 *
 * The engine dates a page no earlier than the post, so its window never needs
 * to be wider than ours to catch a post — the margin only covers timezones
 * and a day of indexing slop. The exact cut is made from the id afterwards.
 */
export function engineWindowDays(days) {
  const n = Math.max(1, Math.round(Number(days) || 10));
  return n + 2;
}

/** A Google results URL for a query, limited to the recent window. */
export function postSearchUrl(query, days) {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('tbs', `qdr:d${engineWindowDays(days)}`);
  // Google folds "similar" results together, and posts by one author about
  // one requirement look similar to it. Those are exactly the rows wanted.
  url.searchParams.set('filter', '0');
  return url.href;
}
