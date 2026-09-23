/** Email verification, as far as a browser extension honestly can. */

/** DNS-over-HTTPS resolvers, tried in order. */
const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
];

/** Statuses, ordered worst to best for the caller's convenience. */
export const STATUS = {
  INVALID: 'invalid', // malformed — never send
  NO_MX: 'no-mx', // domain accepts no mail — never send
  DISPOSABLE: 'disposable', // throwaway inbox — pointless to send
  ROLE: 'role', // deliverable, but a shared desk address
  VALID: 'valid', // syntax fine, domain accepts mail
  UNKNOWN: 'unknown', // lookup failed — treat as unverified, not as bad
};

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  '10minutemail.com',
  'tempmail.com',
  'temp-mail.org',
  'throwawaymail.com',
  'yopmail.com',
  'trashmail.com',
  'sharklasers.com',
  'getnada.com',
  'dispostable.com',
  'maildrop.cc',
  'fakeinbox.com',
  'mailnesia.com',
]);

const ROLE_LOCALS = new Set([
  'info',
  'contact',
  'hello',
  'sales',
  'support',
  'admin',
  'office',
  'enquiry',
  'enquiries',
  'inquiry',
  'inquiries',
  'help',
  'team',
  'mail',
  'reception',
  'booking',
  'bookings',
  'appointments',
  'care',
  'service',
  'billing',
  'accounts',
]);

const SYNTAX = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function splitEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!SYNTAX.test(value) || value.length > 254) return null;
  const at = value.lastIndexOf('@');
  return { local: value.slice(0, at), domain: value.slice(at + 1), email: value };
}

export function isDisposable(domain) {
  const d = String(domain || '').toLowerCase();
  return DISPOSABLE_DOMAINS.has(d) || [...DISPOSABLE_DOMAINS].some((x) => d.endsWith(`.${x}`));
}

export function isRoleAccount(local) {
  return ROLE_LOCALS.has(String(local || '').toLowerCase());
}

/** Decide a status from the syntax, the domain lists and an MX answer. */
export function classify(email, mx) {
  const parts = splitEmail(email);
  if (!parts) return { status: STATUS.INVALID, reason: 'Malformed address' };
  if (isDisposable(parts.domain)) return { status: STATUS.DISPOSABLE, reason: 'Throwaway inbox provider' };

  if (mx === null || mx === undefined) {
    return { status: STATUS.UNKNOWN, reason: 'MX lookup did not complete' };
  }
  if (mx.length === 0) {
    return { status: STATUS.NO_MX, reason: 'Domain publishes no mail server' };
  }
  if (isRoleAccount(parts.local)) {
    return { status: STATUS.ROLE, reason: 'Shared desk address, not a person' };
  }
  return { status: STATUS.VALID, reason: 'Domain accepts mail' };
}

/** True when this address is worth putting in front of a human. */
export function isSendable(status) {
  return status === STATUS.VALID || status === STATUS.ROLE || status === STATUS.UNKNOWN;
}

/** Read the hostnames out of a DNS-over-HTTPS JSON response. */
export function parseDohAnswer(json) {
  if (!json || typeof json !== 'object') return null;
  // NXDOMAIN (3) is a definite "this domain does not exist".
  if (json.Status === 3) return [];
  if (json.Status !== 0) return null;

  const answers = Array.isArray(json.Answer) ? json.Answer : [];
  const mx = answers
    .filter((a) => a.type === 15 && a.data)
    // "10 mail.example.com." -> "mail.example.com"
    .map((a) => String(a.data).trim().split(/\s+/).pop().replace(/\.$/, ''))
    .filter((host) => host && host !== '.');

  return mx;
}

async function dohQuery(name, type, timeoutMs, fetchImpl) {
  for (const endpoint of DOH_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      const res = await fetchImpl(url, {
        signal: controller.signal,
        credentials: 'omit',
        headers: { Accept: 'application/dns-json' },
      });
      if (res && res.ok) return await res.json();
      // A non-OK response means this resolver is unusable, so try the next.
    } catch {
      /* blocked, offline or timed out — fall through to the next resolver */
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Look up whether a domain can receive mail. */
const mxCache = new Map();

export async function lookupMx(
  domain,
  { timeout = 8000, cache = mxCache, fetchImpl = globalThis.fetch } = {}
) {
  const name = String(domain || '').toLowerCase();
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  if (typeof fetchImpl !== 'function') return null;

  const mx = parseDohAnswer(await dohQuery(name, 'MX', timeout, fetchImpl));

  let result = mx;
  if (mx && mx.length === 0) {
    // No MX is not the end of the story: RFC 5321 falls back to the A record.
    const a = await dohQuery(name, 'A', timeout, fetchImpl);
    const hasA = a && a.Status === 0 && Array.isArray(a.Answer) && a.Answer.some((x) => x.type === 1);
    if (hasA) result = [name];
  }

  cache.set(name, result);
  return result;
}

/** Verify one address end to end. */
export async function verifyEmail(email, options = {}) {
  const parts = splitEmail(email);
  if (!parts) return { email: String(email || ''), ...classify(email, null) };

  if (isDisposable(parts.domain)) return { email: parts.email, ...classify(email, []) };

  const mx = await lookupMx(parts.domain, options);
  return { email: parts.email, ...classify(email, mx) };
}
