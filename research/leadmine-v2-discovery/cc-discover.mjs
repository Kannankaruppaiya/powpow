#!/usr/bin/env node
// Discover lead evidence on the open web through Common Crawl, without
// touching the live sites and without a search engine being the only source.
//
// Pipeline: seed hosts (given, or from a Google query via Serper)
//   -> Common Crawl URL index (CDX): every capture Common Crawl holds for each host
//   -> pick the pages most likely to name people (about / team / trainers / speakers / contact)
//   -> fetch just those WARC records with an HTTP byte-range request
//   -> extract: title, emails, phones, LinkedIn profile links, schema.org Person/Organization
//   -> count the outside hosts those pages link to  ->  frontier of new hosts
//   -> optionally repeat one hop on the frontier (--hops 1)
//   -> <out>-pages.csv, <out>-pages.jsonl (full evidence), <out>-frontier.csv
//
// Usage:
//   node cc-discover.mjs --seed example-training.in,another-trainer.com
//   node cc-discover.mjs --seeds hosts.txt --hops 1 --out qa-trainers
//   node cc-discover.mjs --seeds leadmine-maps-export.csv   # the Website column of a LeadMine export
//   SERPER_API_KEY=... node cc-discover.mjs --query "QA automation corporate trainer India"
//   node cc-discover.mjs --seed example.com --print-plan    # show the index queries, fetch nothing
//   node cc-discover.mjs --selftest                         # offline checks, no network
//
// Standalone: no dependencies, Node 18+. Not wired into the PowPow gateway or
// the LeadMine extension. Read README.md in this folder before relying on it.

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

// ---------- args ----------
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const CRAWLS = Number(flag("crawls", 2)); // newest N monthly crawls to look in
const PAGES = Number(flag("pages", 12)); // WARC records fetched per host
const HOPS = Number(flag("hops", 0)); // 1 = also visit the best frontier hosts
const HOP_HOSTS = Number(flag("hop-hosts", 10)); // how many frontier hosts a hop visits
const RATE_MS = Number(flag("rate", 1000)); // delay between requests to Common Crawl
const OUT = flag("out", "cc-discover");
const TERMS = String(flag("terms", "trainer,training,corporate,workshop,speaker,consultant,faculty"))
  .split(",")
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

const INDEX = "https://index.commoncrawl.org";
const DATA = "https://data.commoncrawl.org";
const UA = "leadmine-research/0.1 (cc-discover.mjs; polite, serial)";

// Hosts that are platforms, not leads. Crawling deeper into them through
// Common Crawl is pointless (or, for LinkedIn, empty: its robots.txt shuts
// CCBot out). A LinkedIn link found on a page is still recorded, as evidence.
const PLATFORMS = new Set([
  "linkedin.com", "facebook.com", "instagram.com", "youtube.com", "youtu.be", "x.com",
  "twitter.com", "wikipedia.org", "quora.com", "reddit.com", "medium.com", "google.com",
  "goo.gl", "bit.ly", "whatsapp.com", "wa.me", "t.me", "pinterest.com", "github.com",
  "apple.com", "microsoft.com", "wordpress.org", "wordpress.com", "wix.com", "gstatic.com",
  "googleapis.com", "cloudflare.com", "w3.org", "schema.org", "gravatar.com",
]);

// Paths that tend to name people. Scored, not required: the homepage is always kept.
const PAGE_KINDS = [
  ["trainers", /\b(trainers?|instructors?|faculty|mentors?|coach(es)?)\b/],
  ["speakers", /\b(speakers?|keynote|panel(ists)?)\b/],
  ["team", /\b(team|people|leadership|founders?|our-?team|who-?we-?are)\b/],
  ["about", /\b(about(-?us)?|profile|bio(graphy)?)\b/],
  ["contact", /\b(contact(-?us)?|reach-?us)\b/],
  ["training", /\b(corporate-?training|courses?|workshops?|programs?|services?)\b/],
  ["events", /\b(events?|conferences?|summit|meetups?|webinars?)\b/],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. hosts and domains ----------
// Registered domain without the Public Suffix List: good enough for grouping
// "www.x.co.in" and "blog.x.co.in" under "x.co.in". Wrong for rare suffixes.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "gen", "firm", "ind", "res"]);

export function registeredDomain(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const [sld, tld] = labels.slice(-2);
  const n = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-n).join(".");
}

