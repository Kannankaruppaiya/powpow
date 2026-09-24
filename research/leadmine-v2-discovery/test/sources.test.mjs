import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCrt, parseRobots, parseSitemap, parseWaybackCdx, robotsAllows, waybackCdxUrl } from "../lib/sources.mjs";

test("wayback CDX rows become captures", () => {
  const rows = parseWaybackCdx([
    ["original", "timestamp", "statuscode", "mimetype"],
    ["https://acme.in/trainers/abhishek", "20240312101500", "200", "text/html"],
  ]);
  assert.deepEqual(rows[0], {
    url: "https://acme.in/trainers/abhishek",
    timestamp: "20240312101500",
    status: "200",
    "mime-detected": "text/html",
  });
  assert.deepEqual(parseWaybackCdx([]), []);
  const u = new URL(waybackCdxUrl("acme.in"));
  assert.equal(u.searchParams.get("matchType"), "domain");
  assert.deepEqual(u.searchParams.getAll("filter"), ["statuscode:200", "mimetype:text/html"]);
});

test("crt.sh names become subdomains, people-facing ones first", () => {
  const subs = parseCrt(
    [{ name_value: "*.acme.com\nacademy.acme.com" }, { name_value: "mail.acme.com\nwww.acme.com" }, { name_value: "evil.com" }],
    "acme.com",
  );
  assert.deepEqual(
    subs.map((s) => [s.host, s.promising]),
    [
      ["academy.acme.com", true],
      ["mail.acme.com", false],
    ],
  );
});

test("robots.txt: our group over *, longest rule wins, empty Disallow allows", () => {
  const r = parseRobots(`User-agent: *
Disallow: /private
Allow: /private/team

User-agent: LeadMineResearch
Disallow: /no-bots

Sitemap: https://acme.in/sitemap_index.xml`);
  assert.deepEqual(r.sitemaps, ["https://acme.in/sitemap_index.xml"]);
  assert.ok(!robotsAllows(r, "/no-bots/x"), "our own group applies");
  assert.ok(robotsAllows(r, "/private"), "the * group does not apply once ours exists");

  const star = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/team\nDisallow: /*.php$");
  assert.ok(!robotsAllows(star, "/private/x"));
  assert.ok(robotsAllows(star, "/private/team/priya"));
  assert.ok(!robotsAllows(star, "/index.php"));
  assert.ok(robotsAllows(star, "/index.php?x=1"));
  assert.ok(robotsAllows(parseRobots("User-agent: *\nDisallow:"), "/anything"));
});

test("sitemaps: urlsets with lastmod, and indexes of sitemaps", () => {
  const set = parseSitemap(`<?xml version="1.0"?><urlset>
    <url><loc>https://acme.in/trainers</loc><lastmod>2026-09-01</lastmod></url>
    <url><loc><![CDATA[https://acme.in/a?x=1&amp;y=2]]></loc></url></urlset>`);
  assert.deepEqual(set.locs, [
    { url: "https://acme.in/trainers", lastmod: "2026-09-01" },
    { url: "https://acme.in/a?x=1&y=2", lastmod: undefined },
  ]);
  const idx = parseSitemap(`<sitemapindex><sitemap><loc>https://acme.in/page-sitemap.xml</loc></sitemap></sitemapindex>`);
  assert.deepEqual(idx.children.map((c) => c.url), ["https://acme.in/page-sitemap.xml"]);
  assert.equal(idx.locs.length, 0);
});
