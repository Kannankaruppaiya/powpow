/**
 * A work email for a person — the one paid step.
 *
 * A LinkedIn or public-web row names a person and a profile and nothing you
 * can write to. Email finders resolve a profile URL to a verified work
 * address; this talks to two of them, with the request and response shapes
 * taken from OpenOutFind's clients (github.com/eracle/OpenOutFind,
 * `openoutfind/enrichment/`), which were built against the providers' docs:
 *
 *   - Apollo: POST /api/v1/people/match — synchronous, one call, and a miss
 *     costs nothing. Only an address Apollo marks "verified" counts.
 *   - BetterContact: POST /api/v2/async → request_id, then poll GET
 *     /api/v2/async/{id} until "terminated". A credit goes when the job is
 *     accepted, hit or miss.
 *
 * Three rules, all about money:
 *
 *   1. **Nothing is looked up that the user did not pick.** The caller passes
 *      the leads — by default only the ones judged a fit — and a ceiling.
 *   2. **Only the profile URL leaves the browser.** Both providers resolve
 *      better with a name and a company, and both work with the URL alone;
 *      the less of someone's record goes to a third party, the better.
 *   3. **A "guessed" address is a miss.** A pattern-matched first.last@domain
 *      with no delivery evidence would sit in the Email column looking exactly
 *      like a real one, and bounce.
 *
 * Runs in the side panel, where its key lives — never in the worker, never in
 * a saved job, never in an export.
 */

export const FINDERS = {
  apollo: {
    id: 'apollo',
    label: 'Apollo',
    keyUrl: 'https://app.apollo.io/#/settings/integrations/api',
    costNote: '1 credit per address found; a miss is free',
  },
  bettercontact: {
    id: 'bettercontact',
    label: 'BetterContact',
    keyUrl: 'https://bettercontact.rocks',
    costNote: '1 credit per lookup, found or not',
  },
};

export const DEFAULT_FINDER = 'apollo';

const APOLLO_MATCH = 'https://api.apollo.io/api/v1/people/match';
const BC_ASYNC = 'https://app.bettercontact.rocks/api/v2/async';

/** Apollo's stand-in for an address the account cannot see. Not an address. */
const APOLLO_LOCKED = 'email_not_unlocked@domain.com';
const APOLLO_USABLE = new Set(['verified']);
const BC_USABLE = new Set(['valid', 'deliverable', 'catch_all_safe']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The profile URL a lead can be looked up by, or ''. */
export function profileUrlOf(record) {
  const url = String((record && (record.profileUrl || record.authorUrl)) || '');
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `https://www.linkedin.com/in/${m[1]}` : '';
}

/** A refusal, in words that say what to do. */
function finderError(label, status) {
  if (status === 401 || status === 403) {
    return new Error(`${label} rejected the API key, or your plan does not include this lookup.`);
  }
  if (status === 402) return new Error(`${label} says the account has no credits left.`);
  if (status === 429) return new Error(`${label} is rate-limiting this key. Wait a minute and try again.`);
  if (status >= 500) return new Error(`${label} is having trouble. Try again later.`);
  return new Error(`${label} refused the lookup (HTTP ${status}).`);
}

/** Split a finder's name fields, or ''. */
const name = (v) => String(v || '').trim();

export function readApollo(json) {
  const person = (json && json.person) || {};
  const email = name(person.email).toLowerCase();
  const status = name(person.email_status).toLowerCase();
  if (!email || email === APOLLO_LOCKED || !APOLLO_USABLE.has(status)) {
    return { found: false, status: status || 'not found' };
  }
  return {
    found: true, email, status,
    firstName: name(person.first_name), lastName: name(person.last_name),
    title: name(person.title),
  };
}

export function readBetterContact(json) {
  const row = ((json && json.data) || [])[0] || {};
  const email = name(row.contact_email_address).toLowerCase();
  const status = name(row.contact_email_address_status).toLowerCase();
  if (!email || !BC_USABLE.has(status)) return { found: false, status: status || 'not found' };
  return {
    found: true, email, status,
    firstName: name(row.contact_first_name), lastName: name(row.contact_last_name),
  };
}

async function call(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new Error(`Could not reach ${label}. Check your connection.`);
  }
  if (!response.ok) throw finderError(label, response.status);
  return response.json().catch(() => ({}));
}

