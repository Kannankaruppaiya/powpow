/** After the download: who has been contacted, who is due a follow-up, and who must never be written to. */

export const STATUSES = [
  { id: 'new', label: 'New' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'followed_up', label: 'Followed up' },
  { id: 'replied', label: 'Replied' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'won', label: 'Won' },
  { id: 'not_interested', label: 'Not interested' },
  { id: 'do_not_contact', label: 'Do not contact' },
];

export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));

/** Working days to wait after each touch before the next one is due. */
export const FOLLOW_UP_GAPS = [3, 5];

/** Statuses where the conversation is over, one way or the other. */
const CLOSED = new Set(['won', 'not_interested', 'do_not_contact']);

/** Add working days (Mon–Fri) to a date. Returns YYYY-MM-DD. */
export function addWorkingDays(from, days) {
  const d = new Date(from);
  d.setHours(12, 0, 0, 0); // away from midnight, so a DST shift cannot move the day
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return isoDay(d);
}

export const isoDay = (d) => {
  const date = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** What a status change does to the rest of the note. */
export function statusPatch(note, status, now = new Date()) {
  const current = note || {};
  const touches = current.touches || 0;
  const patch = { status, statusAt: now.getTime() };

  if (status === 'contacted') {
    patch.touches = Math.max(1, touches);
    patch.followUpOn = addWorkingDays(now, FOLLOW_UP_GAPS[0]);
  } else if (status === 'followed_up') {
    const next = Math.max(2, touches + 1);
    patch.touches = next;
    const gap = FOLLOW_UP_GAPS[next - 1];
    patch.followUpOn = gap ? addWorkingDays(now, gap) : null;
  } else {
    patch.followUpOn = null;
  }
  if (status === 'do_not_contact') patch.suppressed = true;
  return patch;
}

/** Whether a lead is waiting on the user today. */
export function isDue(note, today = isoDay(new Date())) {
  if (!note || !note.followUpOn || CLOSED.has(note.status)) return false;
  return note.followUpOn <= today;
}

/* ------------------------------------------------------------ suppression */

const phoneKey = (s) => {
  const digits = String(s || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
};

const slugOf = (url) => {
  const m = String(url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
};

export const domainOf = (url) => {
  try {
    const u = new URL(/^https?:\/\//i.test(String(url)) ? String(url) : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

/** Free mailbox providers: suppressing gmail.com would suppress half the world. */
const SHARED_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'aol.com', 'rediffmail.com', 'proton.me', 'protonmail.com', 'zoho.com',
]);

/** Read one line the user typed into the do-not-contact box. */
export function parseSuppressionLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const value = raw.toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(value)) return { value: `email:${value}`, kind: 'email', label: raw };
  const slug = slugOf(raw);
  if (slug) return { value: `profile:${slug}`, kind: 'profile', label: raw };
  if (/^@?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))) {
    const domain = domainOf(value.replace(/^@/, ''));
    if (domain && !SHARED_DOMAINS.has(domain)) return { value: `domain:${domain}`, kind: 'domain', label: raw };
    return { error: `${raw}: a shared mailbox domain — add the address instead` };
  }
  const phone = phoneKey(value);
  if (phone) return { value: `phone:${phone}`, kind: 'phone', label: raw };
  return { error: `${raw}: not an email, domain, LinkedIn profile or phone number` };
}

export function parseSuppressionText(text) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n|,(?=\s*\S+@)/)) {
    const parsed = parseSuppressionLine(line);
    if (!parsed) continue;
    if (parsed.error) errors.push(parsed.error);
    else if (!seen.has(parsed.value)) {
      seen.add(parsed.value);
      entries.push(parsed);
    }
  }
  return { entries, errors };
}

/** Every identity a lead could be suppressed under. */
export function suppressionKeys(record, note = {}) {
  const keys = [];
  for (const email of [record && record.email, note.personEmail, ...String((record && record.emails) || '').split(';')]) {
    const e = String(email || '').trim().toLowerCase();
    if (e.includes('@')) {
      keys.push(`email:${e}`);
      const domain = e.split('@')[1];
      if (domain && !SHARED_DOMAINS.has(domain)) keys.push(`domain:${domain}`);
    }
  }
  const site = domainOf(record && record.website);
  if (site) keys.push(`domain:${site}`);
  const slug = slugOf(record && (record.profileUrl || record.authorUrl));
  if (slug) keys.push(`profile:${slug}`);
  const phone = phoneKey(record && record.phone);
  if (phone) keys.push(`phone:${phone}`);
  return keys;
}

