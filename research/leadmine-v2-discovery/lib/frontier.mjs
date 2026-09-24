// A lead-specific crawl frontier: which URL to fetch next.
//
// The shape follows crawler-commons/url-frontier and Frontera: every URL has a
// state, hosts are rate-limited separately, and the next URL is the best-scored
// one whose host is allowed to be hit now. What is LeadMine-specific is the
// score, which predicts whether a page will name people who fit the query, and
// the feedback: when a page turns out to be rich in evidence, the links it
// holds (and its host) are rescored upward.
//
// A URL is scored *before* it is fetched, so every component is a prediction
// from what is known at that point: the link's anchor text and path, the page
// that linked to it, how far it is from a seed, and how its host has done.

import { isPlatform, pageKinds, registeredDomain } from "../cc-discover.mjs";

export const DEFAULT_WEIGHTS = {
  relevance: 0.3, // query terms in the anchor text, the path, the linking page's title
  entity: 0.2, // does the path/anchor look like a page that names people?
  proximity: 0.15, // hops from a seed, plus how many seed hosts point at the host
  evidence: 0.15, // how much evidence the linking page held (the feedback loop)
  freshness: 0.1, // capture or lastmod date, when there is one
  quality: 0.1, // how the host has done so far: evidence per page fetched
};

export const STATE = { QUEUED: "queued", FETCHED: "fetched", FAILED: "failed", SKIPPED: "skipped" };

const clamp = (x) => Math.max(0, Math.min(1, x));
const tokens = (s) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

export function parseWeights(spec) {
  if (!spec) return { ...DEFAULT_WEIGHTS };
  const w = { ...DEFAULT_WEIGHTS };
  for (const part of String(spec).split(",")) {
    const [k, v] = part.split("=");
    if (!(k in w) || Number.isNaN(Number(v))) throw new Error(`bad weight "${part}" (keys: ${Object.keys(w).join(", ")})`);
    w[k] = Number(v);
  }
  return w;
}

// Days since a capture timestamp ("20260811…"), an ISO date, or undefined.
export function ageDays(when, now = Date.now()) {
  if (!when) return null;
  const s = String(when);
  const t = /^\d{8}/.test(s) ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) : Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 86_400_000);
}

export class Frontier {
  constructor({ queryTerms = [], weights = DEFAULT_WEIGHTS, delayMs = 1000, maxPerHost = 20, now = () => Date.now() } = {}) {
    this.queryTerms = [...new Set(queryTerms.flatMap(tokens))];
    this.weights = weights;
    this.delayMs = delayMs;
    this.maxPerHost = maxPerHost;
    this.now = now;
    this.urls = new Map(); // key -> entry
    this.hosts = new Map(); // registered domain -> { nextAt, fetched, evidence, seedLinks:Set }
  }

  static key(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`.toLowerCase();
    } catch {
      return null;
    }
  }

  host(domain) {
    let h = this.hosts.get(domain);
    if (!h) {
      h = { nextAt: 0, fetched: 0, evidence: 0, seedLinks: new Set(), loaded: false };
      this.hosts.set(domain, h);
    }
    return h;
  }

  // Each component in [0,1], so a score is a weighted average and can be read.
  components(e) {
    const hay = tokens(`${e.anchor} ${e.path} ${e.parentTitle}`);
    const hit = this.queryTerms.length ? this.queryTerms.filter((t) => hay.includes(t)).length / this.queryTerms.length : 0;
    const kinds = pageKinds(e.url, e.anchor);
    const people = kinds.some((k) => ["trainers", "speakers", "team", "about"].includes(k));
    const h = this.host(e.domain);
    const f = ageDays(e.observedAt, this.now());
    return {
      relevance: clamp(hit),
      entity: people ? 1 : kinds.length ? 0.5 : e.isHome ? 0.4 : 0.1,
      proximity: clamp(1 / (1 + e.hop) + 0.15 * Math.max(0, h.seedLinks.size - 1)),
      evidence: clamp(e.parentEvidence / 5),
      freshness: f === null ? 0.5 : clamp(1 - f / 1095), // 0 at three years old
      quality: h.fetched ? clamp(h.evidence / h.fetched / 3) : 0.5,
    };
  }

  score(e) {
    const c = this.components(e);
    const total = Object.values(this.weights).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(this.weights).reduce((s, [k, w]) => s + w * c[k], 0) / total;
  }

  /**
   * Queue a URL. Returns the entry, or null when it is a platform, unparseable,
   * or already known (a known URL keeps its best parent's context).
   *   via: how the URL was found: seed | google | link | cc | wayback | sitemap | crt
   *   capture: where its bytes can be read without the live site (cc/wayback), if known
   */
  add(url, { via, hop = 0, anchor = "", parentTitle = "", parentEvidence = 0, observedAt, capture, from } = {}) {
    const key = Frontier.key(url);
    if (!key) return null;
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || isPlatform(u.hostname)) return null;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|css|js|zip|mp4|mp3|docx?|xlsx?|pptx?)$/i.test(u.pathname)) return null;
    const domain = registeredDomain(u.hostname);
    const old = this.urls.get(key);
    if (old) {
      // A second, better route to a queued URL improves its context.
      if (old.state === STATE.QUEUED && (parentEvidence > old.parentEvidence || hop < old.hop)) {
        Object.assign(old, { parentEvidence: Math.max(old.parentEvidence, parentEvidence), hop: Math.min(old.hop, hop) });
        if (anchor && !old.anchor) old.anchor = anchor;
        old.score = this.score(old);
      }
      if (capture && !old.capture) old.capture = capture;
      return null;
    }
    const e = {
      key,
      url: u.href,
      domain,
      path: decodeURIComponent(u.pathname),
      isHome: u.pathname === "/" || u.pathname === "",
      via,
      hop,
      anchor,
      parentTitle,
      parentEvidence,
      observedAt,
      capture,
      from,
      state: STATE.QUEUED,
    };
    e.score = this.score(e);
    this.urls.set(key, e);
    return e;
  }

  noteSeedLink(domain, fromDomain) {
    if (domain !== fromDomain) this.host(domain).seedLinks.add(fromDomain);
  }

  /** The best queued URL whose host may be hit now; else the wait until one may. */
  next() {
    const t = this.now();
    let best = null;
    let wait = Infinity;
    for (const e of this.urls.values()) {
      if (e.state !== STATE.QUEUED) continue;
      const h = this.host(e.domain);
      if (h.fetched >= this.maxPerHost) {
        e.state = STATE.SKIPPED;
        continue;
      }
      if (h.nextAt > t) {
        wait = Math.min(wait, h.nextAt - t);
        continue;
      }
      if (!best || e.score > best.score) best = e;
    }
    return best ? { entry: best } : { wait: wait === Infinity ? null : wait };
  }

  /** Record a fetch. Evidence on the page feeds the host's quality and rescoring. */
  done(entry, { ok, evidence = 0 }) {
    entry.state = ok ? STATE.FETCHED : STATE.FAILED;
    entry.evidenceFound = evidence;
    const h = this.host(entry.domain);
    h.nextAt = this.now() + this.delayMs;
    if (!ok) return;
    h.fetched++;
    h.evidence += evidence;
    // The host's quality moved, so everything still queued on it moves too.
    for (const e of this.urls.values()) if (e.domain === entry.domain && e.state === STATE.QUEUED) e.score = this.score(e);
  }

  stats() {
    const by = {};
    for (const e of this.urls.values()) by[e.state] = (by[e.state] ?? 0) + 1;
    return by;
  }
}
