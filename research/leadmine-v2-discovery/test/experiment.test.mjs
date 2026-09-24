// The whole experiment against a small fake web, so every path is exercised:
// Google results, a CC capture, a Wayback capture, a CT subdomain, a live
// page reached by a link, entity resolution, the baseline, and the metrics.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_WEIGHTS } from "../lib/frontier.mjs";
import { baselineFromCsv, metrics, reportMarkdown, reviewRows, runExperiment, scoreReview } from "../experiment.mjs";

const person = (name, slug, extra = "") =>
  `<script type="application/ld+json">{"@type":"Person","name":"${name}","sameAs":["https://www.linkedin.com/in/${slug}"]${extra}}</script>`;

const WEB = {
  // Google returns these two.
  "https://acme.in/": `<title>Acme Learning | Corporate QA automation training</title>${person("Priya Raman", "priya-raman-qa")}
    <a href="/our-trainers">Our QA automation trainers</a> <a href="/blog/2019/diwali">Diwali offer</a>
    <a href="https://testconf.in/speakers">We speak at TestConf</a>`,
  "https://solo-trainer.in/": `<title>Karthik — QA automation trainer</title><a href="mailto:karthik.s@solo-trainer.in">mail</a>`,
  // Only in Common Crawl: Google did not return it.
  "https://acme.in/our-trainers": `<title>Trainers</title>
    <a href="https://www.linkedin.com/in/priya-raman-qa">Priya Raman</a>
    <a href="https://www.linkedin.com/in/arun-k-77">Arun Kumar</a>`,
  // Reached by a link from a Google result, one hop out.
  "https://testconf.in/speakers": `<title>TestConf 2025 speakers</title>
    <a href="https://www.linkedin.com/in/meena-iyer">Meena Iyer</a> <a href="https://www.linkedin.com/in/priya-raman-qa">Priya Raman</a>`,
  // Only in the Wayback Machine, from 2023.
  "https://acme.in/old-team": `<title>Team</title><a href="https://www.linkedin.com/in/ravi-shankar-qa">Ravi Shankar</a>`,
  // Found through Certificate Transparency.
  "https://academy.acme.in/": `<title>Acme Academy trainers</title><a href="https://www.linkedin.com/in/deepa-n">Deepa Natarajan</a>`,
  "https://acme.in/blog/2019/diwali": `<title>Diwali offer</title><p>20% off</p>`,
};

function fakeIo() {
  let t = Date.UTC(2026, 8, 24);
  const fetched = [];
  const page = (url) => {
    if (!(url in WEB)) throw new Error("404");
    fetched.push(url);
    return WEB[url];
  };
  return {
    fetched,
    now: () => t,
    sleep: async (ms) => void (t += ms),
    latestCrawls: async () => ["CC-MAIN-2026-34"],
    googleResults: async () => [
      { url: "https://acme.in/", title: "Acme Learning" },
      { url: "https://solo-trainer.in/", title: "Karthik QA trainer" },
      { url: "https://www.linkedin.com/in/somebody", title: "Somebody | LinkedIn" },
    ],
    ccCaptures: async (domain) =>
      domain === "acme.in"
        ? [{ url: "https://acme.in/our-trainers", observedAt: "20260811093000", capture: { kind: "cc", url: "https://acme.in/our-trainers" } }]
        : [],
    ccFetch: async (c) => ({ url: c.url, date: "2026-08-11T09:30:00Z", status: 200, html: page(c.url) }),
    waybackCaptures: async (domain) =>
      domain === "acme.in"
        ? [{ url: "https://acme.in/old-team", observedAt: "20230105000000", capture: { kind: "wayback", timestamp: "20230105000000", url: "https://acme.in/old-team" } }]
        : [],
    waybackFetch: async (c) => ({ url: c.url, date: c.timestamp, status: 200, html: page(c.url) }),
    crtSubdomains: async (domain) => (domain === "acme.in" ? [{ host: "academy.acme.in", promising: true }] : []),
    sitemapUrls: async () => [],
    liveFetch: async (url) => ({ url, date: new Date(t).toISOString(), status: 200, html: page(url) }),
  };
}

