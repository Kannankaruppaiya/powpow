#!/usr/bin/env node
// Find LinkedIn posts from the last N days that express a given intent
// (default: someone needs a corporate trainer / has a training requirement).
//
// Pipeline: search engines (Google via Serper, Exa) -> extract post ID ->
// decode the exact publish time from the ID -> drop anything older than N days
// -> classify intent (DEMAND / SUPPLY / RECAP) -> dedupe -> CSV.
//
// Usage:
//   SERPER_API_KEY=... EXA_API_KEY=... node find-posts.mjs --days 10 --out leads.csv
//   node find-posts.mjs --days 7 --topic "SAP"        # narrow to one technology
//   node find-posts.mjs --print-queries               # just print Google queries/URLs
//   node find-posts.mjs --input urls.txt              # re-check URLs you collected by hand
//
// Standalone: no dependencies, Node 18+. Not wired into the PowPow gateway.

import { readFileSync, writeFileSync } from "node:fs";

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const DAYS = Number(flag("days", 10));
const OUT = flag("out", "linkedin-recent-posts.csv");
const TOPIC = flag("topic", "");
const INPUT = flag("input", "");
const PAGES = Number(flag("pages", 3)); // Serper pages per query (10 results each)
const KEEP_ALL = Boolean(flag("keep-all", false)); // keep SUPPLY/RECAP rows too
const NOW = Date.now();

// ---------- 1. post ID -> exact timestamp ----------
// LinkedIn IDs are 64-bit "snowflake" style: top 41 bits = ms since Unix epoch.
// Works for activity, share and ugcPost IDs; activity ID matches the shown time.
const ID_RE = /(?:activity|ugcPost|share)(?:%3A|:|-)(\d{18,20})/i;

export function postIdFromUrl(url) {
  const m = decodeURIComponent(url).match(ID_RE);
  return m ? m[1] : null;
}

export function postTimeFromId(id) {
  const ms = Number(BigInt(id) >> 22n);
  // Sanity window: LinkedIn snowflake IDs started ~2014; reject garbage.
  return ms > Date.UTC(2014, 0, 1) && ms < NOW + 86_400_000 ? new Date(ms) : null;
}

export function canonicalUrl(id) {
  return `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
}

// ---------- 2. queries ----------
// Google caps a query at 32 words, so intents are split into small OR groups.
const SITES = "(site:linkedin.com/posts OR site:linkedin.com/feed/update)";
const INTENT_GROUPS = [
  ['"trainer required"', '"trainer requirement"', '"training requirement"', '"trainers required"'],
  ['"looking for a trainer"', '"looking for trainers"', '"looking for a corporate trainer"', '"looking for freelance trainers"'],
  ['"need a trainer"', '"urgent requirement" trainer', '"immediate requirement" trainer', '"freelance trainer" required'],
  ['"corporate training" requirement', '"corporate trainer" needed', '"interested trainers"', '"share your profile" trainer'],
];
const NEGATIVE = '-"#opentowork" -"I am available" -"my training services"';

export function buildQueries({ topic = TOPIC, days = DAYS } = {}) {
  const after = new Date(NOW - days * 86_400_000).toISOString().slice(0, 10);
  return INTENT_GROUPS.map((g) => ({
    q: `${SITES} (${g.join(" OR ")})${topic ? ` "${topic}"` : ""} ${NEGATIVE}`,
    after,
  }));
}

// Custom date range tbs (Google expects M/D/YYYY). qdr:dN also works but cdr is explicit.
function tbsRange(days) {
  const d = (t) => {
    const x = new Date(t);
    return `${x.getUTCMonth() + 1}/${x.getUTCDate()}/${x.getUTCFullYear()}`;
  };
  return `cdr:1,cd_min:${d(NOW - days * 86_400_000)},cd_max:${d(NOW)}`;
}

export function googleUrl(q, days = DAYS) {
  const u = new URL("https://www.google.com/search");
  u.searchParams.set("q", q);
  u.searchParams.set("tbs", `${tbsRange(days)},sbd:1`); // sbd:1 = sort by date
  u.searchParams.set("filter", "0"); // don't collapse "similar" results
  return u.toString();
}

export function linkedinNativeUrl(keywords) {
  // LinkedIn's own post search: the most complete source for the last 7 days
  // (needs a logged-in browser; use it manually or through a compliant provider).
  const u = new URL("https://www.linkedin.com/search/results/content/");
  u.searchParams.set("keywords", keywords);
  u.searchParams.set("datePosted", '"past-week"');
  u.searchParams.set("sortBy", '"date_posted"');
  return u.toString();
}

// ---------- 3. providers ----------
async function serper(q, days) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];
  const out = [];
  for (let page = 1; page <= PAGES; page++) {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, tbs: `qdr:d${days}`, num: 10, page }),
    });
    if (!res.ok) {
      console.error(`serper ${res.status}: ${await res.text()}`);
      break;
    }
    const data = await res.json();
    const items = data.organic ?? [];
    for (const r of items) out.push({ url: r.link, title: r.title, text: r.snippet ?? "", source: "google" });
    if (items.length < 10) break;
  }
  return out;
}

async function exa(query, days) {
  const key = process.env.EXA_API_KEY;
  if (!key) return [];
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      numResults: 100,
      includeDomains: ["linkedin.com"],
      startPublishedDate: new Date(NOW - days * 86_400_000).toISOString(),
      contents: { text: { maxCharacters: 2000 } },
    }),
  });
  if (!res.ok) {
    console.error(`exa ${res.status}: ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return (data.results ?? []).map((r) => ({ url: r.url, title: r.title ?? "", text: r.text ?? "", source: "exa" }));
}

