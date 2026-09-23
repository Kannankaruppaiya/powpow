/** India's Global Capability Centres, and whether a lead comes from one. */

import { employerOf } from './link.js';

// The user's own additions to the built-in list, one name per entry.
export const GCC_EXTRA_KEY = 'mls.gccExtra';

// Words two spellings of one company disagree on.
const TAIL = new Set([
  'the', 'pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'co', 'company', 'corp',
  'corporation', 'plc', 'gmbh', 'ag', 'se', 'sa', 'nv', 'bv', 'pte', 'srl', 'group', 'holdings', 'india', 'and', 'of',
]);

// Names that are also ordinary words: trusted only where a company is named, and only whole.
const COMMON = new Set([
  'target', 'shell', 'visa', 'orange', 'wise', 'toast', 'glean', 'elastic', 'precisely', 'arrive', 'forage', 'mars',
  'dover', 'apple', 'meta', 'indeed', 'intuitive', 'assent', 'octave', 'tide', 'bold', 'zebra', 'remote', 'flex',
  'here', 'nice', 'signify', 'lumen', 'avid', 'progress', 'nationwide', 'providence', 'standard', 'continental',
  'delta', 'principal', 'guardian', 'stripe', 'workday', 'snowflake', 'pioneer', 'apollo', 'chevron', 'arcadia',
  'amelia', 'aurus', 'crowe', 'columbia', 'metro', 'otto', 'maximus', 'cube', 'forescout', 'remotecom', 'zinnia',
  'bloom', 'arrow', 'western', 'silicon', 'arch', 'hudl', 'sabre', 'saab', 'lennox', 'ramboll', 'corning', 'gartner',
]);

// Platforms people train on: "SAP trainer needed" is about the product, not the company.
const PRODUCT = new Set([
  'sap', 'saplabs', 'oracle', 'salesforce', 'microsoft', 'aws', 'amazon', 'amazonweb', 'servicenow', 'workday',
  'snowflake', 'databricks', 'informatica', 'mongodb', 'pegasystems', 'guidewire', 'adobe', 'google', 'cisco', 'redhat',
  'checkpoint', 'paloaltonetworks', 'blueyonder', 'ibm', 'autodesk', 'dassaultsystemes', 'ptc', 'siemens', 'confluent',
  'fortinet', 'zscaler', 'crowdstrike', 'junipernetworks', 'nutanix', 'commvault', 'teradata', 'cloudera', 'mathworks',
  'bentley', 'hexagon', 'aveva', 'altair', 'sprinklr', 'hubspot', 'zendesk', 'atlassian', 'manhattanassociates',
  'infor', 'koreai', 'celonis', 'avaya', 'meta', 'apple', 'dell', 'hp', 'hewlettpackardenterprise', 'vmware',
  'broadcom', 'netapp', 'citrix', 'unity', 'tableau', 'qualys', 'rapid7', 'cyberark', 'checkpointsoftware', 'datadog',
  'elastic', 'twilio', 'intel', 'nvidia', 'arm', 'cadence', 'synopsys', 'ansys', 'epicgames', 'rockwellautomation',
  'schneiderelectric', 'emerson', 'honeywell', 'abb', 'yardi', 'realpage', 'mri', 'mrisoftware', 'icertis', 'opentext',
  'ellucian', 'blackbaud', 'appliedmaterials', 'keysight', 'microchip', 'microchiptechnology', 'bmc', 'ivanti', 'trellix',
]);

