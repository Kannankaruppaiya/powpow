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
`cc-discover.mjs` is a working first step.

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
| **1. Now** | Run `cc-discover.mjs` on the websites from a real LeadMine Maps export ("corporate training institutes, Chennai"). Measure how many hosts have captures, how many pages yield a contact, and what the frontier looks like. | This folder | There are numbers for one real run, recorded in this README the way `linkedin-recent-posts` records its findings. |
| **2** | A local corpus: write `-pages.jsonl` into SQLite with FTS5, and add a `people` table keyed on LinkedIn URL / email / phone. | `node:sqlite` | "Show everyone linked to testconf.in" is one query. |
| **3** | Qualification: an LLM reads each candidate's evidence against a one-paragraph ICP and writes the reason. No score column. | PowPow's model config | Every exported lead has a `reason` a human can disagree with. |
| **4** | Own live fetch for the top frontier hosts: `sitemap.xml` first, then only the pages of the kinds in §3. It fills the gaps from finding 3 and finding 4. | StormCrawler patterns, not StormCrawler | The frontier's SPA hosts have text. |
| **5. Maybe** | OpenSearch, when the corpus is shared or outgrows SQLite. ccrawl's `mcp` mode inside the PowPow gateway, so a chat channel can ask "who trains Playwright in Chennai?". | OpenSearch, ccrawl-cli | There is a second user. |

Rules carried over from LeadMine: a model proposes and never decides (the
planner rule in `leadmine/DESIGN.md`). Rows are set aside with a reason, never
silently dropped. Every figure in the UI says where it came from.

## Sources

- Common Crawl crawls and index: https://index.commoncrawl.org/collinfo.json (read 2026-09-24)
- CCBot and robots.txt: https://commoncrawl.org/ccbot, https://commoncrawl.org/faq
- LinkedIn robots.txt: https://www.linkedin.com/robots.txt
- Sites that block CCBot (June 2026): https://ustechautomations.com/resources/blog/who-blocks-common-crawl-ccbot-2026
- cc-host-index schema and caveats: https://github.com/commoncrawl/cc-host-index
- ccrawl-cli commands: https://github.com/tamnd/ccrawl-cli
- OpenOutFind (GPL-3.0): https://github.com/eracle/OpenOutFind
- cc-index-server (pywb deployment): https://github.com/ikreymer/cc-index-server
