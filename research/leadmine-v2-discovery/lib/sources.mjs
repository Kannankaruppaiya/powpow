// Where URLs and page bytes come from. Each source says what it is good for,
// because the answer decides how its evidence may be shown:
//
//   google   Serper organic results. The baseline the experiment measures against.
//   cc       Common Crawl: what CCBot saw, 5-7 weeks old at best. No LinkedIn.
//   wayback  Internet Archive captures: pages that may no longer exist. Every
//            claim from here is historical and is labelled with its capture date.
//   crt      Certificate Transparency (crt.sh): subdomains a company has
//            certificates for, e.g. academy.company.com. Hosts, not pages.
//   sitemap  A live site's own list of its pages, with lastmod dates.
//   live     A direct fetch of a known URL, whether or not any engine indexed it.
//            robots.txt is honoured.
//
// Parsing is kept separate from fetching, so every parser is tested offline.

import { gunzipSync } from "node:zlib";
import {
  cdxUrl,
  fetchRecord,
  getWithRetry,
  isPlatform,
  parseCdx,
  parseWarcRecord,
  pickCaptures,
  registeredDomain,
} from "../cc-discover.mjs";

export const UA = "LeadMineResearch/0.1 (+https://github.com/Kannankaruppaiya/powpow; polite, one request at a time)";
const UA_TOKEN = "leadmineresearch";

// ---------- google (Serper) ----------
export async function googleResults(q, pages = 2) {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("--query needs SERPER_API_KEY (Google results via serper.dev)");
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q, num: 10, page }),
    });
    if (!res.ok) throw new Error(`serper ${res.status}: ${await res.text()}`);
    const items = (await res.json()).organic ?? [];
    items.forEach((r, i) => out.push({ url: r.link, title: r.title ?? "", snippet: r.snippet ?? "", rank: (page - 1) * 10 + i + 1 }));
    if (items.length < 10) break;
  }
  return out;
}

// ---------- cc ----------
export async function ccCaptures(host, crawls, perHost) {
  const all = [];
  for (const crawl of crawls) {
    const res = await getWithRetry(cdxUrl(crawl, host));
    if (res.ok) all.push(...parseCdx(await res.text()));
  }
  return pickCaptures(all, perHost).map((c) => ({
    url: c.url,
    observedAt: c.timestamp,
    capture: { kind: "cc", filename: c.filename, offset: c.offset, length: c.length },
  }));
}

export async function ccFetch(capture) {
  return parseWarcRecord(await fetchRecord(capture));
}

// ---------- wayback ----------
export function waybackCdxUrl(host, limit = 3000) {
  const q = new URLSearchParams({
    url: host,
    matchType: "domain",
    output: "json",
    fl: "original,timestamp,statuscode,mimetype",
    collapse: "urlkey",
    limit: String(limit),
  });
  q.append("filter", "statuscode:200");
  q.append("filter", "mimetype:text/html");
  return `https://web.archive.org/cdx/search/cdx?${q}`;
}

// The CDX answer is an array of rows whose first row is the header.
export function parseWaybackCdx(json) {
  const rows = Array.isArray(json) ? json : [];
  if (!rows.length) return [];
  const head = rows[0];
  const col = (name) => head.indexOf(name);
  return rows.slice(1).map((r) => ({
    url: r[col("original")],
    timestamp: r[col("timestamp")],
    status: r[col("statuscode")],
    "mime-detected": r[col("mimetype")],
  }));
}