// What follows a company's name when a post means its India centre.
const CENTRE_AFTER =
  /^[\s,.-]*(?:India|GCC|GBS|GSC|GDC|GCC's|Labs?|Global\s+(?:Capabilit|Business|Services?|Technology|Delivery|Solutions|Hub|Service\s+Cent)|Technology\s+Cent|Capability|Business\s+Services|Innovation\s+(?:Cent|Hub|Lab)|R&D|Research\s+(?:and|&)\s+Development|Development\s+Cent|Engineering\s+Cent|Shared\s+Services|(?:in|at)\s+(?:Bengaluru|Bangalore|Hyderabad|Chennai|Pune|Mumbai|Gurugram|Gurgaon|Noida|Kolkata|Coimbatore|Ahmedabad|Kochi|Delhi))/;

// What precedes a company's name when a post names the employer.
const EMPLOYER_BEFORE =
  /(?:\bat|@|\bclient(?:\s+is)?\s*[:-]?|\bcompany\s*[:-]|\borgani[sz]ation\s*[:-]|\bhiring\s+for|\bon\s+behalf\s+of|\bpartnering\s+with|\bfor\s+our\s+client)\s*$/i;

// "GCC" also means the Gulf; these say which one a post means.
const GULF = /\b(?:gulf|uae|dubai|abu\s+dhabi|saudi|ksa|qatar|doha|oman|kuwait|bahrain|middle\s+east|mena|riyadh|gcc\s+(?:countries|region|nations|states|markets?))\b/i;
const GCC_WORD = /\b(?:GCCs?|global\s+capabilit(?:y|ies)\s+cent(?:er|re)s?|captive\s+(?:cent(?:er|re)|unit)s?)\b/i;

// Words a company adds to its name for its India centre.
const CENTRE_WORDS = new Set([
  'technology', 'technologies', 'tech', 'services', 'service', 'solutions', 'global', 'labs', 'lab', 'development',
  'center', 'centre', 'centers', 'centres', 'software', 'systems', 'research', 'engineering', 'business', 'capability',
  'capabilities', 'gcc', 'gbs', 'gsc', 'gdc', 'international', 'digital', 'innovation', 'operations', 'shared',
  'support', 'delivery', 'hub', 'web', 'data', 'analytics', 'information', 'it', 'rd', 'bengaluru', 'bangalore',
  'hyderabad', 'chennai', 'pune', 'mumbai', 'gurugram', 'gurgaon', 'noida', 'kolkata', 'coimbatore', 'ahmedabad', 'kochi',
]);

/** A company name as tokens two sources would agree on. */
export function gccTokens(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !TAIL.has(w));
}

/** A company name reduced to one comparable string. */
export const gccKey = (name) => gccTokens(name).join('');

