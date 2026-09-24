# LeadMine v2: finding leads beyond what Google shows

Goal: stop treating a search engine as the only source of truth. Build a small
discovery layer that finds people and companies in places Google ranks badly
or leaves out, and records **why** each one is a lead.

This folder is standalone research. It is not part of the PowPow gateway or the
LeadMine extension yet.

The starting point was a shortlist of seven repositories and a proposed
"LeadMine v2" architecture. This README checks that shortlist against what the
repositories actually contain. Then it records what Common Crawl can and cannot
do for LeadMine, and sets out a plan scaled for one person running LeadMine.
A second, longer shortlist followed, focused on crawl frontiers, entity
resolution and active learning. §6 checks it and §7 builds the experiment it
ended with.

| File | What it is |
|---|---|
| `cc-discover.mjs` | Common Crawl only: seed sites → their captured pages → contacts, LinkedIn links, a frontier of related domains (§3) |
| `experiment.mjs` | The measurement: Google results → best-first crawl across Common Crawl, Wayback, sitemaps, CT subdomains and live pages → resolved people → how many Google did not return (§7) |
| `lib/frontier.mjs` | The lead-specific crawl frontier: six-part score, per-host politeness, evidence feedback |
| `lib/resolve.mjs` | People from pages, and the same person across pages |
| `lib/sources.mjs` | Serper, Common Crawl, Wayback, crt.sh, robots.txt, sitemaps, live fetch |
| `test/` | `node --test test/*.test.mjs`: 22 tests, including a whole run against a fake web |

---

## 1. The shortlist, checked (2026-09-24)

