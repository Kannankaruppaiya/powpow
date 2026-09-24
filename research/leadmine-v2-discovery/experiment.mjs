#!/usr/bin/env node
// The experiment: does expanding from Google's results find good leads that
// Google itself did not return?
//
//   Google (Serper) results for a query  ──┐  the baseline set
//   and/or --seed / --seeds sites         ──┤
//                                           ▼
//   lead-specific frontier: best-first, per-host politeness (lib/frontier.mjs)
//     each site, when first reached, is expanded from Common Crawl, Wayback,
//     its sitemap and (for seed companies) Certificate Transparency subdomains
//                                           ▼
//   fetch: a CC or Wayback capture if there is one, else the live page (robots.txt honoured)
//                                           ▼
//   extract (cc-discover.mjs) → person candidates with a claim, a page and a date (lib/resolve.mjs)
//                                           ▼
//   links scored and queued; the page's evidence raises its links' scores and its host's
//                                           ▼
//   resolve candidates into people → compare with the Google set and any --baseline export
//                                           ▼
//   <out>-report.md   X, Y, new, per-source yield, does the score predict evidence?
//   <out>-review.csv  every new person, for a human to mark relevant y/n
//   <out>-{documents,people,evidence,relationships}.jsonl
//
// Then label the review sheet and run:  node experiment.mjs --score <out>-review.csv
//
// Usage:
//   SERPER_API_KEY=... node experiment.mjs --query "QA automation corporate trainer Chennai" --out qa
//   node experiment.mjs --seeds websites.txt --baseline leadmine-web-export.csv --max-pages 200
//   node experiment.mjs --query "…" --sources cc,wayback        # no live fetching at all
//   node experiment.mjs --query "…" --weights proximity=1,relevance=0,entity=0,evidence=0,freshness=0,quality=0
//                                                               # breadth-first control run
// Standalone: no dependencies, Node 18+.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { extractPage, latestCrawls, normaliseSeed, registeredDomain, seedsFromFile, splitCsvLine } from "./cc-discover.mjs";
import { Frontier, ageDays, parseWeights } from "./lib/frontier.mjs";
import { baselineIndex, inBaseline, linkedinSlug, peopleFromPage, resolve } from "./lib/resolve.mjs";
import * as sources from "./lib/sources.mjs";

const ALL_SOURCES = ["cc", "wayback", "crt", "sitemap", "live"];
const HISTORICAL_DAYS = 365;

