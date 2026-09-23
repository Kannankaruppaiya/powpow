/**
 * The ids LinkedIn uses for its own filter values, and how we come to know them.
 *
 * A LinkedIn facet does not take a name. `geoUrn` takes 102713980, not
 * "India"; `serviceCategory` takes 20016, not "Corporate Training". Those ids
 * are LinkedIn's internal numbers — not published, not documented, and not
 * derivable from the name. There is no table to ship.
 *
 * So they are *learned*. Every time the user applies a filter on LinkedIn by
 * hand, the content script sees both halves at once — the label on the
 * checkbox they ticked, and the id that lands in the URL — and pairs them.
 * One filter, applied once, is known forever after.
 *
 * The one rule this file exists to enforce: **never guess an id**. A wrong id
 * does not fail — it quietly searches somewhere else and hands back a
 * plausible spreadsheet of the wrong people, which is the worst outcome this
 * product has. Only pairs actually observed are stored, and lookups miss
 * rather than approximate.
 */

export const URN_KEY = 'mls.urns';

/**
 * The two seeds, and why only two.
 *
 * Both were read off a live page where the pill showed the label and the URL
 * showed the id at the same time, with nothing else applied. Two more ids have
 * been observed — 101138777 and 106888327, from a search with Theni and
 * Chennai ticked — but which is which is an inference from the order they
 * appeared in, and an inference is exactly what must not be seeded here. They
 * will be learned properly the first time either is applied on its own.
 */
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

/**
 * Fold newly observed pairs into the table.
 *
 * Returns the new table and whether anything actually changed, so a run that
 * learned nothing does not write to storage on every page.
 */
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
