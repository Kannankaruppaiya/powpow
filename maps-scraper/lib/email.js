// Email discovery. Google Maps holds no email field, so the only source is the
// business website taken from the listing.

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const JUNK_DOMAINS = [
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'example.com',
  'example.org', 'domain.com', 'yourdomain.com', 'email.com', 'godaddy.com',
  'squarespace.com', 'wix.com', 'shopify.com', 'sentry.wixpress.com',
  'schema.org', 'w3.org', 'jquery.com', 'googleapis.com', 'gstatic.com',
];

const JUNK_SUFFIXES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.css', '.js'];

function isPlausible(email) {
  const lower = email.toLowerCase();
  if (JUNK_SUFFIXES.some((s) => lower.endsWith(s))) return false;
  const domain = lower.split('@')[1] || '';
  if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return false;
  if (lower.length > 80) return false;
  if (/^[0-9a-f]{16,}@/.test(lower)) return false; // hashed/tracking addresses
  return true;
}

function harvest(html) {
  const found = new Set();
  const matches = html.match(EMAIL_RE) || [];
  for (const raw of matches) {
    const email = raw.replace(/^[.\-_]+|[.\-_]+$/g, '');
    if (isPlausible(email)) found.add(email.toLowerCase());
  }
  return Array.from(found);
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return '';
    const type = res.headers.get('content-type') || '';
    if (type && type.indexOf('html') === -1 && type.indexOf('text') === -1) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function contactPageUrls(html, baseUrl) {
  const urls = new Set();
  const hrefs = html.match(/href\s*=\s*["']([^"']+)["']/gi) || [];
  for (const raw of hrefs) {
    const href = raw.replace(/^href\s*=\s*["']/i, '').replace(/["']$/, '');
    if (!/contact|reach-us|about|enquiry|inquiry|support/i.test(href)) continue;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.origin === new URL(baseUrl).origin) urls.add(url.href);
    } catch {
      /* skip malformed hrefs */
    }
    if (urls.size >= 3) break;
  }
  return Array.from(urls);
}

/**
 * Fetches a business website and its contact pages, returning any emails found.
 * Returns [] for sites that block us, time out, or simply publish no address.
 */
export async function findEmails(website, timeoutMs = 12000) {
  if (!website) return [];
  let base;
  try {
    base = new URL(website).href;
  } catch {
    return [];
  }

  const html = await fetchText(base, timeoutMs);
  if (!html) return [];

  const direct = harvest(html);
  if (direct.length) return direct;

  for (const url of contactPageUrls(html, base)) {
    const page = await fetchText(url, timeoutMs);
    const emails = harvest(page);
    if (emails.length) return emails;
  }
  return [];
}
