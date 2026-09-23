/** Identity and merging for scraped records. */

/** Normalise a name or place for comparison. */
const key = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Digits only, so "+91 98765 43210" and "098765 43210" compare equal-ish. */
const phoneKey = (s) => {
  const digits = String(s || '').replace(/\D/g, '');
  // Compare on the last 10 digits.
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

/** The identity of a business, best available. */
export function recordKey(record) {
  if (!record) return '';

  const url = String(record.mapsUrl || '');
  const feature = url.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
  if (feature) return `fid:${feature[0].toLowerCase()}`;

  const cid = url.match(/[?&]cid=(\d+)/);
  if (cid) return `cid:${cid[1]}`;

  const phone = phoneKey(record.phone);
  if (phone.length >= 10) return `tel:${phone}`;

  // A LinkedIn profile URL is the one truly stable identity a person has.
  const post = String(record.postId || '');
  if (/^\d{18,20}$/.test(post)) return `post:${post}`;

  const profile = String(record.profileUrl || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (profile) return `li:${decodeURIComponent(profile[1]).toLowerCase()}`;

  const name = key(record.name);
  if (!name) return '';

  // Name alone is not enough.
  const place = key(record.address) || key(record.area) || key(record.city);
  return place ? `name:${name}@${place}` : `name:${name}`;
}

/** True when `next` is a better value for this field than `current`. */
function isBetter(field, current, next) {
  if (next === undefined || next === null || next === '') return false;
  if (current === undefined || current === null || current === '') return true;

  if (Array.isArray(next)) return next.length > (Array.isArray(current) ? current.length : 0);
  // A detail-panel address is longer and more complete than a card's snippet.
  if (field === 'address' || field === 'hours' || field === 'text') {
    return String(next).length > String(current).length;
  }
  return false;
}

/** Fold `next` into `base`, keeping whichever fields are richer. */
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

/** Collapse a list of records to one row per business. */
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

/** Fold a task's haul into a running result set, in place. */
export function absorbInto(records, incoming) {
  const index = new Map();
  for (const record of records) {
    if (record.key) index.set(record.key, record);
  }

  let added = 0;
  const touched = [];

  for (const record of incoming || []) {
    const id = recordKey(record);
    if (!id) {
      // Nothing to match on — keep it rather than silently lose a business.
      const copy = { ...record, key: `anon:${records.length}:${Date.now()}` };
      records.push(copy);
      touched.push(copy);
      added += 1;
      continue;
    }

    const existing = index.get(id);
    if (existing) {
      Object.assign(existing, mergeRecords(existing, record), { key: id });
      touched.push(existing);
    } else {
      const copy = { ...record, key: id };
      records.push(copy);
      index.set(id, copy);
      touched.push(copy);
      added += 1;
    }
  }
  return { added, touched };
}

/** A bounded set of business keys seen in previous runs. */
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
