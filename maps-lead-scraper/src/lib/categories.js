/**
 * Category narrowing.
 *
 * A search like "wholesale store" returns whatever Google thinks is close:
 * furniture wholesalers, produce markets, cell-phone accessory shops. The
 * search box cannot express "only the wholesale markets", so this does —
 * after the listings are collected, before anything expensive is spent on
 * them.
 *
 * Optional throughout: an empty filter keeps everything, which is the
 * behaviour every run had before this existed.
 */

/**
 * A starting list for the picker. Not exhaustive and not meant to be — the
 * useful suggestions are the categories a run actually returned, which the
 * panel merges in on top of these.
 */
export const COMMON_CATEGORIES = [
  'Software company',
  'IT services',
  'Training centre',
  'Coaching centre',
  'Consultant',
  'Marketing agency',
  'Advertising agency',
  'Wholesale market',
  'Wholesaler',
  'Distributor',
  'Manufacturer',
  'Supplier',
  'Building materials supplier',
  'Hardware store',
  'Electrical supply store',
  'Construction company',
  'Interior designer',
  'Architect',
  'Real estate agency',
  'Dental clinic',
  'Dentist',
  'Hospital',
  'Medical clinic',
  'Diagnostic centre',
  'Pharmacy',
  'Gym',
  'Yoga studio',
  'Beauty salon',
  'Spa',
  'Restaurant',
  'Cafe',
  'Catering service',
  'Hotel',
  'School',
  'College',
  'Chartered accountant',
  'Law firm',
  'Insurance agency',
  'Travel agency',
  'Logistics service',
  'Courier service',
  'Car dealer',
  'Auto repair shop',
  'Printing shop',
  'Event planner',
  'Photographer',
];

const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Split what the user typed into terms.
 *
 * Commas separate alternatives, so "wholesale, distributor" keeps either.
 * Blank in means no filtering at all.
 */
export function parseCategoryFilter(text) {
  return String(text || '')
    .split(',')
    .map((part) => norm(part))
    .filter(Boolean);
}

/**
 * Does this value satisfy any of the terms?
 *
 * Substring, not exact: someone typing "wholesale" means the wholesale
 * markets, the wholesale grocers and the furniture wholesalers — demanding an
 * exact category name would make the field useless, because nobody knows what
 * Google will label a listing.
 */
export function matchesCategory(value, terms) {
  if (!terms || !terms.length) return true;
  const haystack = norm(value);
  if (!haystack) return false;
  return terms.some((term) => haystack.includes(term));
}

/**
 * Split records into the ones to keep and the ones to drop.
 *
 * `field` differs by source: a business has a category, a person has a
 * headline. Records with nothing in that field are dropped when a filter is
 * set — an unlabelled row cannot be shown to satisfy the filter, and silently
 * keeping it would defeat the point of narrowing.
 */
export function filterByCategory(records, text, field = 'category') {
  const terms = parseCategoryFilter(text);
  if (!terms.length) return { kept: records || [], dropped: [] };

  const kept = [];
  const dropped = [];
  for (const record of records || []) {
    (matchesCategory(record && record[field], terms) ? kept : dropped).push(record);
  }
  return { kept, dropped };
}

/**
 * The distinct values a result set actually used, most common first.
 * These are the suggestions worth offering — they are known to exist.
 */
export function observedCategories(records, field = 'category') {
  const counts = new Map();
  for (const record of records || []) {
    const value = String((record && record[field]) || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value]) => value);
}

/** Suggestions for the picker: what this run found, then the standing list. */
export function suggestionsFor(records, field = 'category') {
  const seen = observedCategories(records, field);
  const lower = new Set(seen.map(norm));
  return [...seen, ...COMMON_CATEGORIES.filter((c) => !lower.has(norm(c)))];
}
