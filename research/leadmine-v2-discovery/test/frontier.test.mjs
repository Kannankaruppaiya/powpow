import assert from "node:assert/strict";
import { test } from "node:test";
import { Frontier, STATE, ageDays, parseWeights } from "../lib/frontier.mjs";

const clock = () => {
  let t = Date.UTC(2026, 8, 24);
  return { now: () => t, advance: (ms) => (t += ms) };
};

test("a trainers page with the query words outranks a blog post", () => {
  const c = clock();
  const f = new Frontier({ queryTerms: ["QA automation trainer"], now: c.now });
  const blog = f.add("https://acme.in/blog/2019/05/diwali-offer", { via: "link", hop: 0, anchor: "Diwali offer" });
  const trainers = f.add("https://acme.in/our-trainers", { via: "link", hop: 0, anchor: "QA automation trainers" });
  assert.ok(trainers.score > blog.score, `${trainers.score} > ${blog.score}`);
  assert.equal(f.next().entry, trainers);
});

test("platforms, files and duplicates are not queued", () => {
  const f = new Frontier();
  assert.equal(f.add("https://in.linkedin.com/in/someone", { via: "link" }), null);
  assert.equal(f.add("https://acme.in/brochure.pdf", { via: "link" }), null);
  assert.ok(f.add("https://www.acme.in/team/", { via: "link" }));
  assert.equal(f.add("https://acme.in/team", { via: "link" }), null, "www and trailing slash are the same URL");
});

test("a second, richer route to a queued URL raises its score", () => {
  const f = new Frontier({ queryTerms: ["trainer"] });
  const e = f.add("https://conf.in/2025", { via: "link", hop: 1, parentEvidence: 0 });
  const before = e.score;
  f.add("https://conf.in/2025", { via: "link", hop: 1, parentEvidence: 5 });
  assert.ok(e.score > before);
});

test("one host waits for its delay while another host is served", () => {
  const c = clock();
  const f = new Frontier({ delayMs: 1000, now: c.now });
  const a1 = f.add("https://a.in/team", { via: "seed" });
  const a2 = f.add("https://a.in/about", { via: "seed" });
  const b1 = f.add("https://b.in/", { via: "seed" });
  const first = f.next().entry;
  f.done(first, { ok: true, evidence: 0 });
  const second = f.next().entry;
  assert.notEqual(second.domain, first.domain, "the same host is not hit twice in a row");
  f.done(second, { ok: true, evidence: 0 });
  const { entry, wait } = f.next();
  assert.equal(entry, undefined);
  assert.ok(wait > 0 && wait <= 1000);
  c.advance(wait);
  assert.ok([a1, a2, b1].includes(f.next().entry));
});

test("a host that yields evidence pulls its queued pages up", () => {
  const f = new Frontier();
  const next = f.add("https://rich.in/page-2", { via: "link" });
  const first = f.add("https://rich.in/page-1", { via: "link" });
  const other = f.add("https://poor.in/page-1", { via: "link" });
  assert.equal(next.score, other.score);
  f.done(first, { ok: true, evidence: 6 });
  assert.ok(next.score > other.score);
});

test("per-host cap skips the rest of a host", () => {
  const c = clock();
  const f = new Frontier({ maxPerHost: 1, delayMs: 0, now: c.now });
  const a = f.add("https://a.in/1", { via: "seed" });
  const b = f.add("https://a.in/2", { via: "seed" });
  f.done(f.next().entry, { ok: true });
  assert.equal(f.next().wait, null);
  assert.equal([a, b].filter((e) => e.state === STATE.SKIPPED).length, 1);
});

test("weights parse and reject unknown keys", () => {
  assert.equal(parseWeights("proximity=1,relevance=0").proximity, 1);
  assert.throws(() => parseWeights("magic=1"));
});

test("ages from capture timestamps and ISO dates", () => {
  const now = Date.UTC(2026, 8, 24);
  assert.equal(Math.round(ageDays("20260824120000", now)), 31);
  assert.equal(Math.round(ageDays("2026-09-14", now)), 10);
  assert.equal(ageDays(undefined, now), null);
});
