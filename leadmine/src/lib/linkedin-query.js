/** A LinkedIn people search, as an object rather than a string. */

const BASE = 'https://www.linkedin.com/search/results/people/';

/** ["a","b"] → ['a','b'], anything else → null. */
function asFacet(value) {
  if (typeof value !== 'string' || value[0] !== '[') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

/** A URL the user is looking at → the query it represents. */
export function parseUrl(href) {
  const url = new URL(href);
  const query = { facets: {}, scalars: {}, order: [] };
  for (const [key, value] of url.searchParams) {
    const facet = asFacet(value);
    if (facet) query.facets[key] = facet;
    else query.scalars[key] = value;
    query.order.push(key);
  }
  return query;
}

/** A query → the URL that runs it. */
export function buildUrl(query, base = BASE) {
  const scalars = query.scalars || {};
  const facets = query.facets || {};
  // Whatever order the page used, then anything added since, in the order it was added.
  const keys = [...(query.order || []), ...Object.keys(scalars), ...Object.keys(facets)];

  const parts = [];
  const written = new Set();
  for (const key of keys) {
    if (written.has(key)) continue;
    written.add(key);
    if (key in scalars) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(scalars[key])}`);
    } else if (facets[key] && facets[key].length) {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(facets[key]))}`);
    }
  }
  return parts.length ? `${base}?${parts.join('&')}` : base;
}

/** The same search, once per value of one facet. */
/** Which page of results a URL asks for. */
export function pageOf(href) {
  return Math.max(1, Number(parseUrl(href).scalars.page) || 1);
}

/** The same search, at another page. */
export function pageUrl(href, n) {
  const query = parseUrl(href);
  if (n <= 1) {
    delete query.scalars.page;
    query.order = query.order.filter((key) => key !== 'page');
  } else {
    query.scalars.page = String(n);
    if (!query.order.includes('page')) query.order.push('page');
  }
  return buildUrl(query);
}

export function partition(query, facet, values) {
  return values.map((value) => ({
    ...query,
    facets: { ...query.facets, [facet]: [value] },
  }));
}

/** Take the place back out of the keywords once a facet carries it. */
export function dropFromKeywords(query, words) {
  const keywords = String((query.scalars || {}).keywords || '');
  if (!keywords) return query;
  let out = keywords;
  for (const word of words) {
    if (!word) continue;
    out = out.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ');
  }
  out = out.replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return { ...query, scalars: { ...query.scalars, keywords: out } };
}
