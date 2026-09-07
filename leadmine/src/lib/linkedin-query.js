/**
 * A LinkedIn people search, as an object rather than a string.
 *
 * The search was a string — `"java developer" + " " + "London"` — and that is
 * the whole reason a LinkedIn run came back with the wrong people. A place in
 * `keywords` is not a location filter; it is a word LinkedIn hunts for
 * anywhere in a profile, which is why searching Theni returned Coimbatore and
 * Chennai. A people search is a structured query, so this models one.
 *
 * Built against three real URLs, not from memory:
 *
 *   ?keywords=finance%20head%20theni&origin=FACETED_SEARCH
 *     &geoUrn=%5B%22101138777%22%5D
 *   …&geoUrn=%5B%22101138777%22%2C%22106888327%22%5D
 *   ?keywords=kotlin%20&origin=FACETED_SEARCH&geoUrn=%5B%22102713980%22%5D
 *     &serviceCategory=%5B%2220016%22%5D
 *
 * Three facts those URLs settle, and that the code below encodes rather than
 * assumes:
 *
 *   1. A facet value is a JSON array of strings, URL-encoded — geoUrn is
 *      ["101138777"], not 101138777 and not urn:li:geo:101138777.
 *   2. `keywords` is a plain scalar and stays out of it.
 *   3. Spaces are %20, not +. URLSearchParams writes +, which is why the
 *      query string is assembled by hand here.
 *
 * No facet is enumerated. Anything whose value parses as a JSON array of
 * strings is treated as a facet; everything else is a scalar; anything not
 * recognised survives untouched. That way currentCompany, industry, network
 * and whatever LinkedIn adds next need no code — only geoUrn was ever
 * observed, and guessing the rest is what got this wrong the first time.
 */

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

/**
 * A URL the user is looking at → the query it represents.
 *
 * `order` records the parameter order the page used. Order does not change
 * what a URL means, but this codec's job is to read a search, change one
 * thing and run it again — and a rebuild that shuffles the other parameters
 * looks like a change when nothing changed. Lossless is the right bar.
 */
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
  // Whatever order the page used, then anything added since, in the order it
  // was added.
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

/**
 * The same search, once per value of one facet.
 *
 * This is the LinkedIn answer to the geographic grid: one people search stops
 * after a fixed number of pages however good the filter is, so coverage comes
 * from splitting the query, not from scrolling harder. The queue already runs
 * a list of tasks and dedupes on profileUrl.
 */
export function partition(query, facet, values) {
  return values.map((value) => ({
    ...query,
    facets: { ...query.facets, [facet]: [value] },
  }));
}

/**
 * Take the place back out of the keywords once a facet carries it.
 *
 * With geoUrn applied, the word "theni" in keywords stops meaning "in Theni"
 * and starts meaning "profiles containing the word theni" — a second, much
 * harsher filter nobody asked for, on top of the real one.
 */
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