// ---------- the run, with every network call injected ----------
export async function runExperiment(opts, io) {
  const log = io.log ?? (() => {});
  const on = new Set(opts.sources ?? ALL_SOURCES);
  const queryTerms = String(opts.query ?? opts.terms ?? "")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !/^(and|the|for|with|site:.*)$/i.test(t));
  const frontier = new Frontier({
    queryTerms,
    weights: opts.weights,
    delayMs: opts.rateMs ?? 1000,
    maxPerHost: opts.perHost ?? 15,
    now: io.now,
  });

  // 1. The baseline: exactly the URLs Google returned.
  const googleUrls = new Set();
  if (opts.query) {
    for (const r of await io.googleResults(opts.query)) {
      const e = frontier.add(r.url, { via: "google", hop: 0, anchor: r.title });
      if (e) googleUrls.add(e.key);
    }
    log(`google: ${googleUrls.size} results`);
  }
  for (const host of opts.seeds ?? []) frontier.add(`https://${host}/`, { via: "seed", hop: 0 });

  const seedDomains = new Set([...frontier.urls.values()].map((e) => e.domain));
  const crawls = on.has("cc") ? await io.latestCrawls(opts.crawls ?? 2) : [];

  // 2. Expanding a site the first time the frontier reaches it.
  async function expandHost(entry) {
    const h = frontier.host(entry.domain);
    h.loaded = true;
    const at = { hop: entry.hop, parentEvidence: entry.parentEvidence, from: `site:${entry.domain}` };
    const tryLoad = async (name, fn) => {
      try {
        return await fn();
      } catch (e) {
        log(`  ${name} ${entry.domain}: ${e.message}`);
        return [];
      }
    };
    let added = 0;
    if (on.has("cc"))
      for (const c of await tryLoad("cc", () => io.ccCaptures(entry.domain, crawls, opts.perHost ?? 15)))
        added += !!frontier.add(c.url, { ...at, via: "cc", observedAt: c.observedAt, capture: c.capture });
    if (on.has("wayback"))
      for (const c of await tryLoad("wayback", () => io.waybackCaptures(entry.domain, opts.perHost ?? 15)))
        added += !!frontier.add(c.url, { ...at, via: "wayback", observedAt: c.observedAt, capture: c.capture });
    if (on.has("sitemap") && on.has("live"))
      for (const l of await tryLoad("sitemap", () => io.sitemapUrls(entry.domain)))
        added += !!frontier.add(l.url, { ...at, via: "sitemap", observedAt: l.lastmod });
    // Certificate Transparency only for the seed companies themselves: it finds
    // their other surfaces (academy.x.com), not new companies.
    if (on.has("crt") && seedDomains.has(entry.domain))
      for (const s of (await tryLoad("crt", () => io.crtSubdomains(entry.domain))).filter((s) => s.promising))
        added += !!frontier.add(`https://${s.host}/`, { ...at, via: "crt", anchor: s.host.split(".")[0] });
    log(`  expanded ${entry.domain}: +${added} urls`);
  }

  async function fetchEntry(e) {
    const errors = [];
    if (e.capture?.kind === "cc") {
      try {
        return { ...(await io.ccFetch(e.capture)), source: "cc" };
      } catch (err) {
        errors.push(`cc: ${err.message}`);
      }
    }
    if (e.capture?.kind === "wayback") {
      try {
        return { ...(await io.waybackFetch(e.capture)), source: "wayback" };
      } catch (err) {
        errors.push(`wayback: ${err.message}`);
      }
    }
    if (on.has("live")) {
      try {
        return { ...(await io.liveFetch(e.url)), source: "live" };
      } catch (err) {
        errors.push(`live: ${err.message}`);
      }
    } else if (!e.capture) errors.push("no capture, and live fetching is off");
    throw new Error(errors.join("; "));
  }

  // 3. Best-first crawl.
  const documents = [];
  const candidates = [];
  const relationships = [];
  const contentSeen = new Set();
  const failures = [];
  const maxPages = opts.maxPages ?? 300;
  while (documents.length < maxPages) {
    const { entry, wait } = frontier.next();
    if (!entry) {
      if (wait === null) break;
      await io.sleep(wait);
      continue;
    }
    if (!frontier.host(entry.domain).loaded && entry.hop <= (opts.hops ?? 2)) {
      await expandHost(entry);
      continue; // the expansion may have queued something better than this entry
    }

    const components = frontier.components(entry);
    let rec;
    try {
      rec = await fetchEntry(entry);
    } catch (err) {
      failures.push({ url: entry.url, via: entry.via, error: err.message });
      frontier.done(entry, { ok: false });
      continue;
    }

    const page = extractPage(rec.html, rec.url || entry.url);
    const hash = createHash("sha1").update(page.text).digest("hex").slice(0, 16);
    const observedAt = normaliseDate(rec.date ?? entry.observedAt);
    const age = ageDays(observedAt, io.now());
    const doc = {
      id: createHash("sha1").update(`${entry.url}|${observedAt}`).digest("hex").slice(0, 12),
      url: entry.url,
      host: new URL(entry.url).hostname,
      source: rec.source,
      via: entry.via,
      hop: entry.hop,
      from: entry.from ?? null,
      inGoogleSet: googleUrls.has(entry.key),
      observedAt,
      fetchedAt: new Date(io.now()).toISOString(),
      historical: rec.source === "wayback" || (age !== null && age > HISTORICAL_DAYS),
      contentHash: hash,
      duplicateContent: contentSeen.has(hash),
      title: page.title,
      kinds: page.kinds,
      predictedScore: +entry.score.toFixed(3),
      components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, +v.toFixed(3)])),
      text: page.text.slice(0, 20000),
    };
    contentSeen.add(hash);

    const people = doc.duplicateContent ? [] : peopleFromPage(doc, page);
    candidates.push(...people.map((p) => ({ ...p, historical: doc.historical, inGoogleSet: doc.inGoogleSet })));
    const text = page.text.toLowerCase();
    const relevant = queryTerms.length && queryTerms.some((t) => text.includes(t.toLowerCase()));
    doc.evidence = people.length + (relevant ? 1 : 0);
    doc.people = people.length;
    documents.push(doc);
    frontier.done(entry, { ok: true, evidence: doc.evidence });

    for (const l of page.links) {
      let domain;
      try {
        domain = registeredDomain(new URL(l.url).hostname);
      } catch {
        continue;
      }
      const external = domain !== entry.domain;
      const hop = entry.hop + (external ? 1 : 0);
      if (hop > (opts.hops ?? 2)) continue;
      if (external) {
        if (entry.hop === 0) frontier.noteSeedLink(domain, entry.domain);
        relationships.push({ source: `org:${entry.domain}`, relation: "LINKS_TO", target: `org:${domain}`, documentId: doc.id });
      }
      frontier.add(l.url, { via: "link", hop, anchor: l.text, parentTitle: page.title, parentEvidence: doc.evidence, from: entry.url });
    }
    log(`[${documents.length}/${maxPages}] ${entry.score.toFixed(2)} ${rec.source.padEnd(7)} ${entry.url}  people:${people.length}`);
  }

  // 4. Resolve, and compare with the baselines.
  const resolved = resolve(candidates);
  const external = opts.baseline ? baselineIndex(opts.baseline) : null;
  const docsById = new Map(documents.map((d) => [d.id, d]));
  const people = resolved.map((p) => {
    const inGoogle = p.mentions.some((m) => m.inGoogleSet);
    const inExternal = external ? inBaseline(p, external) : false;
    const dates = p.mentions.map((m) => m.observedAt).sort();
    return {
      person_id: p.id,
      names: p.names,
      profiles: p.linkedin.map((s) => `https://www.linkedin.com/in/${s}`),
      emails: p.emails,
      phones: p.phones,
      orgs: p.orgs,
      orgDomains: p.orgDomains,
      attributes: { jobTitles: p.jobTitles },
      firstSeen: dates[0],
      lastSeen: dates[dates.length - 1],
      historicalOnly: p.mentions.every((m) => m.historical),
      inGoogleSet: inGoogle,
      inBaseline: inExternal,
      isNew: !inGoogle && !inExternal,
      foundVia: [...new Set(p.mentions.map((m) => docsById.get(m.docId)?.via))],
      confidence: Math.max(...p.mentions.map((m) => m.confidence)),
      mentions: p.mentions,
    };
  });

  const evidence = [];
  for (const p of people) {
    for (const m of p.mentions) {
      evidence.push({
        person_id: p.person_id,
        document_id: m.docId,
        url: m.url,
        claim: m.claim,
        confidence: m.confidence,
        observed_at: m.observedAt,
        historical: m.historical,
      });
      relationships.push({ source: `person:${p.person_id}`, relation: "MENTIONED_IN", target: `doc:${m.docId}`, documentId: m.docId });
      if (m.orgDomain)
        relationships.push({ source: `person:${p.person_id}`, relation: "WORKS_AT", target: `org:${m.orgDomain}`, documentId: m.docId, confidence: m.nameSource === "json-ld" && m.org ? 0.8 : 0.4 });
      const kinds = docsById.get(m.docId)?.kinds ?? [];
      if (kinds.includes("speakers") || kinds.includes("events"))
        relationships.push({ source: `person:${p.person_id}`, relation: "SPEAKS_AT", target: `org:${m.orgDomain}`, documentId: m.docId, confidence: 0.5 });
      if (kinds.includes("trainers") && queryTerms.length)
        relationships.push({ source: `person:${p.person_id}`, relation: "TEACHES", target: `skill:${queryTerms.join(" ")}`, documentId: m.docId, confidence: 0.5 });
    }
    if (p.profiles.length) relationships.push({ source: `person:${p.person_id}`, relation: "PROFILE", target: p.profiles[0] });
  }

  return { documents, people, evidence, relationships, failures, frontier: frontier.stats(), googleResults: googleUrls.size, externalSize: external?.size ?? 0 };
}

