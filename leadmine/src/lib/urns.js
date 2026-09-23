/** The ids LinkedIn uses for its own filter values, and how we come to know them. */

export const URN_KEY = 'mls.urns';

/** The two seeds, and why only two. */
export const SEED = {
  geoUrn: { india: { id: '102713980', label: 'India' } },
  serviceCategory: { 'corporate training': { id: '20016', label: 'Corporate Training' } },
};

const key = (label) => String(label || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The stored table, with the seeds underneath whatever has been learned. */
export function withSeed(stored) {
  const out = {};
  for (const [facet, entries] of Object.entries(SEED)) out[facet] = { ...entries };
  for (const [facet, entries] of Object.entries(stored || {})) {
    out[facet] = { ...(out[facet] || {}), ...entries };
  }
  return out;
}

/** The id for a label, or '' — never an approximation. */
export function lookup(table, facet, label) {
  const entry = ((table || {})[facet] || {})[key(label)];
  return entry ? entry.id : '';
}

/** Every label known for a facet, in reading order. */
export function labelsFor(table, facet) {
  return Object.values((table || {})[facet] || {})
    .map((entry) => entry.label)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

/** Fold newly observed pairs into the table. */
export function learn(table, pairs) {
  const next = { ...(table || {}) };
  let changed = false;

  for (const pair of pairs || []) {
    const facet = String((pair && pair.facet) || '').trim();
    const label = String((pair && pair.label) || '').trim();
    const id = String((pair && pair.id) || '').trim();
    // A pair missing any part is not a pair. Half an observation is a guess.
    if (!facet || !label || !id) continue;

    const slot = { ...(next[facet] || {}) };
    const existing = slot[key(label)];
    if (existing && existing.id === id) continue;
    slot[key(label)] = { id, label };
    next[facet] = slot;
    changed = true;
  }

  return { table: next, changed };
}