| Repo | What the shortlist said | What it actually is | Verdict for LeadMine |
|---|---|---|---|
| **Common Crawl** ([org](https://github.com/commoncrawl)) | Historical web data since 2007 | Right. 53 repos: URL index, WARC/WAT/WET archives, a columnar Parquet index, web graphs, `cdx_toolkit`, `cc-downloader`. The newest crawl is **CC-MAIN-2026-34**, captured 7–20 Aug 2026. | **Use it.** It is the data source. |
| **cc-index-server** | "Common Crawl Index Server" | **Correction:** this is [`ikreymer/cc-index-server`](https://github.com/ikreymer/cc-index-server), not a Common Crawl org repo. It is a pywb deployment, meaning the code *behind* `index.commoncrawl.org`. | **Don't run it.** Call the public index at `index.commoncrawl.org` (as `cc-discover.mjs` does) or use [`commoncrawl/cdx_toolkit`](https://github.com/commoncrawl/cdx_toolkit). |
| **ccrawl-cli** ([tamnd/ccrawl-cli](https://github.com/tamnd/ccrawl-cli)) | URL search, WARC fetch, text/link extraction, host graph, BM25, REST | Right. Every claimed command exists: `search`, `get --links`, `extract`, `host`, `rank`, `index` (local BM25), `crawl`/`sched`, `api`, `db` (DuckDB), and also **`mcp`, which runs it as an MCP server**. It is written in Go under the Apache-2.0 license. It is young: created 2026-06, one maintainer, 10 stars. | **Use it as a tool, don't depend on it.** Its `mcp` mode could plug straight into the PowPow gateway. Pin a version, because a one-person project can change under you. |
| **cc-host-index** ([commoncrawl/cc-host-index](https://github.com/commoncrawl/cc-host-index)) | Host/web-graph intelligence: "known trainer site → related hosts" | **Partly wrong.** It has one row per host per crawl with crawl counts, language share and **rank** (harmonic centrality, PageRank). It has **no edges**, so it cannot say which hosts are *related*. It is marked "testing v2, will change", is about 7 GB per crawl, and a single-host lookup takes minutes, because Parquet is slow for point lookups. | **Use it only as a filter** ("skip hosts with rank < X"). For *related hosts* use the host-level graph ([`cc-webgraph`](https://github.com/commoncrawl/cc-webgraph), [`web-graph-embeddings`](https://github.com/commoncrawl/web-graph-embeddings), new 2026-09), or the outlinks on pages you already fetched, which is what `cc-discover.mjs` does. |
| **Apache StormCrawler** ([apache/stormcrawler](https://github.com/apache/stormcrawler)) | Scalable frontier/crawler architecture | Right, and it is mature. It needs Java plus an Apache Storm cluster. Common Crawl's own [`news-crawl`](https://github.com/commoncrawl/news-crawl) runs on it. | **Study it, don't deploy it.** Borrow these patterns: per-host queues, a status index (DISCOVERED / FETCHED / ERROR / REDIRECTION), sitemap discovery, and refetch intervals. LeadMine's volume fits in one Node process. |
| **Trafilatura** ([adbar/trafilatura](https://github.com/adbar/trafilatura)) | Page → clean text + metadata | Right. It is the reference extractor (6.8k stars) and is written in Python. Ports exist in [Go](https://github.com/markusmobius/go-trafilatura) and [Rust](https://github.com/Murrough-Foley/rs-trafilatura), plus a [Node binding](https://github.com/gorango/napi-rs-trafilatura). | **Use it when clean body text starts to matter**, for LLM qualification. For contacts it is the wrong tool: it deliberately drops headers, footers and link lists, and that is where emails, phones and LinkedIn links live. So extract contacts from raw HTML first, then run it for the body text. |
| **OpenSearch** ([opensearch-project/OpenSearch](https://github.com/opensearch-project/OpenSearch)) | Your own searchable lead/document index | Right. It is a distributed REST search engine under the Apache-2.0 license, running on the JVM and needing about 2 GB+ RAM per node. | **Not yet.** For one user and fewer than a million documents, **SQLite FTS5** (built into Node 22 as `node:sqlite`) or DuckDB full-text search does the same job with zero servers. Move to OpenSearch when several people share one corpus, or it outgrows one disk. |
| **OpenOutFind** ([eracle/OpenOutFind](https://github.com/eracle/OpenOutFind)) | Qualification architecture | Right. Discovery runs on a licensed provider (BetterContact), then an LLM judges each person against the ideal customer profile (ICP) and writes down **why**. Deliberately there is no score column, because the model's confidence is only a spend gate. **It is GPL-3.0.** | **Copy the idea, not the code.** LeadMine is MIT, and pasting GPL code into it would force a relicense. The ideas worth taking are the reason-per-lead column, the refusal to show an uncalibrated score, and spending paid lookups only on the best fits. |

## 2. What Common Crawl can and cannot do here

| # | Finding | What it means for LeadMine |
|---|---|---|
| 1 | **LinkedIn blocks Common Crawl.** Its robots.txt allows named search engines only and says any other automated access needs permission. CCBot obeys robots.txt, and a 2026-06 survey lists LinkedIn among the sites that disallow CCBot. | Common Crawl will **not** find LinkedIn profiles or posts. The Posts and LinkedIn sources stay necessary. Common Crawl's job is **the rest of the web**: trainer sites, "our trainers" pages, speaker pages, training companies. Those pages *link to* LinkedIn profiles, and those links are the bridge (see §4). |
| 2 | **The newest data is 5–7 weeks old.** The latest crawl (CC-MAIN-2026-34) ended on 2026-08-20. | It is useless for intent, meaning "needs a trainer this week". That remains the Posts source's job. It is fine for **evergreen** facts: who trains what, who spoke where, who works at which company. |
| 3 | **CCBot does not run JavaScript.** | A site built as a single-page app may be captured as an empty shell. When a host's pages come back with no text, it is a candidate for LeadMine's own live fetch. |
| 4 | **Each host gets a crawl budget.** | A small site may be only partly captured: the homepage, but not `/trainers`. Querying the newest 2–3 crawls together (`--crawls`) fills most gaps. |
| 5 | **Old captures are a feature.** | A trainer page that has since been deleted is still in older crawls. That tells you a person trained there once, which is evidence the live web no longer shows. |
| 6 | **The public index is shared and often slow** (503s). It is the busiest part of the service. | Be polite: one request at a time, a delay between requests, and backoff on 429/503. `cc-discover.mjs` does all three. For bulk questions ("every page with *trainer* in the path under `.in`"), the columnar Parquet index via DuckDB is the right tool, not thousands of index calls. |
| 7 | **Fetching a page costs one HTTP range request.** Each WARC record is its own gzip member, so a byte slice decompresses on its own. | There is no need to download whole archive files, and the live site never sees the visit. |

## 3. The prototype: `cc-discover.mjs`

```
 seeds ─┬─ --seed / --seeds hosts.txt
        ├─ --seeds leadmine-export.csv   (the "Website" column of a Maps run)
        └─ --query "…"                   (Google via Serper, platforms removed)
                 │
                 ▼
  Common Crawl URL index, newest N crawls, host + subdomains
                 │
                 ▼
  keep HTML 200s, newest capture per URL, rank: homepage, then
  trainers / speakers / team / about / contact / training / events pages
                 │
                 ▼
  byte-range fetch of each WARC record  →  gunzip  →  WARC + HTTP parse
                 │
                 ▼
  extract from raw HTML: title, description, emails (mailto + text),
  phones (tel: + Indian mobile / +CC), linkedin.com/in|company links,
  schema.org JSON-LD Person / Organization / Event / Course,
  term hits, outside hosts linked to
                 │
                 ├──► <out>-pages.csv    one row per page, the evidence
                 ├──► <out>-pages.jsonl  the same plus full text, for an LLM or an index
                 └──► <out>-frontier.csv outside domains ranked by how many
                                          *different* seed hosts link to them
                                                   │
                                     --hops 1 ─────┘ visit the top --hop-hosts of them
```

The frontier ranks a domain by the number of **different** seed hosts linking
to it, not by raw link count. One link is often a footer badge. Three
independent trainer sites linking to the same conference or training company
means it belongs in the same neighbourhood. This is the shortlist's
"known lead → links → new company" loop, and it needs no web-graph download.

### Run it

```bash
cd research/leadmine-v2-discovery

node cc-discover.mjs --selftest                       # offline checks, no network
node cc-discover.mjs --seed acme-training.in --print-plan   # the index queries it would make

node cc-discover.mjs --seed acme-training.in,qa-trainer.example --out qa
node cc-discover.mjs --seeds ~/Downloads/leadmine-training-institutes-chennai.csv --hops 1
SERPER_API_KEY=xxx node cc-discover.mjs --query "QA automation corporate trainer India" --hops 1
```

Flags: `--crawls N` (default 2), `--pages N` (records per host, default 12),
`--hops 0|1`, `--hop-hosts N` (default 10), `--rate ms` (default 1000),
`--terms a,b,c` (words counted per page), `--out prefix`.

It takes about `hosts × (crawls + pages) × rate`, so 20 hosts at the defaults
is roughly 5 minutes. That is deliberate: see finding 6.

### Status

- The offline self-test passes. It covers index-record selection, WARC record
  parsing (a real gzip member round-trip), and extraction of emails, phones,
  LinkedIn links, JSON-LD and outlinks. It also covers frontier ranking and
  reading seeds from a LeadMine CSV.
- **It has not been run against live Common Crawl.** The environment it was
  written in blocks `index.commoncrawl.org` and `data.commoncrawl.org`.
  `collinfo.json` was read through another tool to confirm the crawl ids and
  the index URL shape. Treat the first live run as the real test. If the
  index's JSON fields differ from `url`, `status`, `mime-detected`,
  `filename`, `offset` and `length`, then `pickCaptures` and `fetchRecord` are
  the two places to fix.

## 4. The architecture, sized for one person

The shortlist's v2 diagram is the right shape. What changes is the weight of
each box.

```
                         query / ICP description
                                   │
                   ┌───────────────┼──────────────────┐
                   ▼               ▼                  ▼
            LeadMine today    Common Crawl        own live fetch
        (Maps, People, Web,  (cc-discover.mjs:   (later: sitemaps and
         Posts: recency)      depth, history,     SPA hosts CC shows
                              frontier)           as empty, from the frontier)
                   └───────────────┼──────────────────┘
                                   ▼
                    documents: url, crawl date, raw HTML
                                   │
                  contacts from raw HTML  ·  body text via Trafilatura
                                   ▼
                        entities + evidence edges
                                   │
                   SQLite FTS5 now  →  OpenSearch only if shared/huge
                                   ▼
               qualification: LLM vs ICP, a sentence of "why" per lead
                                   ▼
                     LeadMine's existing CSV / cards
```

### The evidence graph is the product

Every edge carries the page that proves it and the date that page was seen:

```
PERSON  ──works_at──►  COMPANY        (JSON-LD worksFor, "… at X" headline, email domain)
        ──teaches───►  SKILL          (term hits on a trainers page)
        ──spoke_at──►  EVENT          (name on a /speakers page)
        ──owns──────►  WEBSITE        (personal domain; LinkedIn sameAs)
        ──profile───►  linkedin.com/in/…
COMPANY ──offers────►  TRAINING       (/corporate-training, Course JSON-LD)
        ──linked_by─►  COMPANY        (frontier: outlinks between hosts)
```

Entity resolution needs join keys that already exist in the data:

1. **The LinkedIn profile URL** is the strongest one. The same `/in/slug` found on a
   trainer's website, in a Public-web row, and in a People-search row is one
   person. This is how Common Crawl evidence attaches to LinkedIn people even
   though Common Crawl cannot see LinkedIn.
2. **The email domain → registered domain** links a person to a company site.
3. **The phone number**, normalised to E.164, links a Maps business to a
   trainer page.
4. **A name plus a company** is the weakest key. Only merge on it when one of
   the keys above agrees.

"Why this lead" then writes itself from the edges: *"Listed as QA Automation
Trainer on acme-training.in/our-trainers (Aug 2026); spoke at testconf.in 2025;
LinkedIn linked from both."* That sentence is OpenOutFind's best idea, built
from evidence LeadMine collected itself.

## 5. Plan

| Phase | What | Built with | Done when |
|---|---|---|---|
| **1. Now** | Run `experiment.mjs` (§7) on one real query in the trainer niche, label the review sheet, and record X, new, Z and F here the way `linkedin-recent-posts` records its findings. Run the breadth-first control too. | This folder | There are numbers for one real run, and a yes or no on "does expansion find relevant leads Google missed?" |
| **2** | A local corpus: load the `documents / people / evidence / relationships` JSONL into SQLite with FTS5. *(The schema exists: §7.)* | `node:sqlite` | "Show everyone linked to testconf.in" is one query. |
| **3** | Qualification: an LLM reads each candidate's evidence against a one-paragraph ICP and writes the reason. No score column. | PowPow's model config | Every exported lead has a `reason` a human can disagree with. |
| **4** | Own live fetch for the top frontier hosts: `sitemap.xml` first, then only the pages of the kinds in §3. It fills the gaps from finding 3 and finding 4. | StormCrawler patterns, not StormCrawler | The frontier's SPA hosts have text. |
| **5. Maybe** | OpenSearch, when the corpus is shared or outgrows SQLite. ccrawl's `mcp` mode inside the PowPow gateway, so a chat channel can ask "who trains Playwright in Chennai?". | OpenSearch, ccrawl-cli | There is a second user. |

Rules carried over from LeadMine: a model proposes and never decides (the
planner rule in `leadmine/DESIGN.md`). Rows are set aside with a reason, never
silently dropped. Every figure in the UI says where it came from.

## 6. The second shortlist, checked (2026-09-24)

| Repo | Claimed | Found | Verdict |
|---|---|---|---|
| **DeepSearch** | A self-hosted engine for resources mainstream search misses: recursive crawler, open directories, sitemaps, CT subdomains, Wayback, Meilisearch/SQLite FTS, plugins | **Not found as described.** Searches for it turned up only different projects: [`sukirman1901/DeepSearch`](https://github.com/sukirman1901/DeepSearch), an MCP server over 7 sources with ChromaDB and no CT or Wayback. [`Trafexofive/DeepSearchStack`](https://github.com/Trafexofive/DeepSearchStack), which runs search → scrape → embed with SQLite FTS5. [`Reload-Apps/deepsearch-mcp`](https://github.com/Reload-Apps/deepsearch-mcp), a hosted person-footprint lookup. | **Need the exact link.** The pattern it describes (several discovery sources feeding one own index) is what `experiment.mjs` now implements, minus open directories. |
| **url-frontier** ([crawler-commons](https://github.com/crawler-commons/url-frontier)) | A language-neutral frontier API | Confirmed: gRPC API plus a Java reference implementation, 65 stars. | **Borrowed the model**, not the service: URL states, per-host queues, a next-allowed time per host (`lib/frontier.mjs`). |
| **Frontera** ([scrapinghub/frontera](https://github.com/scrapinghub/frontera)) | The frontier as the crawl's policy engine | Confirmed: Python, BSD-3, 1.3k stars. Built-in strategies are breadth-first, depth-first and Discovery (robots.txt plus sitemaps). | **Reference design.** Its "strategy decides priority, backend stores it" split is the split between `score()` and the queue. |
| **crawl4go** ([ronxldwilson/crawl4go](https://github.com/ronxldwilson/crawl4go)) | BFS/DFS/best-first/adaptive, URL scoring, sitemaps, BM25 | Confirmed. It is a Go rewrite of [Crawl4AI](https://github.com/unclecode/crawl4ai). Its URL scorer weighs keywords, freshness and depth. **But** it is built around headless Chromium, a rotating Tor proxy pool and anti-bot detection, which is tooling for getting past sites that block crawlers. | **Study the strategies; leave the evasion half.** Its scorer is a subset of the six-part score here. Crawl4AI's own URL seeder takes `source="sitemap+cc"`, the same "sitemap plus Common Crawl" idea as this folder. |
| **NetNeighbors** ([PeterCarragher](https://github.com/PeterCarragher/NetNeighbors)) | Seed domains → related domains through the Common Crawl web graph | Confirmed, as a demo notebook with 0 stars. It is backed by two peer-reviewed papers (ICWSM 2024, ACM TIST 2025) on finding related sites through backlinks and outlinks. It needs a host-level web graph loaded locally, and its example uses the 2024 graph. | **The right idea for backlinks**, meaning *who links to* a known trainer site. Page outlinks, which `experiment.mjs` already follows, cannot give that. It is the next source to add, once a run shows outlinks are not enough. |
| **Certificate Transparency** | A company → its other public surfaces | Agreed. Implemented through crt.sh, **only for the seed companies**, and only subdomains whose label suggests people (`academy.`, `training.`, `events.`, `careers.` …). crt.sh is often slow. | In `experiment.mjs` as source `crt`. |
| **Wayback Machine** | Recovering pages that are gone | Agreed. Implemented through the Wayback CDX API plus raw `id_` captures. **Every Wayback document is marked `historical`**, and so is any capture over a year old. A person seen only there is flagged `historical_only` and never shown as current. | In `experiment.mjs` as source `wayback`. |
| **landermixer** ([ShapeStudio](https://github.com/ShapeStudio/landermixer)) | Name + company → public-web research; every fact carries a source; never guesses | Confirmed: MIT, TypeScript. An agent runs up to 15 web searches per prospect, anchored on a LinkedIn URL or on `--name` + `--company`, and "never invents a profile URL". | **Adopted the discipline**: a claim without a page and a date is not stored, and a LinkedIn link whose anchor is an icon gives a profile but no name (`lib/resolve.mjs`). The tool itself is *enrichment* at up to 15 searches per person, so it belongs after qualification, not in discovery. |
| **OXORAY** ([Anurag-M1](https://github.com/Anurag-M1/OXORAY)) | Active learning: GP on embeddings, explore/exploit, BALD | It exists (2 stars), and its README closely mirrors OpenOutFind's. It drives a **logged-in LinkedIn account with "stealth browser automation"** and sends connection requests and follow-up messages on its own. | **Take nothing from it.** That is the account-ban failure LeadMine's README warns about, plus detection evasion. The active-learning idea is in OpenOutFind, whose README says the loop "is not yet shown to beat picking at random". So it is an experiment, not a known optimisation. Its prerequisite is labelled examples, which the review sheet in §7 produces. |
| **node-canon** ([rasinmuhammed](https://github.com/rasinmuhammed/node-canon)) | Entity resolution with blocking, fingerprints, abbreviations and topology | Confirmed: Python, 0 stars. Its benchmark is self-reported on its own test set. | **Borrowed** blocking and abbreviation matching. **Deferred** topology: shared neighbours are worth adding once real runs show which duplicates survive. |
| **embabel/dice** | Documents → entities → resolution → knowledge graph | Confirmed: Kotlin (JVM), 38 stars. | Design reference. The four-table schema in §7 is that pipeline without a graph database. |
| **Fess** ([codelibs/fess](https://github.com/codelibs/fess)) | Crawler → indexer → OpenSearch → API | Confirmed: Java, Apache-2.0, 1.1k stars. | Same verdict as OpenSearch in §1: study it, and don't run it for one user. |
| **DawnSearch** ([dawn-search](https://github.com/dawn-search/dawnsearch)) | Semantic search over Common Crawl | Confirmed: Rust, 14 stars, last updated 2026-02. | Not a dependency. Semantic retrieval waits until there are labelled examples to test it against. |
| **linkedin-leadgen** | Browser → LinkedIn DOM → Claude scoring → SQLite | No repository by that name was found. | Unverified. The shape described is LeadMine's LinkedIn source plus a scorer. |
| **Neo4j entity-resolution example** | Records → one real-world entity | Not checked. | — |

Two notes on the research framing:

- **"Unique additional leads = Y − X" is not the number.** Y already contains X, and
  a person can also be in an earlier LeadMine export. The experiment counts
  *new* as the people in neither set, after resolution. **Z and F cannot be
  computed by a script**: "relevant" is a human judgement, so the run writes
  a review sheet and `--score` reads the labels back.
- **Evidence-driven, best-first crawling has a long history as "focused crawling"**
  (Chakrabarti, van den Berg and Dom, 1999, and much work since). What is specific
  here is the target, *people who fit an ICP*, and the evidence that drives
  the frontier. That is the part to test and write up; the loop itself is
  prior art.

## 7. The experiment: `experiment.mjs`

This builds the test proposed at the end of the second shortlist. It changes one
thing: the seeds are **whatever Google returns**, not 20 hand-picked leads, so
that "not in the Google set" has an exact meaning.

```
 Google (Serper) results ──► frontier (hop 0)        --seed / --seeds sites ──► frontier (hop 0)
                                     │
                    best-first pop: highest score whose host may be hit now
                                     │
          first time a site is reached: expand it from
          cc (captures) · wayback (captures) · sitemap (lastmod) · crt (seed companies only)
                                     │
          fetch: CC capture → Wayback capture → live page (robots.txt honoured)
                                     │
          extract → person candidates, each with claim · page · date · confidence
                                     │
          links queued with anchor text, parent title, parent evidence, hop+1 if off-site
          host's evidence per page updates the score of everything queued on that host
                                     │
          resolve → people → in the Google set? in the --baseline export? neither = new
```

### The frontier's score

A URL is scored **before** it is fetched, so each part is a prediction from
what is known at that moment. Each part is in [0, 1], and the score is their
weighted average.

| Part | Weight | Computed from |
|---|---|---|
| relevance | 0.30 | query words in the link's anchor text, its path and the linking page's title |
| entity | 0.20 | the path or anchor looks like trainers, speakers, team or about (1), another useful kind (0.5), a homepage (0.4) |
| proximity | 0.15 | 1/(1 + hops from a seed), plus a bonus per extra seed site that links to the host |
| evidence | 0.15 | people and relevance found on the page that linked here (the feedback loop) |
| freshness | 0.10 | capture date or sitemap lastmod; 0 at three years old, 0.5 when unknown |
| quality | 0.10 | the host's evidence per page fetched so far; 0.5 before the first fetch |

The weights are starting guesses, as the proposal said. So the report
checks them: fetched pages are split into fifths by their score before fetching,
next to how much evidence each fifth actually held. For a control, run the same
query with `--weights proximity=1,relevance=0,entity=0,evidence=0,freshness=0,quality=0`,
which is breadth-first. If the scored run does not find more new relevant
people for the same `--max-pages`, the score is not earning its complexity.

### The schema

The run writes the four tables proposed, as JSONL, ready for SQLite in phase 2:

| File | One row per | Key fields |
|---|---|---|
| `-documents.jsonl` | fetched page | url, source (`cc`/`wayback`/`live`), via (`google`/`seed`/`link`/`cc`/`wayback`/`sitemap`/`crt`), hop, observedAt, historical, contentHash, predictedScore and its parts, evidence found, text |
| `-people.jsonl` | resolved person | person_id (from the strongest key, so re-runs keep it), names[], profiles[], emails[], phones[], orgs[], firstSeen, lastSeen, historicalOnly, inGoogleSet, inBaseline, isNew, foundVia |
| `-evidence.jsonl` | claim | person_id, document_id, url, claim, confidence, observed_at, historical |
| `-relationships.jsonl` | edge | `MENTIONED_IN`, `WORKS_AT`, `SPEAKS_AT`, `TEACHES`, `PROFILE`, org `LINKS_TO` org, each with the document that shows it |

Resolution merges on a LinkedIn slug or a personal email. It merges on a full name
only within one organisation's domain, and on an abbreviation ("A. Sharma") only
when exactly one full name in that organisation fits. A false merge sends one
person's pitch to another, so the resolver would rather leave a duplicate.

### Run it

```bash
cd research/leadmine-v2-discovery
node --test test/*.test.mjs                                  # 22 tests, offline

SERPER_API_KEY=xxx node experiment.mjs --query "QA automation corporate trainer Chennai" \
  --baseline ~/Downloads/leadmine-public-web.csv --max-pages 300 --out qa
# … label the "relevant" column of qa-review.csv (y/n; a sample is fine), then:
node experiment.mjs --score qa-review.csv

# the breadth-first control, same budget
SERPER_API_KEY=xxx node experiment.mjs --query "QA automation corporate trainer Chennai" \
  --weights proximity=1,relevance=0,entity=0,evidence=0,freshness=0,quality=0 --max-pages 300 --out qa-bfs

# archives only: no request ever reaches the sites themselves
SERPER_API_KEY=xxx node experiment.mjs --query "…" --sources cc,wayback
```

Flags: `--sources cc,wayback,crt,sitemap,live` (all by default), `--max-pages 300`,
`--per-host 15`, `--hops 2` (how far off the seed sites), `--crawls 2`,
`--rate 1000` (ms between hits on one host), `--google-pages 2`, `--weights k=v,…`,
`--baseline export.csv` (LeadMine People, Public web or Posts export), `--out prefix`.

Live fetching identifies itself as `LeadMineResearch/0.1` with this repository's
URL, obeys robots.txt (a 5xx robots.txt means "do not crawl", per RFC 9309),
never runs more than one request at a time, and fetches only HTML. LinkedIn and
other platforms are never crawled. A LinkedIn link on a page is recorded as
evidence and not followed. The output files hold personal data and are
git-ignored in this folder.

### Status

- The 22 offline tests pass. `test/experiment.test.mjs` runs the whole
  pipeline against a seven-page fake web. It checks that a person on a Google
  result, on a Common Crawl capture and on a conference page resolves to one
  person. It checks that the new people are exactly those reached by a link,
  a CT subdomain and a Wayback capture, that the Wayback one is flagged
  historical, that the trainers page is fetched before the blog post, and that
  switching live off reads only archives.
- **It has not been run against the real web.** This environment's network
  policy blocks Common Crawl, the Wayback Machine, crt.sh and ordinary sites.
  A smoke run confirmed that the failure path records the reason
  (`live 403`) and still writes the report. The first real run is the test
  that matters.
- **Not built yet:** embeddings or semantic filtering (relevance is lexical
  until labels exist to test against), web-graph backlinks (NetNeighbors), LLM
  qualification, and active learning. Each waits on the first run's labels.

## Sources

- Common Crawl crawls and index: https://index.commoncrawl.org/collinfo.json (read 2026-09-24)
- CCBot and robots.txt: https://commoncrawl.org/ccbot, https://commoncrawl.org/faq
- LinkedIn robots.txt: https://www.linkedin.com/robots.txt
- Sites that block CCBot (June 2026): https://ustechautomations.com/resources/blog/who-blocks-common-crawl-ccbot-2026
- cc-host-index schema and caveats: https://github.com/commoncrawl/cc-host-index
- ccrawl-cli commands: https://github.com/tamnd/ccrawl-cli
- OpenOutFind (GPL-3.0): https://github.com/eracle/OpenOutFind
- cc-index-server (pywb deployment): https://github.com/ikreymer/cc-index-server
- Second shortlist: https://github.com/crawler-commons/url-frontier, https://github.com/scrapinghub/frontera,
  https://github.com/ronxldwilson/crawl4go, https://github.com/unclecode/crawl4ai,
  https://github.com/PeterCarragher/NetNeighbors, https://github.com/ShapeStudio/landermixer,
  https://github.com/Anurag-M1/OXORAY, https://github.com/rasinmuhammed/node-canon,
  https://github.com/embabel/dice, https://github.com/codelibs/fess, https://github.com/dawn-search/dawnsearch
- Wayback CDX API: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server
- robots.txt: RFC 9309, https://www.rfc-editor.org/rfc/rfc9309
- Focused crawling: Chakrabarti, van den Berg, Dom, "Focused crawling: a new approach to topic-specific Web resource discovery", WWW 1999
