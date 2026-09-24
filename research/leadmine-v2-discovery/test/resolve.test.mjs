import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPage } from "../cc-discover.mjs";
import {
  abbreviationFits,
  baselineIndex,
  inBaseline,
  isRoleEmail,
  linkedinSlug,
  looksLikeName,
  peopleFromPage,
  resolve,
} from "../lib/resolve.mjs";

const doc = (url, id = "d1") => ({ id, url, host: new URL(url).hostname, observedAt: "2026-08-11", via: "cc" });
const cand = (o) => ({ name: "", linkedin: null, emails: [], phones: [], org: "", orgDomain: "", jobTitle: "", confidence: 0.5, ...o });

test("names, slugs and role addresses", () => {
  assert.ok(looksLikeName("Priya Raman"));
  assert.ok(looksLikeName("Dr. K. Senthil Kumar"));
  assert.ok(!looksLikeName("LinkedIn"));
  assert.ok(!looksLikeName("View Profile"));
  assert.ok(!looksLikeName("Our Trainers"));
  assert.ok(!looksLikeName("priya raman"));
  assert.equal(linkedinSlug("https://in.linkedin.com/in/Priya-Raman-QA/?trk=x"), "priya-raman-qa");
  assert.ok(isRoleEmail("training@acme.in") && isRoleEmail("info@acme.in"));
  assert.ok(!isRoleEmail("priya.raman@acme.in"));
});

test("a page yields people from JSON-LD, named profile links and personal emails, and invents no names", () => {
  const html = `<html><head><title>Trainers | Acme</title>
  <script type="application/ld+json">{"@type":"Person","name":"Priya Raman","jobTitle":"QA Trainer","sameAs":"https://www.linkedin.com/in/priya-raman-qa"}</script></head>
  <body><a href="https://www.linkedin.com/in/priya-raman-qa">Priya Raman</a>
  <a href="https://www.linkedin.com/in/arun-k-77">Arun Kumar</a>
  <a href="https://www.linkedin.com/in/mystery-person"><img src="li.svg"></a>
  <a href="mailto:karthik.sundaram@acme.in">Mail</a> <a href="mailto:m.k@acme.in">Mail</a>
  <a href="mailto:training@acme.in">Training desk</a></body></html>`;
  const page = extractPage(html, "https://acme.in/trainers");
  const people = peopleFromPage(doc("https://acme.in/trainers"), page);
  const by = (slug) => people.find((p) => p.linkedin === slug);
  assert.equal(people.filter((p) => p.linkedin === "priya-raman-qa").length, 1, "JSON-LD and its link are one candidate");
  assert.equal(by("priya-raman-qa").nameSource, "json-ld");
  assert.equal(by("arun-k-77").name, "Arun Kumar");
  assert.equal(by("mystery-person").name, "", "an icon link names nobody");
  assert.ok(people.some((p) => p.emails[0] === "karthik.sundaram@acme.in" && p.name === "Karthik Sundaram"));
  assert.ok(people.some((p) => p.emails[0] === "m.k@acme.in" && p.name === ""), "initials are not a name");
  assert.ok(!people.some((p) => p.emails.includes("training@acme.in")), "role address is not a person");
  assert.ok(people.every((p) => p.docId === "d1" && p.observedAt === "2026-08-11" && p.claim));
});

test("strong keys merge across pages; the same name at two companies does not", () => {
  const people = resolve([
    cand({ name: "Priya Raman", linkedin: "priya-raman-qa", orgDomain: "acme.in", docId: "a" }),
    cand({ name: "", linkedin: "priya-raman-qa", orgDomain: "testconf.in", docId: "b" }),
    cand({ name: "Priya R", emails: ["priya@acme.in"], orgDomain: "acme.in", docId: "c" }),
    cand({ name: "Priya Raman", emails: ["priya@acme.in"], orgDomain: "acme.in", docId: "d" }),
    cand({ name: "Priya Raman", orgDomain: "othercorp.com", docId: "e" }),
  ]);
  assert.equal(people.length, 2);
  const main = people.find((p) => p.linkedin.includes("priya-raman-qa"));
  assert.deepEqual(main.mentions.map((m) => m.docId).sort(), ["a", "b", "c", "d"]);
  assert.equal(main.id, "li:priya-raman-qa");
});

test("abbreviations merge only when exactly one full name fits", () => {
  assert.ok(abbreviationFits("A. Sharma", "Abhishek Sharma"));
  assert.ok(abbreviationFits("Abhishek S", "Abhishek Sharma"));
  assert.ok(!abbreviationFits("B. Sharma", "Abhishek Sharma"));

  const one = resolve([
    cand({ name: "Abhishek Sharma", orgDomain: "acme.in", emails: ["abhishek@acme.in"] }),
    cand({ name: "A. Sharma", orgDomain: "acme.in" }),
  ]);
  assert.equal(one.length, 1);

  const ambiguous = resolve([
    cand({ name: "Abhishek Sharma", orgDomain: "acme.in", emails: ["abhishek@acme.in"] }),
    cand({ name: "Anita Sharma", orgDomain: "acme.in", emails: ["anita@acme.in"] }),
    cand({ name: "A. Sharma", orgDomain: "acme.in" }),
  ]);
  assert.equal(ambiguous.length, 3, "A. Sharma could be either, so stays apart");
});

test("baseline matching by profile, email, or name plus organisation name", () => {
  const b = baselineIndex([
    { names: ["Priya Raman"], linkedin: [], emails: [], orgs: ["Acme Learning Pvt Ltd"], orgDomains: [] },
    { names: [], linkedin: ["arun-k-77"], emails: [], orgs: [], orgDomains: [] },
  ]);
  const p = (o) => ({ names: [], linkedin: [], emails: [], orgs: [], orgDomains: [], ...o });
  assert.ok(inBaseline(p({ linkedin: ["arun-k-77"] }), b));
  assert.ok(inBaseline(p({ names: ["Priya Raman"], orgs: ["Acme Learning"] }), b));
  assert.ok(!inBaseline(p({ names: ["Priya Raman"], orgs: ["Other Corp"] }), b));
});