/**
 * Look one person up. Returns { found, email, status, firstName, lastName }.
 *
 * Throws only for what stops every later lookup too — a bad key, no credits,
 * a rate limit — so the caller can stop spending rather than fail forty times.
 */
export async function findPersonEmail({
  finder = DEFAULT_FINDER,
  apiKey = '',
  profileUrl,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  sleepImpl = sleep,
  pollEvery = 5000,
  pollTimeout = 180000,
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Add the email finder API key first.');
  if (!profileUrl) return { found: false, status: 'no profile link' };
  if (!fetchImpl) throw new Error('This browser cannot reach the email finder.');

  if (finder === 'apollo') {
    const json = await call(fetchImpl, APOLLO_MATCH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': key },
      // Work email only: the personal-email and phone reveals cost more and
      // switch the endpoint to webhook delivery.
      body: JSON.stringify({ linkedin_url: profileUrl }),
    }, 'Apollo');
    return readApollo(json);
  }

  if (finder === 'bettercontact') {
    const headers = { 'content-type': 'application/json', 'x-api-key': key };
    const submitted = await call(fetchImpl, BC_ASYNC, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        data: [{ linkedin_url: profileUrl }],
        enrich_email_address: true,
        enrich_phone_number: false,
      }),
    }, 'BetterContact');
    const id = submitted.request_id || submitted.id;
    if (!id) throw new Error('BetterContact accepted the lookup but returned no job id.');

    const deadline = Date.now() + pollTimeout;
    for (;;) {
      await sleepImpl(pollEvery);
      const json = await call(fetchImpl, `${BC_ASYNC}/${encodeURIComponent(id)}`, { method: 'GET', headers }, 'BetterContact');
      if (json.status === 'terminated') return readBetterContact(json);
      if (Date.now() > deadline) return { found: false, status: 'still running — try again later', pending: id };
    }
  }

  throw new Error(`Unknown email finder "${finder}".`);
}

/**
 * Which leads a lookup would spend on, and how many.
 *
 * The rule is the spend gate: a person, with a profile link, without an
 * address already, not on the do-not-contact list, and — unless the user
 * widened it — judged a fit. Capped at the number the user typed.
 */
export function lookupTargets(records, notes, { include = ['fit'], limit = 10, isSuppressed = () => false } = {}) {
  const out = [];
  for (const record of records || []) {
    if (out.length >= limit) break;
    const note = (notes && notes.get(record.key)) || {};
    if (!profileUrlOf(record)) continue;
    if (note.personEmail || record.email) continue;
    if (note.personEmailTried) continue;
    const verdict = note.feedback === 'good' ? 'fit' : note.feedback === 'bad' ? 'no_fit' : note.verdict || '';
    if (!include.includes(verdict || 'unjudged')) continue;
    if (isSuppressed(record, note)) continue;
    out.push(record);
  }
  return out;
}

/**
 * Look up a list, one at a time, stopping on the first refusal that would
 * repeat for every later one. Returns note patches.
 */
export async function findEmails({
  records,
  finder,
  apiKey,
  onEach = () => {},
  shouldStop = () => false,
  ...rest
} = {}) {
  const patches = [];
  for (const record of records || []) {
    if (shouldStop()) break;
    const result = await findPersonEmail({ finder, apiKey, profileUrl: profileUrlOf(record), ...rest });
    const patch = {
      key: record.key,
      personEmailTried: Date.now(),
      personEmailFinder: finder,
      personEmailStatus: result.status || '',
      ...(result.found
        ? {
            personEmail: result.email,
            firstName: result.firstName || undefined,
            lastName: result.lastName || undefined,
          }
        : {}),
    };
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    patches.push(patch);
    await onEach(patch, { done: patches.length, total: records.length, found: Boolean(result.found) });
  }
  return patches;
}