export async function waybackCaptures(host, perHost) {
  const res = await getWithRetry(waybackCdxUrl(host), { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  return pickCaptures(parseWaybackCdx(await res.json()), perHost).map((c) => ({
    url: c.url,
    observedAt: c.timestamp,
    capture: { kind: "wayback", timestamp: c.timestamp, url: c.url },
  }));
}

// "id_" asks for the archived bytes as they were, without the Wayback toolbar.
export async function waybackFetch(capture) {
  const res = await getWithRetry(`https://web.archive.org/web/${capture.timestamp}id_/${capture.url}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`wayback ${res.status}`);
  return { url: capture.url, date: capture.timestamp, status: 200, html: await res.text() };
}

// ---------- crt ----------
// Subdomain labels that suggest a surface with people on it.
const PEOPLE_SUBDOMAIN = /^(academy|training|learn|learning|edu|education|events?|conf(erence)?|summit|speakers?|team|people|careers?|jobs|community|university|school|institute|workshops?|courses?)$/;

export function parseCrt(json, domain) {
  const names = new Set();
  for (const row of Array.isArray(json) ? json : []) {
    for (const n of String(row.name_value ?? "").split("\n")) {
      const h = n.trim().toLowerCase().replace(/^\*\./, "");
      if (h.endsWith(`.${domain}`) && h !== `www.${domain}`) names.add(h);
    }
  }
  return [...names]
    .map((h) => ({ host: h, promising: PEOPLE_SUBDOMAIN.test(h.slice(0, -domain.length - 1).split(".").pop()) }))
    .sort((a, b) => b.promising - a.promising || a.host.localeCompare(b.host));
}

export async function crtSubdomains(domain) {
  const res = await getWithRetry(`https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return [];
  return parseCrt(await res.json(), domain);
}

// ---------- robots.txt ----------
// The group for our token if there is one, else "*". Longest matching rule wins.
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  const sitemaps = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "sitemap") sitemaps.push(v);
    else if (k === "user-agent") {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    } else if ((k === "allow" || k === "disallow") && cur) cur.rules.push({ allow: k === "allow", path: v });
    lastWasAgent = false;
  }
  const mine = groups.find((g) => g.agents.some((a) => a !== "*" && UA_TOKEN.includes(a)));
  const star = groups.find((g) => g.agents.includes("*"));
  return { rules: (mine ?? star)?.rules ?? [], sitemaps };
}

export function robotsAllows(robots, path) {
  let best = null;
  for (const r of robots.rules) {
    if (!r.path) continue; // "Disallow:" with nothing means allow all
    const re = new RegExp(`^${r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)))
      best = r;
  }
  return !best || best.allow;
}

// ---------- live ----------
const robotsCache = new Map();

async function robotsFor(origin) {
  if (!robotsCache.has(origin)) {
    let parsed = { rules: [], sitemaps: [] };
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      // A 4xx robots.txt means no rules; a 5xx means "don't crawl" under RFC 9309.
      if (res.ok) parsed = parseRobots(await res.text());
      else if (res.status >= 500) parsed = { rules: [{ allow: false, path: "/" }], sitemaps: [] };
    } catch {
      parsed = { rules: [{ allow: false, path: "/" }], sitemaps: [] };
    }
    robotsCache.set(origin, parsed);
  }
  return robotsCache.get(origin);
}

export async function liveFetch(url) {
  const u = new URL(url);
  const robots = await robotsFor(u.origin);
  if (!robotsAllows(robots, u.pathname + u.search)) throw new Error("disallowed by robots.txt");
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`live ${res.status}`);
  if (!/html/i.test(res.headers.get("content-type") ?? "")) throw new Error("not HTML");
  const html = (await res.text()).slice(0, 2_000_000);
  return { url: res.url || url, date: new Date().toISOString(), status: res.status, html };
}

// ---------- sitemap ----------
export function parseSitemap(xml) {
  const locs = [];
  const children = [];
  const isIndex = /<sitemapindex\b/i.test(xml);
  for (const m of String(xml).matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const loc = m[2].match(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i)?.[1]?.trim();
    const lastmod = m[2].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1];
    if (!loc) continue;
    (isIndex || m[1].toLowerCase() === "sitemap" ? children : locs).push({ url: loc.replace(/&amp;/g, "&"), lastmod });
  }
  return { locs, children };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return (/\.gz$/i.test(url) ? gunzipSync(buf) : buf).toString("utf8");
}

export async function sitemapUrls(host, max = 2000) {
  const origin = `https://${host}`;
  const robots = await robotsFor(origin);
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [`${origin}/sitemap.xml`];
  const out = [];
  let files = 0;
  while (queue.length && files < 6 && out.length < max) {
    files++;
    try {
      const { locs, children } = parseSitemap(await fetchText(queue.shift()));
      out.push(...locs);
      // People pages first when a sitemap index splits by type.
      queue.push(...children.map((c) => c.url).sort((a, b) => /page|people|team|trainer/i.test(b) - /page|people|team|trainer/i.test(a)));
    } catch {}
  }
  const sameSite = (l) => {
    try {
      const h = new URL(l.url).hostname;
      return !isPlatform(h) && registeredDomain(h) === registeredDomain(host);
    } catch {
      return false;
    }
  };
  return out.filter(sameSite).slice(0, max);
}
