/** Extraction health. */

/** Fields that indicate a broken scraper when missing, with the fill rate below which the run should stop. */
export const DEFAULT_GATES = {
  name: 0.9,
  mapsUrl: 0.9,
};

/** Fields worth reporting on without ever blocking a run. */
export const DEFAULT_WATCHED = [
  'name',
  'mapsUrl',
  'category',
  'address',
  'phone',
  'rating',
  'website',
];

/** Below this many records the rates are noise. */
export const MIN_SAMPLE = 20;

/** The gates and watch list for a source, falling back to the defaults. */
export function gatesFor(source) {
  return {
    gates: (source && source.healthGates) || DEFAULT_GATES,
    watched: (source && source.watched) || DEFAULT_WATCHED,
    // Who changed the page, and what a row is, both depend on the source.
    site: (source && source.site) || 'Google',
    noun: (source && source.rowNoun) || 'listings',
  };
}

const filled = (value) => {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== '';
};

/** Fill rate per field, from 0 to 1. */
export function fieldRates(records, fields = DEFAULT_WATCHED) {
  const list = records || [];
  const rates = {};
  if (!list.length) {
    for (const field of fields) rates[field] = 0;
    return rates;
  }
  for (const field of fields) {
    rates[field] = list.filter((r) => filled(r && r[field])).length / list.length;
  }
  return rates;
}

/** Decide whether a run is healthy enough to continue. */
export function assessHealth(
  records,
  { gates = DEFAULT_GATES, minSample = MIN_SAMPLE, watched = DEFAULT_WATCHED, site, noun } = {}
) {
  const list = records || [];
  const fields = [...new Set([...watched, ...Object.keys(gates)])];
  const rates = fieldRates(list, fields);

  if (list.length < minSample) {
    return { ok: true, sample: list.length, rates, breaches: [], reason: 'sample too small to judge' };
  }

  const breaches = Object.entries(gates)
    .filter(([field, threshold]) => rates[field] < threshold)
    .map(([field, threshold]) => ({ field, rate: rates[field], threshold }));

  return {
    ok: breaches.length === 0,
    sample: list.length,
    rates,
    breaches,
    reason: breaches.length ? describeBreaches(breaches, { site, noun }) : 'healthy',
  };
}

/** A sentence a user can act on, not a stack trace. */
export function describeBreaches(breaches, { site = 'Google', noun = 'listings' } = {}) {
  if (!breaches || !breaches.length) return '';
  const parts = breaches.map(
    ({ field, rate, threshold }) =>
      `${field} found in only ${Math.round(rate * 100)}% of ${noun} (expected ${Math.round(threshold * 100)}%+)`
  );
  return `Extraction looks broken — ${parts.join('; ')}. ${site} may have changed the page. Run paused so you do not export empty rows.`;
}

/** Compact rates for the UI, worst first, skipping fields nothing was found for. */
export function summariseRates(rates) {
  return Object.entries(rates || {})
    .map(([field, rate]) => ({ field, rate }))
    .sort((a, b) => a.rate - b.rate);
}