export function isPlatform(host) {
  const d = registeredDomain(host);
  return PLATFORMS.has(d) || /^google\./.test(d);
}

export function normaliseSeed(s) {
  const t = String(s).trim();
  if (!t || t.startsWith("#")) return null;
  try {
    return new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// A plain list is one host or URL per line. A LeadMine export is a CSV whose
// "Website" column holds each business's own site: the seeds a Maps run
// already paid for.
export function seedsFromFile(text, name) {
  if (!/\.csv$/i.test(name)) return text.split("\n");
  const rows = text.split(/\r?\n/).map(splitCsvLine);
  const col = rows[0].findIndex((h) => /^website$/i.test(h.trim()));
  if (col === -1) throw new Error(`${name}: no "Website" column`);
  return rows.slice(1).map((r) => r[col] ?? "");
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") out.push(cur), (cur = "");
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------- 2. Common Crawl index ----------
async function getWithRetry(url, init = {}, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) } });
    // The index answers "no captures" with 404; that is an answer, not a failure.
    if (res.ok || res.status === 404 || res.status === 206) return res;
    if (![429, 500, 502, 503, 504].includes(res.status)) return res;
    const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * 2 ** i;
    console.error(`  ${res.status} from ${new URL(url).host}, retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  throw new Error(`gave up after ${tries} tries: ${url}`);
}

async function latestCrawls(n) {
  const res = await getWithRetry(`${INDEX}/collinfo.json`);
  if (!res.ok) throw new Error(`collinfo.json: ${res.status}`);
  return (await res.json()).slice(0, n).map((c) => c.id);
}

export function cdxUrl(crawl, host) {
  // matchType=domain covers the host and every subdomain of it.
  return `${INDEX}/${crawl}-index?url=${encodeURIComponent(host)}&matchType=domain&output=json&limit=2000`;
}

export function parseCdx(text) {
  return text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function pageKinds(url, title = "") {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname).toLowerCase().replace(/[_/.]+/g, " ");
  } catch {
    path = "";
  }
  const hay = `${path} ${String(title).toLowerCase()}`;
  return PAGE_KINDS.filter(([, re]) => re.test(hay)).map(([k]) => k);
}

// From every capture of a host, keep one per URL (the newest), HTML only,
// status 200 only, and rank by how likely the page is to name people.
export function pickCaptures(captures, max) {
  const byUrl = new Map();
  for (const c of captures) {
    if (String(c.status) !== "200") continue;
    const mime = c["mime-detected"] || c.mime || "";
    if (!/html/.test(mime)) continue;
    const key = String(c.url).replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
    const prev = byUrl.get(key);
    if (!prev || c.timestamp > prev.timestamp) byUrl.set(key, c);
  }
  const scored = [...byUrl.values()].map((c) => {
    let path = "/";
    try {
      path = new URL(c.url).pathname;
    } catch {}
    const kinds = pageKinds(c.url);
    const home = path === "/" || path === "";
    const depth = path.split("/").filter(Boolean).length;
    return { c, score: (home ? 100 : 0) + kinds.length * 10 - depth };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.c);
}

// ---------- 3. WARC records ----------
async function fetchRecord(c) {
  const start = Number(c.offset);
  const end = start + Number(c.length) - 1;
  const res = await getWithRetry(`${DATA}/${c.filename}`, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206 && res.status !== 200) throw new Error(`WARC ${res.status}`);
  // Each WARC record is its own gzip member, so the slice decompresses alone.
  return gunzipSync(Buffer.from(await res.arrayBuffer()));
}

function splitHeaders(buf, from) {
  const end = buf.indexOf("\r\n\r\n", from);
  if (end === -1) return null;
  const lines = buf.subarray(from, end).toString("latin1").split("\r\n");
  const headers = {};
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { first: lines[0], headers, next: end + 4 };
}

export function parseWarcRecord(buf) {
  const warc = splitHeaders(buf, 0);
  if (!warc || !/^WARC\//.test(warc.first)) throw new Error("not a WARC record");
  const http = splitHeaders(buf, warc.next);
  if (!http) throw new Error("no HTTP headers in record");
  const blockEnd = warc.next + Number(warc.headers["content-length"] ?? buf.length);
  const body = buf.subarray(http.next, Math.min(blockEnd, buf.length));
  // Common Crawl stores the payload already decoded and renames the original
  // encoding headers to X-Crawler-*, so the body here is plain bytes.
  const ctype = http.headers["content-type"] ?? "";
  const head = body.subarray(0, 2048).toString("latin1");
  const charset =
    (ctype.match(/charset=["']?([\w-]+)/i) ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i) ?? [])[1] ?? "utf-8";
  let html;
  try {
    html = new TextDecoder(charset.toLowerCase()).decode(body);
  } catch {
    html = new TextDecoder("utf-8").decode(body);
  }
  return {
    url: warc.headers["warc-target-uri"],
    date: warc.headers["warc-date"],
    status: Number(http.first.split(" ")[1]),
    html,
  };
}

// ---------- 4. extraction ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#64": "@" };
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
    return m;
  });

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|domain|email|sentry|wixpress)\.|^[0-9a-f]{16,}@/i;
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(in|company)\/[^\s"'<>?#/]+/gi;
const PHONE_RE = /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b|\+\d{1,3}[\s-]\d[\d\s-]{7,13}\d/g;

function uniq(xs) {
  return [...new Set(xs)];
}

function jsonLdEntities(html) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const types = [].concat(node["@type"] ?? []).map(String);
    const wanted = types.find((t) =>
      /^(Person|Organization|LocalBusiness|EducationalOrganization|Corporation|ProfessionalService|Event|Course)$/.test(t),
    );
    if (wanted && node.name) {
      const org = node.worksFor ?? node.organizer ?? node.provider;
      out.push({
        type: wanted,
        name: String(node.name).trim(),
        jobTitle: node.jobTitle ? String(node.jobTitle) : "",
        org: org ? String([].concat(org)[0]?.name ?? "") : "",
        email: node.email ? String(node.email).replace(/^mailto:/i, "") : "",
        telephone: node.telephone ? String(node.telephone) : "",
        sameAs: [].concat(node.sameAs ?? []).map(String),
      });
    }
    for (const [k, v] of Object.entries(node)) if (k !== "@context") walk(v);
  };
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch {
      // Hand-written JSON-LD is often invalid; one bad block must not cost the page.
    }
  }
  return out;
}

export function extractPage(html, pageUrl) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const description = decodeEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] ?? "",
  ).trim();
  const text = htmlToText(html);
  const pageHost = (() => {
    try {
      return new URL(pageUrl).hostname;
    } catch {
      return "";
    }
  })();

  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => decodeEntities(m[1]));
  const mailtos = hrefs.filter((h) => /^mailto:/i.test(h)).map((h) => h.slice(7).split("?")[0]);
  const tels = hrefs.filter((h) => /^tel:/i.test(h)).map((h) => h.slice(4).replace(/[^\d+]/g, ""));
  const outHosts = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h, pageUrl);
      if (!/^https?:$/.test(u.protocol)) continue;
      if (registeredDomain(u.hostname) === registeredDomain(pageHost)) continue;
      outHosts.push(u.hostname.replace(/^www\./, ""));
    } catch {}
  }

  const emails = uniq([...mailtos, ...(text.match(EMAIL_RE) ?? []), ...(html.match(EMAIL_RE) ?? [])])
    .map((e) => decodeURIComponent(e).toLowerCase().trim())
    .filter((e) => e.includes("@") && !JUNK_EMAIL.test(e));
  const phones = uniq([...tels, ...(text.match(PHONE_RE) ?? []).map((p) => p.replace(/[\s-]/g, ""))]).filter(
    (p) => p.replace(/\D/g, "").length >= 10,
  );
  const linkedin = uniq((html.match(LINKEDIN_RE) ?? []).map((u) => u.replace(/^http:/, "https:").replace(/\/+$/, "")));
  const entities = jsonLdEntities(html);
  const lower = text.toLowerCase();
  const termHits = Object.fromEntries(TERMS.map((t) => [t, lower.split(t).length - 1]).filter(([, n]) => n > 0));

  return {
    title,
    description,
    kinds: pageKinds(pageUrl, title),
    emails: uniq(emails),
    phones,
    linkedin,
    entities,
    termHits,
    outHosts: uniq(outHosts),
    text,
  };
}

// ---------- 5. frontier ----------
// A host is worth visiting next when several different seed hosts link to it:
// one link is a footer badge, three independent ones is a neighbourhood.
export function buildFrontier(pages, seen) {
  const by = new Map();
  for (const p of pages) {
    const from = registeredDomain(p.host);
    for (const h of p.outHosts) {
      const d = registeredDomain(h);
      if (seen.has(d) || isPlatform(h)) continue;
      const e = by.get(d) ?? { domain: d, fromHosts: new Set(), links: 0, example: p.url };
      e.fromHosts.add(from);
      e.links++;
      by.set(d, e);
    }
  }
  return [...by.values()]
    .map((e) => ({ domain: e.domain, linkedFromHosts: e.fromHosts.size, links: e.links, example: e.example }))
    .sort((a, b) => b.linkedFromHosts - a.linkedFromHosts || b.links - a.links);
}

// ---------- 6. seeds from a search engine ----------
async function serperSeeds(q) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("--query needs SERPER_API_KEY (Google results via serper.dev)");
  const hosts = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, num: 10, page }),
    });
    if (!res.ok) throw new Error(`serper ${res.status}: ${await res.text()}`);
    const items = (await res.json()).organic ?? [];
    for (const r of items) {
      const h = normaliseSeed(r.link);
      if (h && !isPlatform(h)) hosts.push(h);
    }
    if (items.length < 10) break;
  }
  return uniq(hosts);
}

// ---------- 7. run ----------
async function visitHost(host, crawls) {
  const captures = [];
  for (const crawl of crawls) {
    const res = await getWithRetry(cdxUrl(crawl, host));
    await sleep(RATE_MS);
    if (res.status === 404) continue;
    if (!res.ok) {
      console.error(`  index ${crawl} ${host}: ${res.status}`);
      continue;
    }
    captures.push(...parseCdx(await res.text()));
  }
  const picked = pickCaptures(captures, PAGES);
  console.error(`  ${host}: ${captures.length} captures, reading ${picked.length} pages`);
  const pages = [];
  for (const c of picked) {
    try {
      const rec = parseWarcRecord(await fetchRecord(c));
      const x = extractPage(rec.html, rec.url);
      pages.push({ host, url: rec.url, crawledAt: rec.date, crawl: c.filename.split("/")[1], ...x });
    } catch (e) {
      console.error(`  skip ${c.url}: ${e.message}`);
    }
    await sleep(RATE_MS);
  }
  return pages;
}

const csvCell = (v) => {
  const s = Array.isArray(v) ? v.join(" | ") : v && typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";

async function main() {
  if (flag("selftest", false)) return selftest();

  let seeds = [];
  const seedFlag = flag("seed", "");
  if (seedFlag) seeds.push(...String(seedFlag).split(","));
  const seedFile = flag("seeds", "");
  if (seedFile) seeds.push(...seedsFromFile(readFileSync(seedFile, "utf8"), String(seedFile)));
  const query = flag("query", "");
  if (query) seeds.push(...(await serperSeeds(String(query))));
  seeds = uniq(seeds.map(normaliseSeed).filter(Boolean));
  if (!seeds.length) {
    console.error("No seeds. Use --seed host1,host2, --seeds file.txt or --query \"...\" (see the header of this file).");
    process.exit(1);
  }

  if (flag("print-plan", false)) {
    const crawls = Array.from({ length: CRAWLS }, (_, i) => (i === 0 ? "CC-MAIN-<latest>" : `CC-MAIN-<latest-${i}>`));
    for (const h of seeds) for (const c of crawls) console.log(cdxUrl(c, h));
    return;
  }

  const crawls = await latestCrawls(CRAWLS);
  console.error(`crawls: ${crawls.join(", ")}  seeds: ${seeds.length}  hops: ${HOPS}`);

  const seen = new Set(seeds.map(registeredDomain));
  let pages = [];
  let wave = seeds;
  let frontier = [];
  for (let hop = 0; hop <= HOPS; hop++) {
    console.error(`hop ${hop}: ${wave.length} hosts`);
    for (const h of wave) pages.push(...(await visitHost(h, crawls)).map((p) => ({ ...p, hop })));
    frontier = buildFrontier(pages, seen);
    wave = frontier.slice(0, HOP_HOSTS).map((f) => f.domain);
    wave.forEach((d) => seen.add(d));
  }

  const rows = pages.map((p) => ({
    ...p,
    people: p.entities.filter((e) => e.type === "Person").map((e) => [e.name, e.jobTitle, e.org].filter(Boolean).join(" · ")),
    orgs: p.entities.filter((e) => e.type !== "Person").map((e) => `${e.type}: ${e.name}`),
    terms: Object.entries(p.termHits).map(([t, n]) => `${t}:${n}`),
    snippet: p.description || p.text.slice(0, 240),
  }));
  writeFileSync(`${OUT}-pages.jsonl`, pages.map((p) => JSON.stringify(p)).join("\n") + "\n");
  writeFileSync(
    `${OUT}-pages.csv`,
    toCsv(rows, ["hop", "host", "url", "crawledAt", "title", "kinds", "emails", "phones", "linkedin", "people", "orgs", "terms", "snippet"]),
  );
  writeFileSync(`${OUT}-frontier.csv`, toCsv(frontier, ["domain", "linkedFromHosts", "links", "example"]));
  const withContact = pages.filter((p) => p.emails.length || p.phones.length || p.linkedin.length).length;
  console.error(
    `done: ${pages.length} pages, ${withContact} with a contact or LinkedIn link, ${frontier.length} frontier hosts\n` +
      `  -> ${OUT}-pages.csv, ${OUT}-pages.jsonl, ${OUT}-frontier.csv`,
  );
}

// ---------- 8. offline self-test ----------
function selftest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`selftest failed: ${msg}`);
    console.log(`ok  ${msg}`);
  };

  assert(registeredDomain("www.acme.co.in") === "acme.co.in", "co.in keeps three labels");
  assert(registeredDomain("blog.acme.com") === "acme.com", "subdomain folds to registered domain");
  assert(isPlatform("in.linkedin.com") && !isPlatform("acme-training.in"), "platform hosts are recognised");
  assert(normaliseSeed("https://www.Acme.com/path") === "acme.com", "seed URL normalises to host");
  const exported = 'Business Name,Phone,Website\n"Acme, Chennai",123,https://www.acme.in/\nNo Site,456,\n';
  assert(
    seedsFromFile(exported, "leadmine.csv").map(normaliseSeed).filter(Boolean).join() === "acme.in",
    "LeadMine CSV export gives its Website column as seeds",
  );

  const cdx = [
    '{"url":"https://acme.in/","timestamp":"20260810","status":"200","mime-detected":"text/html","filename":"crawl-data/CC-MAIN-2026-34/segments/1/warc/a.warc.gz","offset":"0","length":"10"}',
    '{"url":"https://acme.in/blog/2019/05/some-post","timestamp":"20260810","status":"200","mime-detected":"text/html"}',
    '{"url":"https://acme.in/our-trainers","timestamp":"20260712","status":"200","mime-detected":"text/html"}',
    '{"url":"https://acme.in/our-trainers","timestamp":"20260811","status":"200","mime-detected":"text/html"}',
    '{"url":"https://acme.in/logo.png","timestamp":"20260810","status":"200","mime-detected":"image/png"}',
    '{"url":"https://acme.in/old","timestamp":"20260810","status":"301","mime-detected":"text/html"}',
  ].join("\n");
  const picked = pickCaptures(parseCdx(cdx), 2);
  assert(picked.length === 2 && picked[0].url === "https://acme.in/", "homepage ranks first");
  assert(picked[1].url.endsWith("/our-trainers") && picked[1].timestamp === "20260811", "trainers page next, newest capture wins");

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Our Trainers &amp; Coaches | Acme</title>
<meta name="description" content="Corporate training in Chennai">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
 {"@type":"Person","name":"Priya Raman","jobTitle":"QA Automation Trainer","worksFor":{"@type":"Organization","name":"Acme Learning"},
  "sameAs":["https://www.linkedin.com/in/priya-raman-qa"]},
 {"@type":"EducationalOrganization","name":"Acme Learning","telephone":"+91 98401 23456"}]}</script>
<script type="application/ld+json">{ not valid json </script></head>
<body><h1>Trainers</h1><p>Priya runs Selenium and Playwright workshops for corporate teams.</p>
<a href="mailto:priya@acme.in">Email Priya</a> <a href="tel:+91-98401-23456">Call</a>
<a href="https://in.linkedin.com/in/priya-raman-qa/">LinkedIn</a>
<a href="https://testconf.in/speakers">Speaker at TestConf</a> <a href="https://www.testconf.in/2025">2025</a>
<a href="/contact">Contact</a> <img src="logo@2x.png"></body></html>`;
  const x = extractPage(html, "https://acme.in/our-trainers");
  assert(x.title === "Our Trainers & Coaches | Acme", "title decoded");
  assert(x.kinds.includes("trainers"), "page kind from path and title");
  assert(x.emails.length === 1 && x.emails[0] === "priya@acme.in", "email found, image filename rejected");
  assert(x.phones.includes("+919840123456"), "phone from tel: link");
  assert(x.linkedin.includes("https://in.linkedin.com/in/priya-raman-qa"), "LinkedIn profile link kept");
  const person = x.entities.find((e) => e.type === "Person");
  assert(person?.name === "Priya Raman" && person.org === "Acme Learning", "JSON-LD Person with employer, bad block skipped");
  assert(x.termHits.trainer >= 1 && x.termHits.workshop === 1, "term hits counted");
  assert(x.outHosts.includes("testconf.in") && !x.outHosts.includes("acme.in"), "outside links only");

  const body = Buffer.from(html, "utf8");
  const http = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=UTF-8\r\nX-Crawler-Content-Encoding: gzip\r\n\r\n`);
  const block = Buffer.concat([http, body]);
  const warc = Buffer.concat([
    Buffer.from(
      `WARC/1.0\r\nWARC-Type: response\r\nWARC-Date: 2026-08-11T10:00:00Z\r\n` +
        `WARC-Target-URI: https://acme.in/our-trainers\r\nContent-Length: ${block.length}\r\n\r\n`,
    ),
    block,
    Buffer.from("\r\n\r\n"),
  ]);
  const rec = parseWarcRecord(gunzipSync(gzipSync(warc)));
  assert(rec.url === "https://acme.in/our-trainers" && rec.status === 200, "WARC record headers parsed");
  assert(rec.html === html, "WARC payload recovered byte for byte");

  const frontier = buildFrontier(
    [
      { host: "acme.in", url: "https://acme.in/a", outHosts: ["testconf.in", "www.linkedin.com", "other.com"] },
      { host: "beta.co.in", url: "https://beta.co.in/b", outHosts: ["testconf.in"] },
    ],
    new Set(["acme.in", "beta.co.in"]),
  );
  assert(frontier[0].domain === "testconf.in" && frontier[0].linkedFromHosts === 2, "frontier ranks hosts linked from several seeds");
  assert(!frontier.some((f) => f.domain === "linkedin.com"), "platforms stay out of the frontier");
  console.log("selftest passed");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
