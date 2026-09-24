// People out of pages, and the same person out of many pages.
//
// Two rules carried over from landermixer and LeadMine:
// - Every claim keeps the page it came from and the date that page was seen.
// - What cannot be read off the page stays empty. A LinkedIn link whose anchor
//   says "LinkedIn" gives a profile, not a name, and no name is invented for it.
//
// Resolution is deliberately conservative, because a false merge (two trainers
// shown as one) is worse for outreach than a duplicate row. Strong keys merge
// on their own; a name only merges inside a block that shares an organisation,
// and an abbreviated name ("A. Sharma") only when exactly one full name fits.

import { registeredDomain } from "../cc-discover.mjs";

const ROLE_LOCAL =
  /^(info|contact|contactus|admin|sales|support|hello|hi|enquir(y|ies)|inquir(y|ies)|training|trainings|office|hr|careers?|jobs|team|mail|no-?reply|marketing|help|booking|bookings|events?|admissions?|accounts?|billing|webmaster|media|press|partners?|business|corporate|academy|learn(ing)?|courses?)$/;
const NOT_A_NAME =
  /\b(linkedin|profile|connect|follow|view|click|here|read|more|contact|email|website|twitter|facebook|instagram|youtube|home|about|team|trainer|trainers|speaker|speakers|company|page|us|our|the|and|of|for)\b/i;

export function linkedinSlug(url) {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}

export function isRoleEmail(email) {
  return ROLE_LOCAL.test(String(email).split("@")[0].toLowerCase());
}

// "Priya Raman", "Dr. K. Senthil Kumar": 2-5 words, letters, starting upper-case.
export function looksLikeName(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60 || NOT_A_NAME.test(t)) return false;
  const words = t.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "").split(" ");
  return words.length >= 2 && words.length <= 5 && words.every((w) => /^\p{Lu}[\p{L}.'-]*$/u.test(w));
}

export function nameParts(name) {
  const words = String(name)
    .replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, "")
    .toLowerCase()
    .replace(/[^\p{L}\s.]/gu, "")
    .split(/[\s.]+/)
    .filter(Boolean);
  return { words, full: words.filter((w) => w.length > 1), initials: words.map((w) => w[0]) };
}

// "firstname.lastname@" is a name hint; "priya@" or "pr@" is not.
function nameFromEmail(email) {
  const local = email.split("@")[0];
  const m = local.match(/^([a-z]{2,})[._]([a-z]{2,})$/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2][0].toUpperCase()}${m[2].slice(1)}` : "";
}

/**
 * Person candidates on one fetched page.
 * doc: { id, url, host, observedAt }, page: extractPage() output.
 * Returns [{ name, nameSource, linkedin, emails, phones, org, orgDomain, jobTitle, docId, claim, confidence }]
 */
export function peopleFromPage(doc, page) {
  const orgDomain = registeredDomain(doc.host);
  const orgName = page.entities.find((e) => e.type !== "Person" && e.type !== "Event" && e.type !== "Course")?.name ?? "";
  const out = [];

  // 1. schema.org Person: the most explicit statement a page can make.
  for (const p of page.entities.filter((e) => e.type === "Person")) {
    const li = p.sameAs.map(linkedinSlug).find(Boolean) ?? null;
    out.push({
      name: p.name,
      nameSource: "json-ld",
      linkedin: li,
      emails: p.email && !isRoleEmail(p.email) ? [p.email.toLowerCase()] : [],
      phones: p.telephone ? [p.telephone.replace(/[^\d+]/g, "")] : [],
      jobTitle: p.jobTitle,
      org: p.org || orgName,
      orgDomain,
      claim: `Named as a Person${p.jobTitle ? ` (${p.jobTitle})` : ""} in the page's structured data`,
      confidence: 0.9,
    });
  }

  // 2. A link to a LinkedIn profile. The anchor names the person only when it
  //    reads as a name; "LinkedIn" or an icon leaves the name empty.
  for (const l of page.links) {
    const slug = linkedinSlug(l.url);
    if (!slug || out.some((p) => p.linkedin === slug)) continue;
    const named = looksLikeName(l.text);
    out.push({
      name: named ? l.text.trim() : "",
      nameSource: named ? "anchor" : "",
      linkedin: slug,
      emails: [],
      phones: [],
      jobTitle: "",
      org: orgName,
      orgDomain,
      claim: `Page links to linkedin.com/in/${slug}${named ? ` as "${l.text.trim()}"` : ""}`,
      confidence: named ? 0.7 : 0.5,
    });
  }

  // 3. A personal email address (not info@, training@ …).
  for (const email of page.emails.filter((e) => !isRoleEmail(e))) {
    if (out.some((p) => p.emails.includes(email))) continue;
    const hint = nameFromEmail(email);
    out.push({
      name: hint,
      nameSource: hint ? "email" : "",
      linkedin: null,
      emails: [email],
      phones: [],
      jobTitle: "",
      org: orgName,
      orgDomain,
      claim: `Personal email ${email} published on the page`,
      confidence: 0.6,
    });
  }

  return out.map((p) => ({ ...p, docId: doc.id, url: doc.url, observedAt: doc.observedAt, via: doc.via }));
}