const baseline = baselineFromCsv(
  "Name,Headline,Company,Profile URL,Found Via\nArun Kumar,QA trainer,Acme,https://www.linkedin.com/in/arun-k-77,web\n",
);

async function run(extra = {}) {
  const io = fakeIo();
  const r = await runExperiment(
    { query: "QA automation trainer", seeds: [], weights: DEFAULT_WEIGHTS, maxPages: 50, rateMs: 1000, baseline, ...extra },
    io,
  );
  return { r, io };
}

test("finds people Google did not return, and says how each was reached", async () => {
  const { r } = await run();
  const m = metrics(r);
  const byName = (n) => r.people.find((p) => p.names.includes(n));

  assert.equal(r.googleResults, 2, "the LinkedIn result is a platform page and is not crawled");
  assert.equal(m.X, 2, "Priya and Karthik are on pages Google returned");
  assert.ok(byName("Priya Raman").inGoogleSet);
  assert.equal(byName("Priya Raman").mentions.length, 3, "one person across three pages");
  assert.ok(byName("Arun Kumar").inBaseline && !byName("Arun Kumar").isNew, "already in the LeadMine export");

  const newNames = r.people.filter((p) => p.isNew).flatMap((p) => p.names).sort();
  assert.deepEqual(newNames, ["Deepa Natarajan", "Meena Iyer", "Ravi Shankar"]);
  assert.deepEqual(byName("Meena Iyer").foundVia, ["link"]);
  assert.deepEqual(byName("Deepa Natarajan").foundVia, ["crt"]);
  assert.ok(byName("Ravi Shankar").historicalOnly, "a 2023 Wayback capture is history, not a current fact");
  assert.equal(m.newCount, 3);
  assert.equal(m.newHistoricalOnly, 1);
});

test("every claim carries its page and date; documents record how they were fetched", async () => {
  const { r } = await run();
  assert.ok(r.evidence.length > 0);
  for (const e of r.evidence) assert.ok(e.document_id && e.url && e.observed_at && e.claim, JSON.stringify(e));
  const old = r.documents.find((d) => d.url === "https://acme.in/old-team");
  assert.equal(old.source, "wayback");
  assert.equal(old.observedAt, "2023-01-05T00:00:00Z");
  assert.equal(r.documents.find((d) => d.url === "https://acme.in/our-trainers").source, "cc");
  assert.ok(r.relationships.some((x) => x.relation === "LINKS_TO" && x.target === "org:testconf.in"));
  assert.ok(r.relationships.some((x) => x.relation === "SPEAKS_AT" && x.source === "person:li:meena-iyer"));
});

test("the trainers page is fetched before the blog post", async () => {
  const { io } = await run();
  assert.ok(io.fetched.indexOf("https://acme.in/our-trainers") < io.fetched.indexOf("https://acme.in/blog/2019/diwali"));
});

test("with live fetching off, only archived captures are read", async () => {
  const { r, io } = await run({ sources: ["cc", "wayback"] });
  assert.deepEqual(io.fetched.sort(), ["https://acme.in/old-team", "https://acme.in/our-trainers"]);
  assert.ok(r.failures.every((f) => /live fetching is off/.test(f.error)));
});

test("review sheet, report and scoring", async () => {
  const { r } = await run();
  const rows = reviewRows(r.people);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((x) => x.relevant === "" && x.urls.length));
  const md = reportMarkdown(r, metrics(r), { query: "QA automation trainer" });
  assert.match(md, /\*\*New\*\* people \| 3 \|/);

  const sheet = "person_id,name,relevant\na,A,y\nb,B,n\nc,C,\nd,D,yes\n";
  assert.deepEqual(scoreReview(sheet), { newPeople: 4, labelled: 3, Z: 2, F: 0.333, estimatedRelevant: 3 });
});
