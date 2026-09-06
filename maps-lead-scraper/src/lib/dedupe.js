/**
 * Identity and merging for scraped records.
 *
 * A grid search deliberately overlaps: neighbouring cells return many of the
 * same businesses, and a batch of related searches ("dentist", "dental
 * clinic") returns more still. Every record therefore needs a stable identity,
 * and two sightings of one business need to combine into the better of the
 * two rather than becoming two rows.
 */

/** Normalise a name or place for comparison. */
const key = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Digits only, so "+91 98765 43210" and "098765 43210" compare equal-ish. */
const phoneKey = (s) => {
  const digits = String(s || '').replace(/\D/g, '');
  // Compare on the last 10 digits: country codes and trunk prefixes vary
  // between the card text and the tel: attribute for the same business.
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

/**
 * The identity of a business, best available.
 *
 * Google embeds a feature id in place URLs — "!1s0x3a5265ea4f0d3b1d:0x..." —
 * which is the same for a business no matter which search surfaced it. That is
 * by far the most reliable key; the rest are fallbacks for records that only
 * ever appeared in a results list.
 */
export function recordKey(record) {
  if (!record) return '';

  const url = String(record.mapsUrl || '');
  const feature = url.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
  if (feature) return `fid:${feature[0].toLowerCase()}`;

  const cid = url.match(/[?&]cid=(\d+)/);
  if (cid) return `cid:${cid[1]}`;

  const phone = phoneKey(record.phone);
  if (phone.length >= 10) return `tel:${phone}`;

  const name = key(record.name);
  if (!name) return '';

  // Name alone is not enough — chains repeat it across a city — so pair it
  // with the most specific location text available.
  const place = key(record.address) || key(record.area) || key(record.city);
  return place ? `name:${name}@${place}` : `name:${name}`;
}

/** True when `next` is a better value for this field than `current`. */
function isBetter(field, current, next) {
  if (next === undefined || next === null || next === '') return false;
  if (current === undefined || current === null || current === '') return true;

  if (Array.isArray(next)) return next.length > (Array.isArray(current) ? current.length : 0);
  // A detail-panel address is longer and more complete than a card's snippet.
  if (field === 'address' || field === 'hours') return String(next).length > String(current).length;
  return false;
}

/**
 * Fold `next` into `base`, keeping whichever fields are richer.
 *
 * Deep-scraped data wins over list-only data wholesale, because the detail
 * panel is authoritative for the fields both sources provide.
 */
export function mergeRecords(base, next) {
  if (!base) return { ...next };
  if (!next) return base;

  const merged = { ...base };
  const preferNext = Boolean(next.detailScraped) && !base.detailScraped;

  for (const [field, value] of Object.entries(next)) {
    if (field === 'detailScraped') continue;
    if (preferNext ? value !== undefined && value !== null && value !== '' : isBetter(field, merged[field], value)) {
      merged[field] = value;
    }
  }

  merged.detailScraped = Boolean(base.detailScraped || next.detailScraped);
  return merged;
}

/**
 * Collapse a list of records to one row per business.
 * Order is preserved by first sighting, which keeps exports stable.
 */
export function dedupeRecords(records) {
  const byKey = new Map();
  const anonymous = [];

  for (const record of records || []) {
    const id = recordKey(record);
    if (!id) {
      anonymous.push(record); // nothing to match on — keep it rather than lose it
      continue;
    }
    byKey.set(id, mergeRecords(byKey.get(id), record));
  }

  return [...byKey.values(), ...anonymous];
}

/**
 * Fold a task's haul into a running result set, in place.
 *
 * Grid cells overlap heavily, so most of what a later cell returns is already
 * present; those sightings merge into the existing row instead of appending.
 * Returns how many genuinely new businesses were added, which is the number
 * worth showing the user per search.
 */
export function absorbInto(records, incoming) {
  const index = new Map();
  for (const record of records) {
    const id = recordKey(record);
    if (id) index.set(id, record);
  }

  let added = 0;
  for (const record of incoming || []) {
    const id = recordKey(record);
    if (!id) {
      // Nothing to match on — keep it rather than silently lose a business.
      records.push({ ...record });
      added += 1;
      continue;
    }

    const existing = index.get(id);
    if (existing) {
      Object.assign(existing, mergeRecords(existing, record));
    } else {
      const copy = { ...record };
      records.push(copy);
      index.set(id, copy);
      added += 1;
    }
  }
  return added;
}

/**
 * A bounded set of business keys seen in previous runs.
 *
 * Kept as an array in storage (a Set does not survive structured cloning into
 * chrome.storage) and trimmed oldest-first so it cannot grow without limit.
 */
export const SEEN_LIMIT = 50000;

export function addToSeen(seen, records, limit = SEEN_LIMIT) {
  const list = Array.isArray(seen) ? [...seen] : [];
  const known = new Set(list);

  for (const record of records || []) {
    const id = recordKey(record);
    if (id && !known.has(id)) {
      known.add(id);
      list.push(id);
    }
  }

  return list.length > limit ? list.slice(list.length - limit) : list;
}

export function filterUnseen(records, seen) {
  const known = new Set(Array.isArray(seen) ? seen : []);
  if (!known.size) return records || [];
  return (records || []).filter((record) => {
    const id = recordKey(record);
    return !id || !known.has(id);
  });
}
