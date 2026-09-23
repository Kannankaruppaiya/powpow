/**
 * Email discovery.
 *
 * Google Maps never exposes an email address, so the only honest way to get
 * one is to visit the business's own website and read what it publishes.
 * The service worker holds <all_urls> host permissions, so these fetches are
 * not subject to CORS.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;

/** Domains that ship in third-party snippets, never the business's own inbox. */
const JUNK_DOMAINS = [
  'example.com',
  'example.org',
  'domain.com',
  'yourdomain.com',
  'email.com',
  'sentry.io',
  'sentry-cdn.com',
  'wixpress.com',
  'wix.com',
  'squarespace.com',
  'godaddy.com',
  'shopify.com',
  'cloudflare.com',
  'w3.org',
  'schema.org',
  'googleapis.com',
  'gstatic.com',
  'jquery.com',
  'bootstrapcdn.com',
  'fontawesome.com',
  'adobe.com',
  'wordpress.org',
  'wordpress.com',
  'automattic.com',
  'gravatar.com',
];

/** File extensions that a greedy regex mistakes for a TLD (e.g. logo@2x.png). */
const ASSET_TAIL = /\.(png|jpe?g|gif|svg|webp|css|js|json|xml|woff2?|ttf|eot|ico|mp4|pdf)$/i;

/** Pages worth a second look when the homepage yields nothing. */
const FALLBACK_PATHS = ['/contact', '/contact-us', '/contactus', '/about', '/about-us'];

export function normaliseUrl(raw) {
  if (!raw) return '';
  let url = String(raw).trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.toString();
  } catch {
    return '';
  }
}

export function extractEmails(html, siteHost = '') {
  if (!html) return [];

  const found = new Set();

  // mailto: links are unambiguous, so trust them first.
  for (const m of html.matchAll(/mailto:([^"'>?\s]+)/gi)) {
    const value = decodeURIComponent(m[1]).split('?')[0].trim();
    if (value) found.add(value);
  }

  // Then the raw text, which catches addresses printed as plain copy.
  for (const m of html.matchAll(EMAIL_RE)) found.add(m[0]);

  const cleaned = [];
  for (const raw of found) {
    const email = raw.toLowerCase().replace(/^[.\-_]+|[.\-_]+$/g, '');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) continue;
    if (ASSET_TAIL.test(email)) continue;

    const host = email.split('@')[1];
    if (JUNK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    // Hashed filenames and tracking ids that happen to contain an @.
    if (/^[0-9a-f]{16,}@/.test(email)) continue;
    if (email.length > 100) continue;

    if (!cleaned.includes(email)) cleaned.push(email);
  }

  // Rank: same domain as the website beats a free mailbox beats everything
  // else; role addresses (info@, contact@) beat personal ones.
  const bareHost = String(siteHost || '').replace(/^www\./, '');
  const score = (email) => {
    const [local, host] = email.split('@');
    let s = 0;
    if (bareHost && (host === bareHost || host.endsWith(`.${bareHost}`))) s += 100;
    if (/^(info|contact|hello|enquiry|enquiries|inquiry|sales|admin|office|support|mail|reception|booking)$/.test(local))
      s += 20;
    if (/^(no-?reply|donot-?reply|postmaster|abuse|webmaster|privacy|dpo)$/.test(local)) s -= 50;
    return s;
  };

  return cleaned.sort((a, b) => score(b) - score(a));
}

/**
 * Social profiles a business links from its own site.
 *
 * These come out of the same HTML already fetched for the email, so they cost
 * nothing extra. Share widgets and intent links point at the visitor's own
 * account rather than the business, so they are filtered out.
 */
const SOCIAL_PATTERNS = [
  { key: 'facebook', re: /https?:\/\/(?:[\w-]+\.)?facebook\.com\/[^\s"'<>]+/gi },
  { key: 'instagram', re: /https?:\/\/(?:www\.)?instagram\.com\/[^\s"'<>]+/gi },
  { key: 'linkedin', re: /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/(?:company|in|school)\/[^\s"'<>]+/gi },
  { key: 'twitter', re: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[^\s"'<>]+/gi },
  { key: 'youtube', re: /https?:\/\/(?:www\.)?youtube\.com\/(?:c|channel|user|@)[^\s"'<>]*/gi },
];

/** Paths that are a share button or a platform's own plumbing, not a profile. */
const SOCIAL_NOISE =
  /\/(sharer|share|intent|dialog|plugins|tr\?|login|signup|home|privacy|policies|about\/?$)/i;

export function extractSocialLinks(html) {
  const out = {};
  const text = String(html || '');

  for (const { key, re } of SOCIAL_PATTERNS) {
    for (const match of text.matchAll(re)) {
      let url = match[0].replace(/[)\]},.;'"]+$/, '');
      if (SOCIAL_NOISE.test(url)) continue;

      try {
        const parsed = new URL(url);
        // A bare domain is a link to the platform, not to a profile.
        if (parsed.pathname.replace(/\/+$/, '').length <= 1) continue;
        parsed.search = '';
        parsed.hash = '';
        url = parsed.toString().replace(/\/$/, '');
      } catch {
        continue;
      }

      if (!out[key]) out[key] = url;
    }
  }
  return out;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      credentials: 'omit',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return '';
    const type = res.headers.get('content-type') || '';
    if (type && !/html|text|xml/i.test(type)) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look for an email on a single business website.
 * Returns { email, allEmails, source } — empty strings when nothing is found.
 */
export async function findEmailForSite(website, { timeout = 12000, followContactPage = true } = {}) {
  const empty = { email: '', allEmails: [], source: '', social: {} };
  const url = normaliseUrl(website);
  if (!url) return empty;

  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return empty;
  }

  const home = await fetchText(url, timeout);
  const social = extractSocialLinks(home);

  let emails = extractEmails(home, host);
  if (emails.length) return { email: emails[0], allEmails: emails, source: url, social };

  if (!followContactPage) return { ...empty, social };

  // Prefer a contact link the homepage actually advertises over guessed paths.
  const linked = [];
  for (const m of home.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    if (!/contact|reach-us|get-in-touch/i.test(m[1])) continue;
    try {
      linked.push(new URL(m[1], url).toString());
    } catch {
      /* skip malformed href */
    }
  }

  const candidates = [...new Set([...linked, ...FALLBACK_PATHS.map((p) => new URL(p, url).toString())])].slice(0, 3);

  for (const candidate of candidates) {
    const html = await fetchText(candidate, timeout);
    // Contact pages often carry the social links the homepage omits.
    Object.assign(social, { ...extractSocialLinks(html), ...social });
    emails = extractEmails(html, host);
    if (emails.length) return { email: emails[0], allEmails: emails, source: candidate, social };
  }

  return { ...empty, social };
}

/** Run `worker` over `items` with a fixed concurrency ceiling. */
export async function mapWithConcurrency(items, limit, worker) {
  const size = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}
