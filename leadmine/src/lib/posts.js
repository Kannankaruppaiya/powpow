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
 * How the classifier reads a post, in three passes.
 *
 * 1. **Blank out the clauses that borrow a buyer's words.** "If you require
 *    corporate training, DM me" is an advert; "looking for new
 *    opportunities" is a job seeker. Both contain exactly the words a
 *    requirement is written in, so they are removed before anything asks
 *    whether the post is asking.
 *
 * 2. **Find the requirement itself: a role next to a need.** The two posts
 *    this was tuned on say it the way almost every requirement does —
 *    "A QA Automation corporate trainer is required", "Technical Training
 *    Specialist (AI, Machine Learning, & Business Intelligence) is required",
 *    "We are seeking an experienced … Technical Training Specialist". A role
 *    word (trainer, training, specialist, facilitator…) within a sentence of a
 *    need word (required, needed, seeking, looking for, hiring…) is the
 *    strongest single signal there is, and it outweighs any one stray word.
 *
 * 3. **Weigh what is left.** Selling cues only count in the first person or
 *    when they sell something ("I am a certified trainer", "enrol now"), and
 *    thank-you cues only when someone says *they* ran the session. A
 *    requirement routinely says "should have delivered corporate training",
 *    "we offer flexible hours" or "our training programs", and an earlier
 *    version read those as the trainer's own post — a real requirement,
 *    "Technical Training Specialist is required", came back as SUPPLY.
 */

