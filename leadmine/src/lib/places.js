/** The country / state / city lists behind the "Where?" picker. */

/** Where the packaged data sits, whether or not there is an extension around. */
function assetUrl(path) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(path);
  }
  return new URL(`../../${path}`, import.meta.url).href;
}

const cache = new Map();

async function readJson(path) {
  if (cache.has(path)) return cache.get(path);
  const pending = fetch(assetUrl(path)).then((res) => {
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.json();
  });
  // Cached as the promise, so two selects asking at once share one request.
  cache.set(path, pending);
  try {
    return await pending;
  } catch (err) {
    cache.delete(path);
    throw err;
  }
}

/** `[{ c: 'IN', n: 'India', e: '🇮🇳' }, …]`, already in reading order. */
export function loadCountries() {
  return readJson('src/data/geo/countries.json');
}

/** `{ n: 'India', s: [{ n: 'Tamil Nadu', c: ['Chennai', …] }, …] }` */
export function loadCountry(code) {
  const iso = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso)) return Promise.resolve(null);
  return readJson(`src/data/geo/${iso}.json`);
}

/** How many cities a list may offer. */
export const CITY_LIMIT = 2000;

/** The cities to offer, as the strings that will actually be searched. */
export function citiesFor(country, regionName, { source = 'maps', limit = CITY_LIMIT } = {}) {
  if (!country || !Array.isArray(country.s)) return [];
  const wanted = String(regionName || '').trim();
  const regions = wanted ? country.s.filter((r) => r.n === wanted) : country.s;
  // LinkedIn matches words literally, and a post rarely names its state.
  const qualify = source !== 'linkedin' && source !== 'posts';

  const out = [];
  for (const region of regions) {
    for (const city of region.c) {
      out.push(qualify ? `${city}, ${region.n}` : city);
    }
  }

  // One region is already sorted.
  if (regions.length > 1) out.sort((a, b) => a.localeCompare(b, 'en'));
  // Truncated after sorting, never during.
  return out.length > limit ? out.slice(0, limit) : out;
}

/** The state names of a country, or [] for the ones that have none. */
export function regionsFor(country) {
  if (!country || !Array.isArray(country.s)) return [];
  return country.s.filter((region) => region.c.length).map((region) => region.n);
}