// ---------- resolution ----------
class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.p[i] !== i) i = this.p[i] = this.p[this.p[i]];
    return i;
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b);
  }
}

const fullNameKey = (name) => {
  const { full, words } = nameParts(name);
  // Needs two whole words; "A. Sharma" or "Abhishek S" are not full names.
  return full.length >= 2 && full.length === words.length ? [...full].sort().join(" ") : null;
};

// "A. Sharma" ~ "Abhishek Sharma"; "Abhishek S" ~ "Abhishek Sharma".
export function abbreviationFits(short, long) {
  const s = nameParts(short).words;
  const l = nameParts(long).words;
  if (s.length !== 2 || l.length < 2) return false;
  const [lf, ll] = [l[0], l[l.length - 1]];
  const [sf, sl] = s;
  const initialFirst = sf.length === 1 && sf === lf[0] && sl === ll;
  const initialLast = sl.length === 1 && sf === lf && sl === ll[0];
  return initialFirst || initialLast;
}

/**
 * Merge candidates into people. Returns [{ id, names[], linkedin[], emails[], phones[],
 * orgs[], jobTitles[], mentions[] }] where mentions are the candidates merged in.
 */
export function resolve(candidates) {
  const uf = new UnionFind(candidates.length);
  const firstByKey = new Map();
  const link = (key, i) => {
    if (!key) return;
    if (firstByKey.has(key)) uf.union(i, firstByKey.get(key));
    else firstByKey.set(key, i);
  };

  candidates.forEach((c, i) => {
    link(c.linkedin && `li:${c.linkedin}`, i);
    c.emails.forEach((e) => link(`em:${e}`, i));
    const nk = c.name && fullNameKey(c.name);
    // Blocking: a name is only a key inside one organisation's domain.
    if (nk && c.orgDomain) link(`nm:${nk}|${c.orgDomain}`, i);
  });

  // Abbreviated names, within an organisation block, only when unambiguous.
  const fullByOrg = new Map();
  candidates.forEach((c, i) => {
    if (c.name && fullNameKey(c.name) && c.orgDomain) {
      const list = fullByOrg.get(c.orgDomain) ?? [];
      list.push(i);
      fullByOrg.set(c.orgDomain, list);
    }
  });
  candidates.forEach((c, i) => {
    if (!c.name || fullNameKey(c.name) || !c.orgDomain) return;
    const fits = (fullByOrg.get(c.orgDomain) ?? []).filter((j) => abbreviationFits(c.name, candidates[j].name));
    const roots = new Set(fits.map((j) => uf.find(j)));
    if (roots.size === 1) uf.union(i, fits[0]);
  });

  const groups = new Map();
  candidates.forEach((c, i) => {
    const r = uf.find(i);
    groups.set(r, [...(groups.get(r) ?? []), c]);
  });
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  return [...groups.values()].map((ms) => {
    const names = uniq(ms.map((m) => m.name)).sort((a, b) => b.length - a.length);
    const linkedin = uniq(ms.map((m) => m.linkedin));
    const emails = uniq(ms.flatMap((m) => m.emails));
    // A stable id from the strongest key, so re-runs keep the same person_id.
    const anchor = linkedin[0] ? `li:${linkedin[0]}` : emails[0] ? `em:${emails[0]}` : `nm:${names[0]}|${ms[0].orgDomain}`;
    return {
      id: anchor,
      names,
      linkedin,
      emails,
      phones: uniq(ms.flatMap((m) => m.phones)),
      orgs: uniq(ms.map((m) => m.org)),
      orgDomains: uniq(ms.map((m) => m.orgDomain)),
      jobTitles: uniq(ms.map((m) => m.jobTitle)),
      mentions: ms,
    };
  });
}

/**
 * Does a resolved person match anyone in a baseline (a LeadMine export, or the
 * people found on the Google results themselves)? Same keys, same caution.
 */
// An organisation is known by its domain on the web and by its name in a
// LeadMine export ("Acme Learning Pvt Ltd"), so both are keys.
export const orgNameKey = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|llp|inc|llc|co|company|corp|corporation|solutions|technologies|services)\b\.?/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

function orgKeys(person) {
  return [...person.orgDomains, ...person.orgs.map(orgNameKey)].filter(Boolean);
}

export function inBaseline(person, baseline) {
  if (person.linkedin.some((s) => baseline.linkedin.has(s))) return true;
  if (person.emails.some((e) => baseline.emails.has(e))) return true;
  return person.names.some((n) => {
    const k = fullNameKey(n);
    return k && orgKeys(person).some((o) => baseline.nameOrg.has(`${k}|${o}`));
  });
}

export function baselineIndex(people) {
  const b = { linkedin: new Set(), emails: new Set(), nameOrg: new Set(), size: 0 };
  for (const p of people) {
    b.size++;
    p.linkedin.forEach((s) => b.linkedin.add(s));
    p.emails.forEach((e) => b.emails.add(e));
    for (const n of p.names) {
      const k = fullNameKey(n);
      if (k) orgKeys(p).forEach((o) => b.nameOrg.add(`${k}|${o}`));
    }
  }
  return b;
}