// Exa is semantic: describe the post instead of listing keywords.
const EXA_QUERIES = [
  "LinkedIn post by a company or HR person saying they urgently need a corporate trainer for a training program",
  "LinkedIn post announcing a freelance trainer requirement with location, duration, start date and commercials",
  "LinkedIn post: we are looking for an experienced trainer to deliver corporate training for our client, share your profile",
];

// ---------- 4. intent classification ----------
const DEMAND = [
  /\blooking for\b.{0,40}\btrainers?\b/i, /\btrainers?\b.{0,20}\b(required|requirement|needed|wanted)\b/i,
  /\btraining requirement\b/i, /\b(urgent|immediate)(ly)? (requirement|hiring|need)\b/i,
  /\bneed(ed)? an? .{0,30}trainer\b/i, /\binterested trainers\b/i, /\bshare (your|updated) (profile|cv)\b/i,
  /\bcommercials?\b/i, /\bfreelance (trainer|corporate trainer)s?\b/i, /\bwe are hiring\b.{0,40}trainer/i,
];
const SUPPLY = [
  /#opentowork/i, /\bI am (a|an) .{0,30}trainer\b/i, /\bI'?m available\b/i, /\bavailable for (corporate )?training/i,
  /\bmy (training )?services\b/i, /\breach out to me for\b/i,
];
const RECAP = [
  /\b(successfully )?(conducted|delivered|completed|wrapped up)\b.{0,40}\b(session|training|workshop|program)/i,
  /\bthank(s| you) .{0,40}for the opportunity\b/i, /\bgrateful\b/i,
];

export function classify(text) {
  const hits = (list) => list.filter((re) => re.test(text)).length;
  const d = hits(DEMAND), s = hits(SUPPLY), r = hits(RECAP);
  if (d === 0) return { intent: r > s ? "RECAP" : s ? "SUPPLY" : "OTHER", score: 0 };
  if (d <= s || d <= r) return { intent: s >= r ? "SUPPLY" : "RECAP", score: d };
  return { intent: "DEMAND", score: d };
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?:\+?\d[\d\s-]{8,}\d)/g;

// ---------- 5. pipeline ----------
export function processResults(raw, days = DAYS) {
  const cutoff = NOW - days * 86_400_000;
  const byId = new Map();
  let noId = 0, tooOld = 0;
  for (const r of raw) {
    const id = postIdFromUrl(r.url);
    if (!id) { noId++; continue; }
    const at = postTimeFromId(id);
    if (!at || at.getTime() < cutoff) { tooOld++; continue; }
    const prev = byId.get(id);
    const text = `${r.title} ${r.text}`;
    if (prev) {
      if (text.length > prev.text.length) prev.text = text;
      prev.sources.add(r.source);
      continue;
    }
    byId.set(id, { id, at, url: r.url, title: r.title, text, sources: new Set([r.source]) });
  }
  const rows = [...byId.values()].map((p) => {
    const { intent, score } = classify(p.text);
    // Titles look like "Headline | Author · LinkedIn" (or "... - LinkedIn").
    const author = p.title.includes("|") ? p.title.split("|").pop().replace(/\s*[·-]\s*LinkedIn.*$/i, "") : "";
    return {
      posted_at: p.at.toISOString(),
      age_days: ((NOW - p.at.getTime()) / 86_400_000).toFixed(1),
      intent, score, author: author.trim(),
      emails: [...new Set(p.text.match(EMAIL_RE) ?? [])].join(" "),
      phones: [...new Set((p.text.match(PHONE_RE) ?? []).map((x) => x.trim()))].join(" "),
      url: canonicalUrl(p.id), original_url: p.url,
      sources: [...p.sources].join("+"),
      snippet: p.text.replace(/\s+/g, " ").slice(0, 400),
    };
  });
  rows.sort((a, b) => b.posted_at.localeCompare(a.posted_at));
  return { rows, stats: { input: raw.length, noId, tooOld, unique: rows.length } };
}

function toCsv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

async function main() {
  const queries = buildQueries();

  if (flag("print-queries", false)) {
    for (const { q, after } of queries) {
      console.log(`\nGoogle query:\n  ${q} after:${after}\nOpen:\n  ${googleUrl(q)}`);
    }
    console.log(`\nLinkedIn native (past week, latest first):\n  ${linkedinNativeUrl(`"trainer required" ${TOPIC}`.trim())}`);
    return;
  }

  let raw = [];
  if (INPUT) {
    raw = readFileSync(INPUT, "utf8").split(/\s+/).filter(Boolean).map((url) => ({ url, title: "", text: "", source: "manual" }));
  } else {
    if (!process.env.SERPER_API_KEY && !process.env.EXA_API_KEY) {
      console.error("Set SERPER_API_KEY and/or EXA_API_KEY (or use --input / --print-queries).");
      process.exit(1);
    }
    // Ask engines for a slightly wider window; the ID decode does the exact cut.
    const window = DAYS + 5;
    const jobs = [
      ...queries.map(({ q }) => serper(q, window)),
      ...EXA_QUERIES.map((q) => exa(TOPIC ? `${q} for ${TOPIC}` : q, window)),
    ];
    raw = (await Promise.all(jobs)).flat();
  }

  const { rows, stats } = processResults(raw);
  const kept = KEEP_ALL || INPUT ? rows : rows.filter((r) => r.intent === "DEMAND");
  writeFileSync(OUT, toCsv(kept));
  console.log(
    `raw=${stats.input} no-post-id=${stats.noId} older-than-${DAYS}d=${stats.tooOld} ` +
      `unique=${stats.unique} kept=${kept.length} -> ${OUT}`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