function normaliseDate(d) {
  if (!d) return null;
  const s = String(d);
  if (/^\d{14}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

// ---------- measurement ----------
export function metrics(run) {
  const { people, documents } = run;
  const X = people.filter((p) => p.inGoogleSet).length;
  const newPeople = people.filter((p) => p.isNew);
  const bySource = {};
  for (const d of documents) {
    const s = (bySource[d.via] ??= { pages: 0, withPeople: 0, people: 0 });
    s.pages++;
    s.withPeople += d.people > 0 ? 1 : 0;
    s.people += d.people;
  }
  // Does the score predict evidence? Split fetched pages into score quintiles.
  const sorted = [...documents].sort((a, b) => b.predictedScore - a.predictedScore);
  const q = Math.max(1, Math.ceil(sorted.length / 5));
  const quintiles = [];
  for (let i = 0; i < sorted.length; i += q) {
    const slice = sorted.slice(i, i + q);
    quintiles.push({
      scores: `${slice[slice.length - 1].predictedScore.toFixed(2)}–${slice[0].predictedScore.toFixed(2)}`,
      pages: slice.length,
      withPeople: slice.filter((d) => d.people > 0).length,
      avgEvidence: +(slice.reduce((a, d) => a + d.evidence, 0) / slice.length).toFixed(2),
    });
  }
  return {
    X,
    Y: people.length,
    alsoInBaseline: people.filter((p) => p.inBaseline).length,
    newCount: newPeople.length,
    newWithProfileOrEmail: newPeople.filter((p) => p.profiles.length || p.emails.length).length,
    newHistoricalOnly: newPeople.filter((p) => p.historicalOnly).length,
    newByVia: newPeople.reduce((acc, p) => {
      for (const v of p.foundVia) acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {}),
    bySource,
    quintiles,
  };
}

export function reportMarkdown(run, m, opts) {
  const lines = [
    `# Experiment: ${opts.query ? `"${opts.query}"` : `${(opts.seeds ?? []).length} seed sites`}`,
    "",
    `Run ${new Date().toISOString().slice(0, 10)} · pages fetched ${run.documents.length} · failures ${run.failures.length} · sources ${[...(opts.sources ?? ALL_SOURCES)].join(", ")}`,
    "",
    "| Measure | Value | Meaning |",
    "|---|---|---|",
    `| Google results | ${run.googleResults} | URLs Serper returned for the query |`,
    `| **X** people in the Google set | ${m.X} | named on a page Google returned |`,
    `| **Y** people found in total | ${m.Y} | after resolving duplicates |`,
    `| Already in --baseline | ${m.alsoInBaseline} | of ${run.externalSize} rows in the export given |`,
    `| **New** people | ${m.newCount} | in neither the Google set nor the baseline, so Y − X is not the number |`,
    `| … with a LinkedIn profile or email | ${m.newWithProfileOrEmail} | contactable without more research |`,
    `| … seen only in old captures | ${m.newHistoricalOnly} | may have moved on; shown with their date, never as current |`,
    `| **Z** relevant new, **F** false-positive rate | — | fill \`relevant\` in the review sheet, then run \`--score\` |`,
    "",
    "## New people by how their page was reached",
    "",
    "| Reached via | New people |",
    "|---|---|",
    ...Object.entries(m.newByVia).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Yield per source",
    "",
    "| Via | Pages | Pages naming someone | Candidates |",
    "|---|---|---|---|",
    ...Object.entries(m.bySource).map(([k, s]) => `| ${k} | ${s.pages} | ${s.withPeople} | ${s.people} |`),
    "",
    "## Does the frontier's score predict evidence?",
    "",
    "Fetched pages split into fifths by the score they had *before* fetching. If the",
    "top fifth is not clearly richer than the bottom, the weights are not helping:",
    "compare against a breadth-first control run (see the header of experiment.mjs).",
    "",
    "| Score range | Pages | Naming someone | Avg evidence |",
    "|---|---|---|---|",
    ...m.quintiles.map((r) => `| ${r.scores} | ${r.pages} | ${r.withPeople} | ${r.avgEvidence} |`),
  ];
  return lines.join("\n") + "\n";
}

// ---------- files ----------
const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(" | ") : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

export const REVIEW_COLS = ["person_id", "name", "orgs", "job_title", "linkedin", "emails", "phones", "claims", "urls", "last_seen", "historical_only", "found_via", "relevant", "notes"];

export function reviewRows(people) {
  return people
    .filter((p) => p.isNew)
    .sort((a, b) => b.confidence - a.confidence)
    .map((p) => ({
      person_id: p.person_id,
      name: p.names[0] ?? "",
      orgs: p.orgs.length ? p.orgs : p.orgDomains,
      job_title: p.attributes.jobTitles,
      linkedin: p.profiles,
      emails: p.emails,
      phones: p.phones,
      claims: [...new Set(p.mentions.map((m) => m.claim))].slice(0, 3),
      urls: [...new Set(p.mentions.map((m) => m.url))].slice(0, 3),
      last_seen: p.lastSeen,
      historical_only: p.historicalOnly ? "y" : "n",
      found_via: p.foundVia,
      relevant: "",
      notes: "",
    }));
}

export function scoreReview(csvText) {
  const rows = csvText.split(/\r?\n/).filter(Boolean).map(splitCsvLine);
  const col = rows[0].indexOf("relevant");
  if (col === -1) throw new Error('no "relevant" column');
  const vals = rows.slice(1).map((r) => (r[col] ?? "").trim().toLowerCase());
  const yes = vals.filter((v) => /^(y|yes|1|true)$/.test(v)).length;
  const no = vals.filter((v) => /^(n|no|0|false)$/.test(v)).length;
  const labelled = yes + no;
  return {
    newPeople: vals.length,
    labelled,
    Z: yes,
    F: labelled ? +(no / labelled).toFixed(3) : null,
    // If only a sample was labelled, what the whole sheet probably holds.
    estimatedRelevant: labelled ? Math.round((yes / labelled) * vals.length) : null,
  };
}

// A LeadMine export (People / Public web / Posts) as baseline people.
export function baselineFromCsv(text) {
  const rows = text.split(/\r?\n/).filter(Boolean).map(splitCsvLine);
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...names) => head.findIndex((h) => names.includes(h));
  const c = { name: find("name", "author", "full name"), company: find("company", "orgs"), profile: find("profile url", "profileurl", "linkedin", "author url"), email: find("email", "emails") };
  return rows.slice(1).map((r) => ({
    names: c.name >= 0 && r[c.name] ? [r[c.name]] : [],
    linkedin: c.profile >= 0 ? [linkedinSlug(r[c.profile])].filter(Boolean) : [],
    emails: c.email >= 0 ? r[c.email].split(/[\s|;,]+/).filter((e) => e.includes("@")).map((e) => e.toLowerCase()) : [],
    orgs: c.company >= 0 && r[c.company] ? [r[c.company]] : [],
    orgDomains: [],
  }));
}

// ---------- CLI ----------
async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = args[i + 1];
    return v === undefined || v.startsWith("--") ? true : v;
  };

  const scoreFile = flag("score", "");
  if (scoreFile) {
    const s = scoreReview(readFileSync(String(scoreFile), "utf8"));
    console.log(
      `new people ${s.newPeople} · labelled ${s.labelled}\n` +
        `Z (relevant new) ${s.Z} · F (false-positive rate) ${s.F ?? "—"}` +
        (s.labelled && s.labelled < s.newPeople ? ` · estimated relevant across the sheet ${s.estimatedRelevant}` : ""),
    );
    return;
  }

  const seeds = [];
  if (flag("seed", "")) seeds.push(...String(flag("seed")).split(","));
  if (flag("seeds", "")) seeds.push(...seedsFromFile(readFileSync(String(flag("seeds")), "utf8"), String(flag("seeds"))));
  const opts = {
    query: flag("query", "") || undefined,
    seeds: [...new Set(seeds.map(normaliseSeed).filter(Boolean))],
    sources: String(flag("sources", ALL_SOURCES.join(","))).split(",").map((s) => s.trim()),
    weights: parseWeights(flag("weights", "")),
    maxPages: Number(flag("max-pages", 300)),
    perHost: Number(flag("per-host", 15)),
    hops: Number(flag("hops", 2)),
    crawls: Number(flag("crawls", 2)),
    rateMs: Number(flag("rate", 1000)),
    baseline: flag("baseline", "") ? baselineFromCsv(readFileSync(String(flag("baseline")), "utf8")) : null,
  };
  const bad = opts.sources.filter((s) => !ALL_SOURCES.includes(s));
  if (bad.length) throw new Error(`unknown source ${bad.join(", ")} (use ${ALL_SOURCES.join(", ")})`);
  if (!opts.query && !opts.seeds.length) throw new Error('Give --query "…" (needs SERPER_API_KEY) and/or --seed / --seeds.');
  const out = String(flag("out", "experiment"));

  const run = await runExperiment(opts, {
    ...sources,
    googleResults: (q) => sources.googleResults(q, Number(flag("google-pages", 2))),
    latestCrawls,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (s) => console.error(s),
  });
  const m = metrics(run);

  writeFileSync(`${out}-documents.jsonl`, jsonl(run.documents));
  writeFileSync(`${out}-people.jsonl`, jsonl(run.people.map(({ mentions, ...p }) => p)));
  writeFileSync(`${out}-evidence.jsonl`, jsonl(run.evidence));
  writeFileSync(`${out}-relationships.jsonl`, jsonl(run.relationships));
  writeFileSync(`${out}-failures.jsonl`, jsonl(run.failures));
  writeFileSync(`${out}-review.csv`, toCsv(reviewRows(run.people), REVIEW_COLS));
  writeFileSync(`${out}-report.md`, reportMarkdown(run, m, opts));
  console.error(
    `\nX ${m.X} in the Google set · Y ${m.Y} in total · ${m.newCount} new (${m.newWithProfileOrEmail} contactable)\n` +
      `  -> ${out}-report.md, ${out}-review.csv (mark "relevant", then --score it), ${out}-*.jsonl`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