// The same words, run together, as a glued name leaves them.
const CENTRE_TAIL = new RegExp(`^(?:${[...CENTRE_WORDS].join('|')})+$`);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An index over the built-in list plus the user's own names. */
export function buildGccIndex(list = [], extra = []) {
  const entries = [
    ...(list || []).map((e) => ({ name: e.n || e.name, aliases: e.a || e.aliases || [], cities: e.c || e.cities || [], sector: e.s || e.sector || '' })),
    ...(extra || []).map((n) => String(n || '').trim()).filter(Boolean).map((name) => ({ name, aliases: [], cities: [], sector: '', mine: true })),
  ].filter((e) => e.name);

  const exact = new Map();
  const byFirst = new Map();
  const spellings = [];
  for (const entry of entries) {
    for (const spelling of [entry.name, ...entry.aliases]) {
      const tokens = gccTokens(spelling);
      const key = tokens.join('');
      if (!key) continue;
      if (!exact.has(key)) exact.set(key, entry);
      const common = !entry.mine && COMMON.has(key);
      if (!common) {
        const list = byFirst.get(tokens[0]) || [];
        list.push({ tokens, key, entry });
        byFirst.set(tokens[0], list);
      }
      const product = !entry.mine && PRODUCT.has(key);
      // A long, many-word name means the company wherever it appears; a short or common one needs its context.
      const free = !common && !product && tokens.length >= 2 && key.length >= 9;
      spellings.push({ text: spelling.trim(), entry, free, common, product });
    }
  }

  // Longest first, so "Wells Fargo India" wins over "Wells Fargo".
  spellings.sort((a, b) => b.text.length - a.text.length);
  const byText = new Map(spellings.map((s) => [s.text.toLowerCase(), s]));
  const pattern = spellings.length
    ? new RegExp(`(?<![\\p{L}\\p{N}&])(?:${[...byText.keys()].map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu')
    : null;

  return { entries, exact, byFirst, byText, pattern, size: entries.length };
}

/** The GCC a company field names, or null. */
export function gccForCompany(company, index) {
  const tokens = gccTokens(company);
  const key = tokens.join('');
  if (!key || !index) return null;
  if (index.exact.has(key)) return index.exact.get(key);
  // "Wells Fargo International Solutions" is Wells Fargo; "Oracle Dental Clinic" is not Oracle.
  let best = null;
  for (const candidate of index.byFirst.get(tokens[0]) || []) {
    const whole = candidate.tokens.every((t, i) => tokens[i] === t);
    const rest = tokens.slice(candidate.tokens.length);
    if (whole && rest.every((t) => CENTRE_WORDS.has(t)) && (!best || candidate.key.length > best.key.length)) best = candidate;
  }
  // "JP Morgan Services" is JPMorgan once the spaces go.
  if (!best && key.length >= 8) {
    for (const [k, entry] of index.exact) {
      if (k.length >= 8 && key !== k && key.startsWith(k) && !COMMON.has(k) && CENTRE_TAIL.test(key.slice(k.length))) return entry;
    }
  }
  return best ? best.entry : null;
}

/** The GCC a free-text passage names, only where the words around it say it is the company. */
export function gccInText(text, index) {
  const flat = String(text || '');
  if (!flat || !index || !index.pattern) return null;
  for (const m of flat.matchAll(index.pattern)) {
    const spelling = index.byText.get(m[0].toLowerCase());
    if (!spelling || spelling.common) continue;
    const exactCase = m[0] === spelling.text;
    const before = flat.slice(Math.max(0, m.index - 40), m.index);
    const after = flat.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const context = EMPLOYER_BEFORE.test(before) || CENTRE_AFTER.test(after);
    if (spelling.free && (exactCase || context)) return spelling.entry;
    if (!spelling.free && exactCase && context) return spelling.entry;
  }
  return null;
}

/** Whether a passage talks about a GCC without naming one — "for a leading GCC in Chennai". */
export function mentionsGcc(text) {
  const flat = String(text || '');
  return GCC_WORD.test(flat) && !GULF.test(flat);
}

/** Which GCC a lead comes from, and how that was decided. */
export function gccOf(record, index) {
  if (!record || !index) return null;
  const hit = (entry, via) => ({ name: entry.name, via, cities: entry.cities, sector: entry.sector, mine: Boolean(entry.mine) });

  // Where a company is named outright.
  const fields = [
    record.company,
    employerOf({ headline: record.headline }),
    employerOf({ headline: record.authorHeadline }),
    record.source === 'maps' || !record.source ? record.name : '',
  ];
  const business = record.source === 'maps' || !record.source;
  for (const [i, field] of fields.entries()) {
    const entry = field && gccForCompany(field, index);
    if (entry) return hit(entry, record.source === 'posts' ? 'author works there' : business && i === 3 ? 'the business is one' : 'works there');
  }
  // Where it is only written somewhere in the text.
  const passages = record.source === 'posts'
    ? [record.authorHeadline, record.text || record.summary]
    : [record.headline, record.summary, record.siteText];
  for (const passage of passages) {
    const entry = gccInText(passage, index);
    if (entry) return hit(entry, record.source === 'posts' ? 'named in the post' : 'named in the profile');
  }
  if (record.source === 'posts' && mentionsGcc(`${record.authorHeadline || ''} ${record.text || ''}`)) {
    return { name: '', via: 'a GCC, not named', cities: [], sector: '', mine: false };
  }
  return null;
}

/** gccOf bound to one index, remembering each record's answer. */
export function gccMatcher(index) {
  const seen = new WeakMap();
  return (record) => {
    if (!record || typeof record !== 'object') return null;
    if (!seen.has(record)) seen.set(record, gccOf(record, index));
    return seen.get(record);
  };
}

/** The matcher for the built-in list and the names the user added; never throws. */
export async function loadGccMatcher(storage = globalThis.chrome && chrome.storage && chrome.storage.local) {
  try {
    const [list, stored] = await Promise.all([loadGccList(), storage ? storage.get(GCC_EXTRA_KEY) : {}]);
    return gccMatcher(buildGccIndex(list, (stored && stored[GCC_EXTRA_KEY]) || []));
  } catch {
    return () => null;
  }
}

/** A GCC requirement post first, then any GCC lead, then the rest, each group in its own order. */
export function gccFirst(records, gccFor) {
  const rank = (r) => {
    const gcc = gccFor(r);
    if (!gcc) return 2;
    return r.source === 'posts' && r.intent && r.intent !== 'DEMAND' ? 1 : 0;
  };
  return (records || [])
    .map((record, i) => ({ record, i, rank: rank(record) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.record);
}

/** "Wells Fargo" or "GCC (unnamed)", for a badge or a column. */
export function gccLabel(gcc) {
  if (!gcc) return '';
  return gcc.name || 'GCC (unnamed)';
}

/** The user's list as the text box shows it. */
export function parseExtra(text) {
  return [...new Set(String(text || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Where the packaged list sits, whether or not there is an extension around. */
function assetUrl(path) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(path);
  return new URL(`../../${path}`, import.meta.url).href;
}

let listPromise = null;

/** The built-in list, read once. */
export function loadGccList() {
  if (!listPromise) {
    listPromise = fetch(assetUrl('src/data/gcc.json'))
      .then((res) => {
        if (!res.ok) throw new Error(`gcc.json returned HTTP ${res.status}`);
        return res.json();
      })
      .then((list) => {
        if (!Array.isArray(list)) throw new Error('gcc.json is not a list');
        return list;
      })
      .catch((err) => {
        listPromise = null;
        throw err;
      });
  }
  return listPromise;
}
