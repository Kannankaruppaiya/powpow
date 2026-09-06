/**
 * Extraction health.
 *
 * Fallback selectors keep a single broken selector from failing a run — but
 * they also hide the case that matters: Google reshuffles the DOM, *every*
 * strategy for a field misses, and the run cheerfully produces eight hundred
 * rows with an empty Name column. Nothing errors, so nothing stops.
 *
 * This measures how often each field actually came back and stops the run when
 * a field that should almost always be present mostly is not.
 */

/**
 * Fields that indicate a broken scraper when missing, with the fill rate below
 * which the run should stop.
 *
 * These are deliberately not a blanket rule: a phone number is genuinely
 * absent for plenty of real businesses, so a low phone rate is information,
 * not a fault. Only fields Maps shows for every listing are gates.
 */
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

/**
 * Below this many records the rates are noise — a village with four dentists
 * would otherwise trip a 90% gate on a single missing field.
 */
export const MIN_SAMPLE = 20;

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

/**
 * Decide whether a run is healthy enough to continue.
 *
 * Returns `ok: true` for a sample too small to judge — refusing to guess is
 * the point; a false stop is as bad as a missed one.
 */
export function assessHealth(records, { gates = DEFAULT_GATES, minSample = MIN_SAMPLE, watched = DEFAULT_WATCHED } = {}) {
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
    reason: breaches.length ? describeBreaches(breaches) : 'healthy',
  };
}

/** A sentence a user can act on, not a stack trace. */
export function describeBreaches(breaches) {
  if (!breaches || !breaches.length) return '';
  const parts = breaches.map(
    ({ field, rate, threshold }) =>
      `${field} found in only ${Math.round(rate * 100)}% of listings (expected ${Math.round(threshold * 100)}%+)`
  );
  return `Extraction looks broken — ${parts.join('; ')}. Google may have changed the page. Run paused so you do not export empty rows.`;
}

/** Compact rates for the UI, worst first, skipping fields nothing was found for. */
export function summariseRates(rates) {
  return Object.entries(rates || {})
    .map(([field, rate]) => ({ field, rate }))
    .sort((a, b) => a.rate - b.rate);
}
