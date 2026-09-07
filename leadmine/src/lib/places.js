/**
 * The country / state / city lists behind the "Where?" picker.
 *
 * Two rules shaped this:
 *
 *   1. **The picker is an input aid, not a new data path.** Whatever it puts
 *      in the box is exactly what the run searches for, and the box stays
 *      editable. Nothing downstream — the queue, the grid, dedupe, the export
 *      filename — learns that a picker exists. A place you type by hand and a
 *      place you browse to are the same string by the time anything acts on it.
 *
 *   2. **Load one country, never the world.** The source data is 46 MB; the
 *      generator (`scripts/build-geo.mjs`) strips it to names and splits it by
 *      country, so choosing India reads 48 KB and choosing nothing reads the
 *      11 KB index. See that script for where the data comes from.
 */

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

/**
 * How many cities a list may offer.
 *
 * A country with no state chosen can mean four thousand towns. The list is
 * still typeable past this cap — it narrows what is *offered*, and choosing a
 * state is what makes the offer useful anyway.
 */
export const CITY_LIMIT = 2000;

/**
 * The cities to offer, as the strings that will actually be searched.
 *
 * Qualified with the state for Maps, because "dentists in Springfield" is a
 * question with twenty answers and "dentists in Springfield, Illinois" is not.
 * Left bare for LinkedIn, which matches keywords literally — a profile does
 * not contain the words "Tamil Nadu" just because the person is in Chennai.
 */
export function citiesFor(country, regionName, { source = 'maps', limit = CITY_LIMIT } = {}) {
  if (!country || !Array.isArray(country.s)) return [];
  const wanted = String(regionName || '').trim();
  const regions = wanted ? country.s.filter((r) => r.n === wanted) : country.s;
  const qualify = source !== 'linkedin';

  const out = [];
  for (const region of regions) {
    for (const city of region.c) {
      out.push(qualify ? `${city}, ${region.n}` : city);
    }
  }

  // One region is already sorted; several concatenated are in region order,
  // which put Andaman and Nicobar at the top of every list for India.
  if (regions.length > 1) out.sort((a, b) => a.localeCompare(b, 'en'));
  // Truncated after sorting, never during: cutting first and sorting the
  // offcut offers the first N *regions*, not the first N towns.
  return out.length > limit ? out.slice(0, limit) : out;
}

/** The state names of a country, or [] for the ones that have none. */
export function regionsFor(country) {
  if (!country || !Array.isArray(country.s)) return [];
  return country.s.filter((region) => region.c.length).map((region) => region.n);
}