/* Pass 1: clauses that are not asking, however they are worded. */
const PITCH = [
  // "If you / your team require(s) / need(s) / are looking for …" up to the end of the sentence.
  /\bif\s+(?:you|your\s+(?:team|company|organi[sz]ation|employees))\s+(?:require|requires|need|needs|are\s+looking\s+for|is\s+looking\s+for|want)\b[^.!?\n]*/gi,
  // "Looking for new opportunities / a job / my next role".
  /\b(?:I\s+am|I'm|am)?\s*(?:actively\s+)?(?:looking|searching)\s+for\s+(?:a\s+|my\s+)?(?:new\s+|next\s+)?(?:opportunit(?:y|ies)|jobs?|roles?|positions?|openings|assignments|freelance\s+(?:work|projects?))\b[^.!?\n]*/gi,
  // "I am actively looking for the same role" — a commenter wanting the job.
  /\bI(?:'m|\s+am)\s+(?:\w+\s+){0,2}looking\s+for\s+(?:the\s+same\s+|a\s+|an\s+)?(?:\w+\s+){0,3}(?:roles?|jobs?|positions?|opportunit(?:y|ies)|openings?)\b[^.!?\n]*/gi,
  // "looking for Training Referrals — attractive commission": selling training.
  /\b(?:looking\s+for|seeking)\s+(?:training\s+|client\s+|business\s+)?(?:referrals?|leads)\b[^.!?\n]*/gi,
  // A question put to the reader — "Looking for corporate trainers? We have a
  // pool of 500." — is an advert opening. A buyer states the need; a seller
  // asks whether you have it.
  /(?:^|[.!?]\s+|\n)\s*(?:are\s+you\s+)?(?:looking|searching)\s+for\b[^.!?\n]*\?/gi,
  /(?:^|[.!?]\s+|\n)\s*(?:do\s+you\s+)?need\s+(?:an?\s+)?[^.!?\n]*\?/gi,
];

function withoutPitches(text) {
  let out = text;
  for (const re of PITCH) out = out.replace(re, ' ');
  return out;
}

/*
 * Pass 2: someone asking for a trainer.
 *
 * Tightened on a real run of 140 posts, where a loose "a role word anywhere
 * near a need word" read "The best trainers don't walk in looking for someone
 * to blame" and "Diversity Hiring, Executive Search, Corporate Training" as
 * requirements. What a requirement actually looks like is narrower:
 *
 *   - the ask, then the role: "looking for an experienced Corporate Trainer",
 *     "seeking … Technical Training Specialist", "Hiring: Corporate AI Trainer"
 *   - or the role, then a passive need: "trainer is required", "Trainer
 *     Requirement", "Trainers Wanted", "Trainer Opportunity"
 *
 * "looking for" after the role is how a sentence *about* trainers reads, not
 * how a requirement for one does.
 */
const ROLE_CORE =
  '(?:trainers?|facilitators?|instructors?|faculty|train-the-trainer|training\\s+(?:partners?|providers?|vendors?|specialists?|consultants?|experts?|firms?|compan(?:y|ies)|organi[sz]ations?))';
// People whose title does not say "trainer" — only when the post is about
// training at all, or "looking for a Salesforce consultant" becomes a lead.
const ROLE_SOFT = '(?:coach(?:es)?|mentors?|speakers?|consultants?|specialists?|experts?|smes?|subject\\s+matter\\s+experts?|resource\\s+persons?|educators?)';
// Training delivered, not a trainer: "corporate training required",
// "need a 2-day workshop". Not after "hiring" — "We're Hiring – CA
// Industrial Training" is an articleship.
const ROLE_THING = '(?:training|trainings|workshops?|sessions?|masterclass(?:es)?|bootcamps?)';
// Words that turn a role into a different job: a Training Manager is an HR
// hire, a training institute is a place, training referrals are a sale.
const NOT_A_ROLE =
  '(?!\\s*(?:managers?|head|heads|leads?|leaders?|directors?|coordinators?|executives?|officers?|interns?|institutes?|academy|academies|cent(?:re|er)s?|referrals?|content|needs|calendar|budget|&\\s*quality|and\\s+placement|&\\s*placement)\\b)';

const ASK =
  '(?:looking\\s+(?:for|to\\s+(?:connect\\s+with|bring\\s+in|hire|onboard|engage|collaborate\\s+with|partner\\s+with|empanel))|' +
  'searching\\s+for|seeking|seeks|in\\s+search\\s+of|on\\s+the\\s+lookout\\s+for|need(?:s|ed)?\\s+(?:an?|some|experienced|good|certified|freelance)|' +
  'require(?:s)?\\s+(?:an?|some|experienced)|inviting|exploring|want\\s+(?:an?|to\\s+hire)|' +
  '(?:can|could)\\s+(?:anyone|someone|you)\\s+(?:please\\s+)?(?:recommend|suggest|refer))';
const HIRING = '(?:we(?:\\x27re|\\s+are)?\\s+hiring|hiring|urgent(?:ly)?\\s+hiring)';
const PASSIVE = '(?:required|requirement|requirements|needed|wanted|opportunit(?:y|ies))';

/*
 * Between the ask and the role, no other job: "looking for a remote L&D
 * Manager to join the Pocket Trainer team" asks for a manager, and the
 * trainer in it is a company's name.
 */
const GAP =
  '(?:(?!\\b(?:managers?|executives?|developers?|officers?|associates?|analysts?|interns?|engineers?|directors?|heads?|recruiters?|designers?|writers?|creators?|professionals?)\\b)[^.!?\\n]){0,80}?';

const ASK_THEN_ROLE = new RegExp(
  `\\b${ASK}\\b${GAP}\\b(?:${ROLE_CORE}|${ROLE_THING}|${ROLE_SOFT})\\b${NOT_A_ROLE}`,
  'gi'
);
// After "hiring", a trainer only. "Hiring … Valentra Consultants" names the
// firm, and a consultant hired is a job, not a training requirement.
const HIRING_THEN_ROLE = new RegExp(`\\b${HIRING}\\b${GAP.replace('{0,80}', '{0,60}')}\\b${ROLE_CORE}\\b${NOT_A_ROLE}`, 'gi');
const ROLE_THEN_NEED = new RegExp(
  `\\b(?:${ROLE_CORE}|${ROLE_THING}|${ROLE_SOFT})\\b${NOT_A_ROLE}[^.!?\\n]{0,40}?\\b(?:(?:is|are)\\s+)?${PASSIVE}\\b`,
  'gi'
);
const TRAINING_WORLD = /\btrain(?:er|ers|ing|ings)?\b|\bfacilitat|\bworkshops?\b|\bteach|\binstruct|\bL&D\b|\blearning\s+(?:and|&)\s+development\b/i;
const SOFT_ONLY = new RegExp(`^[^]*?\\b${ROLE_SOFT}\\b`, 'i');

/** The phrase that asks for a trainer, or ''. */
function roleAsk(text) {
  for (const re of [ASK_THEN_ROLE, HIRING_THEN_ROLE, ROLE_THEN_NEED]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const phrase = m[0];
      const core = new RegExp(`\\b(?:${ROLE_CORE}|${ROLE_THING})\\b`, 'i').test(phrase);
      // A coach, consultant or expert counts only in a post about training.
      if (!core && !(SOFT_ONLY.test(phrase) && TRAINING_WORLD.test(text))) continue;
      return phrase;
    }
  }
  return '';
}

/*
 * Cues, each with the label a row shows when it fires, and a weight: 3 says
 * "this is the point of the post", 2 is a strong sign, 1 only suggests.
 */
const DEMAND = [
  { re: /\b(?:looking|searching)\s+for\b/i, label: 'looking for', w: 2 },
  { re: /\brequire(?:d|ment|ments)?\b/i, label: 'requirement', w: 2 },
  // "Trainer needed" and "need a trainer" — not "need to thank", which is
  // how half of all thank-you posts open.
  { re: /\bneeded\b|\bneed\s+(?:an?|some|experienced|freelance|certified|good)\b/i, label: 'need', w: 2 },
  { re: /\bseeking\b|\bwanted\b/i, label: 'seeking', w: 2 },
  { re: /\burgent(?:ly)?\b|\bimmediate(?:ly)?\b|\basap\b/i, label: 'urgent', w: 1 },
  { re: /\bwe(?:'re| are)? hiring\b|\bhiring\b/i, label: 'hiring', w: 1 },
  { re: /\b(?:share|send|drop|mail|dm)\s+(?:your|their|me your|us your)?\s*(?:updated\s+)?(?:profiles?|cvs?|resumes?|details)\b/i, label: 'share your profile', w: 2 },
  { re: /\binterested\s+(?:trainers?|candidates?|consultants?|freelancers?|vendors?|professionals?|experts?|people|folks)\b/i, label: 'interested trainers', w: 2 },
  { re: /\bcommercials?\b|\bper\s+(?:day|hour|session)\b|\bbudget\b|\bpay\s*out\b/i, label: 'commercials', w: 1 },
  { re: /\b(?:rfp|rfq|empanel(?:ment|led)?|vendor(?:s)?\s+(?:required|needed|wanted))\b/i, label: 'vendor ask', w: 2 },
  { re: /\b(?:can|could)\s+anyone\s+(?:recommend|suggest|refer)\b|\b(?:any|please)\s+(?:recommendations?|referrals?|leads?)\b/i, label: 'asking for referrals', w: 2 },
  { re: /\b(?:dm|inbox|ping|whatsapp)\s+(?:me|us)\b|\bconnect with me\b|\breach out\b/i, label: 'contact me', w: 1 },
  // A requirement is usually laid out like a job description.
  { re: /\b(?:position\s+overview|job\s+description|\bjd\b|key\s+responsibilities|required\s+skill(?:s|set|sets)?|skill\s*sets?\s+required|skills?\s+required|start\s+date|duration\s*:|mode\s*:|location\s*:|no\.?\s+of\s+(?:days|sessions|batches))\b/i, label: 'requirement details', w: 1 },
  { re: /\bfreelanc(?:e|er|ers|ing)\b|\bpart[\s-]time\b|\bcontract(?:ual)?\s+(?:basis|role|trainer)\b/i, label: 'freelance / part-time', w: 1 },
];

/*
 * Selling. First person, or selling something — never a bare "we offer",
 * which a requirement uses for its own perks ("we offer flexible hours").
 */
const NOT_ASKING = '(?!\\s*(?:looking|searching|seeking|hiring|in\\s+need|in\\s+search))';
const SUPPLY = [
  { re: /#opentowork|\bopen\s+to\s+(?:work|opportunities|new\s+opportunities|freelance)\b/i, label: 'open to work', w: 3 },
  {
    re: new RegExp(
      `\\bI(?:'m|\\s+am)${NOT_ASKING}\\s+(?:an?\\s+|the\\s+)?(?:[\\w-]+\\s+){0,4}(?:trainer|consultant|coach|facilitator|freelancer|speaker|mentor|instructor)\\b`,
      'i'
    ),
    label: 'introduces self',
    w: 2,
  },
  { re: /\bI(?:'m|\s+am)\s+(?:currently\s+|now\s+)?available\b|\bmy\s+availability\b/i, label: 'available', w: 2 },
  { re: /\benrol+(?:ment)?\s+(?:now|today|open)\b|\bregister\s+(?:now|here|today)\b|\blimited\s+seats\b/i, label: 'enrol now', w: 2 },
  { re: /\bnew\s+batch\b|\bbatch\s+(?:starts?|starting)\b|\bdemo\s+(?:class|session)\b|\bcourse\s+fees?\b|\bfree\s+(?:webinar|masterclass|demo)\b/i, label: 'course advert', w: 2 },
  { re: /\bjoin\s+(?:our|us|the|this)\s+(?:\w+\s+)?(?:course|batch|program(?:me)?|workshop|masterclass|webinar|bootcamp)\b/i, label: 'join our course', w: 2 },
  { re: /\bbook\s+(?:a|your)\s+(?:free\s+)?(?:slot|seat|call|demo|session)\b/i, label: 'book a slot', w: 2 },
  { re: /\b(?:my|our)\s+(?:training\s+)?(?:services|offerings)\b|\bI\s+(?:offer|provide|deliver)\b/i, label: 'own services', w: 1 },
  { re: /\bcommission\b|\bintroduce\s+(?:us\s+|me\s+)?(?:to\s+)?(?:organi[sz]ations|companies|clients|corporates)\b/i, label: 'selling training', w: 5 },
  { re: /\b(?:their|your)\s+own\s+(?:offline\s+|online\s+)?(?:batches|classes|sessions|workshops|programs?|courses?)\b|\bspace\s+to\s+(?:launch|conduct|run)\b/i, label: 'renting a space', w: 5 },
  { re: /\bwe\s+have\s+(?:a\s+)?(?:large\s+|strong\s+)?(?:pool|network|panel|bench|team)\s+of\b[^.!?\n]{0,40}\b(?:trainers|consultants|experts|facilitators)\b/i, label: 'trainer pool', w: 2 },
];

/* Pass 1 found these; they count against the post. */
const PITCH_CUES = [
  { re: PITCH[0], label: 'if you need', w: 3 },
  { re: PITCH[1], label: 'job seeker', w: 3 },
  { re: PITCH[2], label: 'job seeker', w: 3 },
  { re: PITCH[3], label: 'selling training', w: 3 },
  { re: PITCH[4], label: 'asks the reader', w: 2 },
  { re: PITCH[5], label: 'asks the reader', w: 2 },
];

/*
 * Thanking. Only someone saying *they* ran it — "should have delivered
 * corporate training" is a requirement, "I delivered a corporate training" is
 * a recap.
 */
const RECAP = [
  {
    re: /\b(?:I|we)\s+(?:have\s+|just\s+|recently\s+|had\s+)?(?:successfully\s+)?(?:conducted|delivered|completed|concluded|wrapped\s+up|facilitated|organi[sz]ed)\b[^.!?\n]{0,60}\b(?:sessions?|training|trainings|workshops?|program(?:me)?s?|bootcamps?)\b/i,
    label: 'session done',
    w: 2,
  },
  { re: /(?:^|[.!?]\s*|\n)\s*(?:successfully\s+)(?:conducted|delivered|completed|concluded)\b/i, label: 'session done', w: 2 },
  { re: /\bthank(?:s| you)\b[^.!?\n]{0,80}\bopportunit(?:y|ies)\b/i, label: 'thanks for the opportunity', w: 2 },
  { re: /\b(?:grateful|honou?red|privileged|humbled)\b/i, label: 'grateful', w: 1 },
  { re: /\b(?:happy|excited|thrilled|glad|delighted)\s+to\s+(?:share|announce)\b/i, label: 'happy to share', w: 1 },
  { re: /\bhad\s+(?:a|an)\s+(?:great|amazing|wonderful|fantastic|insightful)\b/i, label: 'had a great', w: 1 },
];

/*
 * A requirement its author has closed: "Closed - Thank you SO much for the
 * overwhelming response!", "Position filled", "no longer accepting".
 */
const CLOSED =
  /(?:^|[\s(\[])closed\b\s*[-–—:!)\]]|\b(?:position|role|requirement|opening|vacancy)\s+(?:has\s+been\s+|is\s+(?:now\s+)?)?(?:closed|filled)\b|\bno\s+longer\s+(?:accepting|looking|required)\b|\bthanks?\s+(?:you\s+)?(?:\w+\s+){0,3}for\s+the\s+(?:overwhelming\s+)?response\b/i;

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
 * The kind of engagement a requirement is for, when it says.
 *
 * Freelance and part-time requirements and full-time jobs are different
 * leads for a training company, and both are written with "trainer
 * required", so the post has to be read for which one it is.
 */
export function engagementOf(text) {
  const flat = String(text || '');
  const kinds = [];
  if (/\bfreelanc(?:e|er|ers|ing)\b/i.test(flat)) kinds.push('freelance');
  if (/\bpart[\s-]time\b/i.test(flat)) kinds.push('part-time');
  if (/\bcontract(?:ual)?\b/i.test(flat)) kinds.push('contract');
  if (/\bfull[\s-]time\b|\bpermanent\b/i.test(flat)) kinds.push('full-time');
  return kinds.join(', ');
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
  const asking = withoutPitches(flat);
  const fired = (list, on) => list.filter((cue) => {
    cue.re.lastIndex = 0;
    return cue.re.test(on);
  });

  const asked = roleAsk(asking);
  const roleNeed = Boolean(asked);
  const demand = fired(DEMAND, asking);
  const supply = [...fired(PITCH_CUES, flat), ...fired(SUPPLY, asking)];
  const recap = fired(RECAP, asking);
  const sum = (cues) => cues.reduce((n, cue) => n + cue.w, 0);

  const ask = sum(demand) + (roleNeed ? 3 : 0);
  const sells = sum(supply);
  const thanks = sum(recap);
  const against = sells + thanks;
  const words = topicWords(topic);
  const relevant = onTopic(flat, words);

  /*
   * A requirement has to ask for a trainer — a phrase, not a pile of cues:
   * "hiring" plus "looking for" plus "seeking" in a post about a mission-driven
   * team is not one. It has to outweigh any selling or thanking in the same
   * post, and it has to be about what was searched for.
   */
  let intent = 'OTHER';
  // A requirement already filled is not a lead, however well it asks.
  if (roleNeed && CLOSED.test(flat)) intent = 'CLOSED';
  else if (roleNeed && ask > against && relevant) intent = 'DEMAND';
  else if (sells && sells >= thanks) intent = 'SUPPLY';
  else if (thanks) intent = 'RECAP';

  const score = Math.max(0, Math.min(100, ask * 10 - against * 8 + (relevant ? 10 : -20)));
  const signals = [
    ...(roleNeed ? [`asks: "${collapse(asked).slice(0, 60)}"`] : []),
    ...demand.map((cue) => cue.label),
    ...supply.map((cue) => `not: ${cue.label}`),
    ...[...new Set(recap.map((cue) => cue.label))].map((label) => `not: ${label}`),
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
    engagement: engagementOf(text),
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
/**
 * Why one post is set aside, or '' when it is kept — the date and intent
 * half of narrowPosts, for a row on its own as it arrives.
 */
export function postVerdict(record, { days = 10, intentOnly = true, now = Date.now() } = {}) {
  const at = Date.parse((record && record.postedAt) || '');
  if (!Number.isFinite(at)) return 'no post date';
  if (at < now - days * DAY) return `older than ${days} days`;
  if (intentOnly && record.intent !== 'DEMAND') {
    return `not a requirement post (${String(record.intent || 'OTHER').toLowerCase()})`;
  }
  return '';
}

export function narrowPosts(records, { days = 10, intentOnly = true, now = Date.now() } = {}) {
  const kept = [];
  const dropped = [];
  const byText = new Map();

  // A verdict from an earlier pass is recomputed, never inherited.
  const sorted = [...(records || [])]
    .map((record) => {
      const copy = { ...record };
      delete copy.setAside;
      return copy;
    })
    .sort((a, b) => String(b.postedAt || '').localeCompare(String(a.postedAt || '')));
  for (const record of sorted) {
    let reason = postVerdict(record, { days, intentOnly, now });

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
