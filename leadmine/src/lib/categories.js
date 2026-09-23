/** Category narrowing. */

/** A starting list for the picker. */
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

/** Split what the user typed into terms. */
export function parseCategoryFilter(text) {
  return String(text || '')
    .split(',')
    .map((part) => norm(part))
    .filter(Boolean);
}

/** Does this value satisfy any of the terms? */
export function matchesCategory(value, terms) {
  if (!terms || !terms.length) return true;
  const haystack = norm(value);
  if (!haystack) return false;
  return terms.some((term) => haystack.includes(term));
}

/** The text a filter is matched against, which is more than one field for a person. */
function filterText(record, field) {
  const fields = Array.isArray(field) ? field : [field];
  return fields
    .map((name) => String((record && record[name]) || '').trim())
    .filter(Boolean)
    .join(' · ');
}

/** Split records into the ones to keep and the ones to drop. */
export function filterByCategory(records, text, field = 'category') {
  const terms = parseCategoryFilter(text);
  if (!terms.length) return { kept: records || [], dropped: [] };

  const kept = [];
  const dropped = [];
  for (const record of records || []) {
    (matchesCategory(filterText(record, field), terms) ? kept : dropped).push(record);
  }
  return { kept, dropped };
}

/** The distinct values a result set actually used, most common first. */
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
