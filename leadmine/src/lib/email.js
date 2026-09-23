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

/* ------------------------------------------------------ hidden addresses */

/**
 * Cloudflare's "email address obfuscation".
 *
 * A site behind Cloudflare has every address on it rewritten on the way out:
 * the visible text becomes "[email protected]" and the address itself moves
 * into a hex string — `data-cfemail="…"` or `/cdn-cgi/l/email-protection#…`.
 * The first byte is a key and every byte after it is XORed with it. A plain
 * fetch sees only the hex, which is why a large share of small-business sites
 * came back with no email even though a visitor sees one.
 */
export function decodeCfEmail(hex) {
  const clean = String(hex || '').trim();
  if (!/^[0-9a-f]{4,}$/i.test(clean) || clean.length % 2) return '';
  const key = parseInt(clean.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16) ^ key);
  }
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/i.test(out) ? out : '';
}

function cloudflareEmails(html) {
  const out = [];
  const text = String(html || '');
  for (const m of text.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) out.push(decodeCfEmail(m[1]));
  for (const m of text.matchAll(/email-protection#([0-9a-f]+)/gi)) out.push(decodeCfEmail(m[1]));
  return out.filter(Boolean);
}

/** The handful of entities a page uses to hide an @ or a dot from scrapers. */
export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&commat;|&#64;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&amp;/gi, '&');
}

/**
 * Addresses spelt out so a regex will not see them: `info [at] acme [dot] com`,
 * `sales(at)acme(dot)in`, `hello at acme dot co dot uk`.
 *
 * The bracketed forms are unambiguous. The bare "at … dot" form is only read
 * when the whole thing is one address-shaped run of words, because "meet us
 * at the office" must not become an email.
 */
export function deobfuscate(text) {
  const t = String(text || '');
  const AT = '\\s*(?:\\[\\s*at\\s*\\]|\\(\\s*at\\s*\\)|\\{\\s*at\\s*\\})\\s*';
  // A spelt-out dot may have spaces around it; a real "." may not, or the
  // full stop ending a sentence becomes part of the domain ("acme.com. We").
  const DOT = '(?:\\s*(?:\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\)|\\{\\s*dot\\s*\\})\\s*|\\.)';
  const out = [];
  const bracketed = new RegExp(`([a-z0-9._%+-]+)${AT}([a-z0-9-]+(?:${DOT}[a-z0-9-]+)+)`, 'gi');
  for (const m of t.matchAll(bracketed)) {
    const domain = m[2].replace(new RegExp(DOT, 'gi'), '.');
    out.push(`${m[1]}@${domain}`);
  }
  const bare = /\b([a-z0-9._%+-]{2,})\s+at\s+([a-z0-9-]{2,}(?:\s+dot\s+[a-z]{2,}){1,3})\b/gi;
  for (const m of t.matchAll(bare)) {
    // "at" between two ordinary words is English, not an address. Require the
    // local part to look like one: a role word, or something with a digit or
    // a separator in it.
    const local = m[1].toLowerCase();
    if (!/[._\d-]/.test(local) && !ROLE_LOCAL.test(local)) continue;
    out.push(`${m[1]}@${m[2].replace(/\s+dot\s+/gi, '.')}`);
  }
  return out;
}

const ROLE_LOCAL =
  /^(info|contact|hello|enquiry|enquiries|inquiry|sales|admin|office|support|mail|reception|booking|hr|careers|jobs|training|accounts)$/;

/* ------------------------------------------------------------ structured data */

/**
 * What a site says about itself in schema.org JSON-LD.
 *
 * Most site builders emit an Organization or LocalBusiness block with the
 * email, the phone, sometimes the founder and a one-line description — data
 * the business typed in itself, in fields that mean exactly what they say.
 * It is the most reliable thing on the page and it was never being read.
 */
export function extractStructured(html) {
  const out = { emails: [], phones: [], people: [], description: '', employees: '', name: '' };
  const text = String(html || '');
  for (const m of text.matchAll(/<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    walkJsonLd(data, out, 0);
  }
  out.emails = [...new Set(out.emails.map((e) => e.replace(/^mailto:/i, '').trim().toLowerCase()).filter(Boolean))];
  out.phones = [...new Set(out.phones.map((p) => String(p).trim()).filter(Boolean))];
  out.people = [...new Set(out.people)].slice(0, 5);
  return out;
}

const PERSON_KEYS = ['founder', 'founders', 'employee', 'employees', 'member', 'members', 'author', 'director', 'ceo'];

function walkJsonLd(node, out, depth) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  if (node['@graph']) walkJsonLd(node['@graph'], out, depth + 1);

  if (typeof node.email === 'string') out.emails.push(node.email);
  if (typeof node.telephone === 'string') out.phones.push(node.telephone);
  if (!out.description && typeof node.description === 'string') out.description = node.description.slice(0, 400);
  if (!out.name && typeof node.name === 'string' && /Organization|Business|Store|School|Service|Corporation/i.test(String(node['@type'] || ''))) {
    out.name = node.name;
  }
  const staff = node.numberOfEmployees;
  if (!out.employees && staff) {
    out.employees = typeof staff === 'object' ? String(staff.value || staff.minValue || '') : String(staff);
  }
  for (const key of PERSON_KEYS) {
    const who = node[key];
    for (const person of Array.isArray(who) ? who : who ? [who] : []) {
      const name = typeof person === 'string' ? person : person && person.name;
      const role = person && typeof person === 'object' ? person.jobTitle || key : key;
      if (name) out.people.push(`${String(name).trim()} (${String(role).trim()})`);
    }
  }
  if (node.contactPoint) walkJsonLd(node.contactPoint, out, depth + 1);
}

/* ------------------------------------------------------------- page text */

/**
 * What the page says, as plain text, for the lead judge to read.
 *
 * The title and the meta description lead because they are the site's own
 * one-line summary; the body follows, stripped of scripts, styles and markup
 * and cut to a size a prompt can carry fifteen of.
 */
export function pageText(html, limit = 1500) {
  const text = String(html || '');
  if (!text) return '';
  const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const meta =
    (text.match(/<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i) || [])[1] ||
    (text.match(/<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i) || [])[1] ||
    '';
  const body = text
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const clean = (s) => decodeEntities(s).replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  const parts = [clean(title), clean(meta), clean(body).replace(/\n{2,}/g, '\n')].filter(Boolean);
  return [...new Set(parts)].join('\n').slice(0, limit);
}

/**
 * Whether a plain fetch saw the site a visitor sees.
 *
 * Three ways it does not: the fetch failed outright (a firewall answering a
 * non-browser with 403 is the usual one), the page is a challenge, or the page
 * is a JavaScript shell whose content only exists once a browser runs it.
 * Any of the three is a reason to look again in a real tab.
 */
export function looksBlocked(html, status = 200) {
  if (!html || status >= 400) return true;
  const text = String(html);
  if (/cf-browser-verification|challenge-platform|Just a moment\.\.\.|Attention Required! \| Cloudflare|captcha-delivery|Access denied/i.test(text)) {
    return true;
  }
  const visible = pageText(text, 4000).replace(/\s+/g, ' ');
  const scripts = (text.match(/<script\b/gi) || []).length;
  // A document with almost no words and a pile of scripts is an app shell.
  return visible.length < 200 && scripts >= 3;
}

/* ---------------------------------------------------------------- emails */

export function extractEmails(html, siteHost = '') {
  if (!html) return [];

  const found = new Set();

  // Cloudflare-hidden addresses are real and deliberate — the business put
  // them there — so they rank with mailto: links.
  for (const email of cloudflareEmails(html)) found.add(email);

  // mailto: links are unambiguous, so trust them first.
  for (const m of html.matchAll(/mailto:([^"'>?\s]+)/gi)) {
    const value = decodeURIComponent(m[1]).split('?')[0].trim();
    if (value) found.add(value);
  }

  // Then the raw text, which catches addresses printed as plain copy — with
  // entities decoded first, since `info&#64;acme.com` is an address written
  // for a person and hidden from a regex.
  const decoded = decodeEntities(html);
  for (const m of decoded.matchAll(EMAIL_RE)) found.add(m[0]);
  for (const email of deobfuscate(decoded.replace(/<[^>]+>/g, ' '))) found.add(email);
  for (const email of extractStructured(html).emails) found.add(email);

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

/**
 * One page, and whether the server answered at all.
 *
 * The status is kept rather than folded into an empty string: a 403 from a
 * firewall and a page that genuinely lists no email are different problems,
 * and only the first is worth opening in a real tab.
 */
async function fetchPage(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      credentials: 'omit',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (!res.ok) return { html: '', status: res.status };
    if (type && !/html|text|xml/i.test(type)) return { html: '', status: res.status };
    return { html: await res.text(), status: res.status };
  } catch {
    return { html: '', status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Contact-page links the page advertises, then the usual guesses. */
function contactCandidates(html, url) {
  const linked = [];
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    if (!/contact|reach-us|get-in-touch/i.test(m[1])) continue;
    try {
      const next = new URL(m[1], url);
      // Only this site's own pages: a "contact" link to a form builder or a
      // social network is not where the business keeps its address.
      if (next.host === new URL(url).host) linked.push(next.toString());
    } catch {
      /* skip malformed href */
    }
  }
  return [...new Set([...linked, ...FALLBACK_PATHS.map((p) => new URL(p, url).toString())])].slice(0, 3);
}

/**
 * Look for an email on a single business website.
 *
 * Returns { email, allEmails, source, social, siteText, structured, blocked,
 * rendered }. `siteText` is what the page says in plain words, kept for the
 * lead judge; `structured` is the site's own JSON-LD. `blocked` means a plain
 * fetch did not see what a visitor sees.
 *
 * `render(url)` is optional and supplied by the service worker: it opens the
 * page in a real background tab and returns the HTML the browser built. It is
 * only called when the plain fetch was blocked or found nothing on a page that
 * looks like it needs JavaScript — a tab is slow and visible, so it is the
 * second look, never the first.
 */
export async function findEmailForSite(
  website,
  { timeout = 12000, followContactPage = true, render = null, fetchImpl } = {}
) {
  const empty = {
    email: '', allEmails: [], source: '', social: {},
    siteText: '', structured: extractStructured(''), blocked: false, rendered: false,
  };
  const url = normaliseUrl(website);
  if (!url) return empty;

  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return empty;
  }

  const get = (target) => fetchPage(target, timeout, fetchImpl || fetch);
  let { html: home, status } = await get(url);
  let blocked = looksBlocked(home, status);
  let rendered = false;

  // The second look: a real tab, which runs the site's scripts and passes
  // the checks a bare request fails. Only for a site that answered and
  // refused, or answered with a page that is not really there yet — a dead
  // domain, a 404 or a PDF will not become an email by opening a tab on it.
  const refused = [401, 403, 429, 503].includes(status);
  const shell = status >= 200 && status < 300 && Boolean(home);
  if (blocked && render && (refused || shell)) {
    const html = await render(url).catch(() => '');
    if (html) {
      home = html;
      rendered = true;
      blocked = looksBlocked(html, 200);
    }
  }

  const social = extractSocialLinks(home);
  const structured = extractStructured(home);
  const siteText = pageText(home);
  const done = (emails, source) => ({
    email: emails[0] || '', allEmails: emails, source: emails.length ? source : '',
    social, siteText, structured, blocked, rendered,
  });

  let emails = extractEmails(home, host);
  if (emails.length || !followContactPage) return done(emails, url);

  for (const candidate of contactCandidates(home, url)) {
    let { html } = await get(candidate);
    // A site that needed a tab for its homepage needs one for this page too.
    if (rendered && render && (!html || looksBlocked(html, 200))) html = await render(candidate).catch(() => '');
    // Contact pages often carry the social links the homepage omits.
    Object.assign(social, { ...extractSocialLinks(html), ...social });
    emails = extractEmails(html, host);
    if (emails.length) return done(emails, candidate);
  }

  return done([], '');
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