/** A checker over the current list, for filters and the export. */
export function suppressionChecker(entries) {
  const set = new Set((entries || []).map((e) => e.value));
  return (record, note = {}) =>
    Boolean(note.suppressed || note.status === 'do_not_contact') ||
    suppressionKeys(record, note).some((k) => set.has(k));
}

/** The entries a lead adds to the list when the user marks it do-not-contact. */
export function suppressionEntriesFor(record, note = {}) {
  const out = [];
  const email = String(note.personEmail || (record && record.email) || '').trim().toLowerCase();
  if (email.includes('@')) out.push({ value: `email:${email}`, kind: 'email', label: email, reason: 'marked do not contact' });
  const slug = slugOf(record && (record.profileUrl || record.authorUrl));
  if (slug) out.push({ value: `profile:${slug}`, kind: 'profile', label: record.profileUrl || record.authorUrl, reason: 'marked do not contact' });
  const phone = phoneKey(record && record.phone);
  if (phone) out.push({ value: `phone:${phone}`, kind: 'phone', label: record.phone, reason: 'marked do not contact' });
  return out;
}

/** The list back as text for the box, one entry per line. */
export function suppressionText(entries) {
  return (entries || [])
    .map((e) => e.label || String(e.value || '').replace(/^[a-z]+:/, ''))
    .join('\n');
}

/* -------------------------------------------------- sequencer export */

/** First and last name from one full name. A guess — only used when nothing better exists. */
export function splitName(full) {
  const parts = String(full || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(dr|mr|mrs|ms|prof)\.?\s+/i, '')
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** The columns cold-email tools import without mapping. */
export const SEQUENCER_COLUMNS = [
  { key: 'email', label: 'email' },
  { key: 'first_name', label: 'first_name' },
  { key: 'last_name', label: 'last_name' },
  { key: 'company', label: 'company' },
  { key: 'title', label: 'title' },
  { key: 'website', label: 'website' },
  { key: 'linkedin_url', label: 'linkedin_url' },
  { key: 'phone', label: 'phone' },
  { key: 'location', label: 'location' },
  { key: 'reason', label: 'reason' },
  { key: 'services', label: 'services' },
  { key: 'source', label: 'source' },
  { key: 'lead_id', label: 'lead_id' },
];

/** Rows for a cold-email tool. */
export function sequencerRows(records, notes = new Map(), { isSuppressed = () => false, linked = new Map() } = {}) {
  const out = [];
  const seen = new Set();
  for (const record of records || []) {
    const note = notes.get(record.key) || {};
    const email = String(note.personEmail || record.email || String(record.emails || '').split(';')[0] || '')
      .trim()
      .toLowerCase();
    if (!email.includes('@') || seen.has(email)) continue;
    if (isSuppressed(record, note)) continue;
    const verdict = note.feedback === 'bad' ? 'no_fit' : note.feedback === 'good' ? 'fit' : note.verdict;
    if (verdict === 'no_fit') continue;
    if (['not_interested', 'do_not_contact', 'won'].includes(note.status)) continue;
    // A bounce-certain address is worse than none: it costs sender reputation.
    if (['no-mx', 'invalid', 'disposable'].includes(record.emailStatus)) continue;
    seen.add(email);

    const person = record.source === 'linkedin' || record.source === 'web';
    const post = record.source === 'posts';
    const guessed = splitName(person ? record.name : post ? record.author : note.decisionMaker || '');
    const business = linked.get(record.key);
    out.push({
      email,
      first_name: note.firstName || guessed.first,
      last_name: note.lastName || guessed.last,
      company: person ? record.company || (business && business.name) || '' : post ? '' : record.name || '',
      title: person ? record.headline || '' : '',
      website: record.website || (business && business.website) || '',
      linkedin_url: record.profileUrl || record.authorUrl || record.linkedin || '',
      phone: record.phone || String(record.phones || '').split(';')[0].trim() || (business && business.phone) || '',
      location: record.location || [record.area, record.city].filter(Boolean).join(', '),
      reason: note.reason || '',
      services: note.services || '',
      source: record.source || 'maps',
      lead_id: record.key || '',
    });
  }
  return out;
}
