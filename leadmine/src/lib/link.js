/**
 * The business and the people who work there, joined.
 *
 * A Maps run finds "Acme Dental Care" with a phone and an info@ address. A
 * LinkedIn run finds "Dr. Priya — Founder at Acme Dental Care". They are the
 * same lead — the business and the person who decides for it — and they were
 * two rows in two files that nobody joined.
 *
 * Two keys, best first, the way OpenOutFind keys a company:
 *   1. the website domain, when both sides have one (a person's company page
 *      or a profile's employer link rarely carries it, but a business found
 *      from a person's post sometimes does);
 *   2. the company name, normalised hard — case, punctuation, and the legal
 *      and filler words ("Pvt Ltd", "Private Limited", "Inc", "The") that two
 *      sources write differently for one company.
 *
 * A name that normalises to too little ("A2", "The Clinic") is not linked:
 * a wrong join puts a stranger's phone on a person's row, which is worse
 * than no join.
 */

import { domainOf } from './crm.js';

const FILLER = new Set([
  'the', 'pvt', 'private', 'ltd', 'limited', 'llp', 'llc', 'inc', 'incorporated', 'co', 'company',
  'corp', 'corporation', 'plc', 'gmbh', 'pte', 'sa', 'srl', 'bv', 'and', 'of', 'india', 'group',
]);

/** A company name reduced to what two sources would agree on. */
export function companyKey(name) {
  const words = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w));
  const key = words.join('');
  // Too short to be a name rather than a coincidence.
  return key.length >= 5 ? key : '';
}

/** The employer a person's row names, from the company field or the headline. */
export function employerOf(person) {
  if (!person) return '';
  if (person.company) return person.company;
  const m = String(person.headline || '').match(/\bat\s+(.+?)(?:\s*[|·•,-]\s|$)/i);
  return m ? m[1].trim() : '';
}

const isPerson = (r) => r && (r.source === 'linkedin' || r.source === 'web');
const isBusiness = (r) => r && (!r.source || r.source === 'maps');

/**
 * Join people to businesses across every run.
 *
 * Returns { personToBusiness: Map<personKey, business>,
 *           businessToPeople: Map<businessKey, person[]> }.
 * A person joins at most one business; a name two businesses share (a chain,
 * a franchise) joins neither, since there is no telling which branch.
 */
export function linkRecords(records) {
  const byDomain = new Map();
  const byName = new Map();
  const ambiguous = new Set();

  for (const business of records || []) {
    if (!isBusiness(business)) continue;
    const domain = domainOf(business.website);
    if (domain && !byDomain.has(domain)) byDomain.set(domain, business);
    const key = companyKey(business.name);
    if (!key) continue;
    if (byName.has(key) && byName.get(key).key !== business.key) ambiguous.add(key);
    else byName.set(key, business);
  }

  const personToBusiness = new Map();
  const businessToPeople = new Map();
  for (const person of records || []) {
    if (!isPerson(person)) continue;
    let business = null;
    const site = domainOf(person.companyWebsite || '');
    if (site && byDomain.has(site)) business = byDomain.get(site);
    if (!business) {
      const key = companyKey(employerOf(person));
      if (key && !ambiguous.has(key)) business = byName.get(key) || null;
    }
    if (!business) continue;
    personToBusiness.set(person.key, business);
    if (!businessToPeople.has(business.key)) businessToPeople.set(business.key, []);
    businessToPeople.get(business.key).push(person);
  }
  return { personToBusiness, businessToPeople };
}

/** "Priya Raman (Founder at Acme); Arjun (HR Head)" — the people column. */
export function peopleSummary(people) {
  return (people || [])
    .slice(0, 5)
    .map((p) => `${p.name}${p.headline ? ` (${String(p.headline).slice(0, 60)})` : ''}`)
    .join('; ');
}
