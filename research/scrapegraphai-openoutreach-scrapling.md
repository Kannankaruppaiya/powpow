# ScrapeGraphAI · OpenOutreach · Scrapling — how each one works

A deep read of three open-source projects: what each one does, how a request moves through it,
and where it could fit in PowPow. Everything here comes from reading the source code, not only the
READMEs.

| Repo | Commit read | Version | License | Language |
|---|---|---|---|---|
| [ScrapeGraphAI/Scrapegraph-ai](https://github.com/ScrapeGraphAI/Scrapegraph-ai) | `c75c808` (2026-09-07) | 2.2.4 | MIT | Python |
| [eracle/OpenOutreach](https://github.com/eracle/OpenOutreach) | `b8bb2e3` (2026-09-07) | 0.1.x | GPL-3.0 | Python / Django |
| ↳ [eracle/OpenOutFind](https://github.com/eracle/OpenOutFind) (finder, pinned child) | `417257b` (2026-09-23) | 0.1.x | GPL-3.0 | Python / Django |
| ↳ [eracle/OpenOutSend](https://github.com/eracle/OpenOutSend) (sender, pinned child) | `38e0051` (2026-09-08) | 0.1.x | MIT | Python / Django |
| [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling) | `0b85f7e` (2026-09-23) | 0.4.15 | BSD-3-Clause | Python |

> **Note on OpenOutreach:** the current repository contains no pipeline of its own. It is an
> *orchestrator* over two packages it pins exactly, **OpenOutFind** (find + qualify leads) and
> **OpenOutSend** (email them). Both were read too, because that is where the real flow lives.
> Older OpenOutreach releases automated LinkedIn with a browser (Playwright). **That design has been
> removed**: the current tool is browserless, uses no social-network account and scrapes nothing.

---

## 0. Summary

| | **ScrapeGraphAI** | **Scrapling** | **OpenOutreach** |
|---|---|---|---|
| One-line idea | "Tell an LLM what you want from a page, and it returns JSON" | "A fast, adaptive, stealthy scraper + crawler framework" | "Describe your product → AI finds fitting B2B people, explains why, emails them" |
| Where the intelligence is | LLM does the extraction (prompt → structured answer) | Algorithms: similarity scoring, fingerprinting, auto-throttle. No LLM needed | LLM (ICP, qualification, email writing) + a Gaussian Process active-learning model |
| Core abstraction | **Graph of nodes** sharing one `state` dict | **Selector** (parser) + **Fetchers/Sessions** + **Spider** engine | **Deal state machine** + a bounded **job loop** + a JSON Lines **pipe** from finder to sender |
| Input | URL / local HTML / PDF / CSV / JSON / XML / MD + natural-language prompt | URL(s), CSS/XPath selectors, spider callbacks | A product description + target-market description |
| Output | Python dict (optionally matching a Pydantic schema) | `Response`/`Selector` objects, items → JSON/JSONL/CSV/XML | CSV/JSON Lines of qualified leads (+ `reason`), then real emails sent |
| Fetching | Playwright Chromium (default), undetected-chromedriver, BrowserBase, Scrape.do, Plasmate, `requests` | `curl_cffi` (TLS impersonation), Playwright, Patchright (stealth), CDP remote browsers | None. Data comes from licensed APIs (BetterContact, optionally Apollo) |
| Anti-bot | Delegated to loaders/proxies | Built in: Cloudflare Turnstile solver, browser fingerprints, proxy rotation, DoH | Not applicable (no scraping) |
| Best at | Messy pages where writing selectors is painful; one-off extraction | Scale, speed, resilience to layout changes, protected sites | End-to-end lead generation → cold outreach with compliance guards |
| Cost per page | LLM tokens (can be large) | CPU/bandwidth only | LLM tokens + 1 BetterContact credit per verified email |

**Mental model:** Scrapling **gets** the page reliably, ScrapeGraphAI **understands** the page
with an LLM, and OpenOutreach is a **business pipeline** (find → qualify → enrich → email) that
uses APIs instead of scraping.

---

# 1. ScrapeGraphAI

## 1.1 What it is

A Python library that builds **scraping pipelines as directed graphs**. Each node does one job
(fetch, parse, chunk, ask the LLM, merge). You give it a **prompt** and a **source**, and it returns
a dict:

```python
from scrapegraphai.graphs import SmartScraperGraph

graph = SmartScraperGraph(
    prompt="List the founders and their LinkedIn URLs",
    source="https://scrapegraphai.com/",
    config={"llm": {"model": "openai/gpt-4o-mini", "api_key": "..."}},
    schema=None,            # optional Pydantic model for typed output
)
print(graph.run())          # -> dict
```

Install: `pip install scrapegraphai && playwright install`.
Built on **LangChain** (`init_chat_model`, `PromptTemplate`, `RunnableParallel`), **Playwright**,
**html2text**, **semchunk**, **tiktoken**, **ddgs** (DuckDuckGo search).

## 1.2 The three building blocks

```
AbstractGraph (per use case: SmartScraperGraph, SearchGraph, ...)
   │  builds the LLM client, reads config, calls _create_graph()
   ▼
BaseGraph  (the executor: nodes + edges + entry point)
   │  walks node → node, passing ONE shared `state` dict
   ▼
BaseNode subclasses (FetchNode, ParseNode, GenerateAnswerNode, ...)
      each node: reads keys from state → does work → writes keys back to state
```

### `AbstractGraph` (`graphs/abstract_graph.py`)

Runs when a graph is constructed:

1. **`_create_llm(config["llm"])`**
   - `"model": "openai/gpt-4o-mini"` is split into provider `openai` and model `gpt-4o-mini`. A bare
     model name makes it look up the provider in `helpers/models_tokens.py`.
   - Supported providers: openai, azure_openai, google_genai, google_vertexai, ollama, groq,
     anthropic, bedrock, mistralai, hugging_face, fireworks, deepseek, ernie, nvidia, oneapi,
     togetherai, xai, minimax, clod.
   - **Context window** (`model_tokens`) comes from the same table. If it is unknown, it **falls
     back to 8192 with only a warning** and sets `self.model_tokens_defaulted = True`. This matters
     because the window decides the chunk size (see ParseNode).
   - Optional `rate_limit: {requests_per_second, max_retries}` becomes a LangChain
     `InMemoryRateLimiter`.
   - `model_instance` lets you pass your own LangChain chat model (you must also set
     `model_tokens`).
2. Reads the common config: `verbose`, `headless` (default True), `loader_kwargs`, `cache_path`,
   `browser_base`, `scrape_do`, `storage_state` (Playwright cookies), `timeout` (default 480 s).
3. Calls the subclass's **`_create_graph()`**, which returns a `BaseGraph`.
4. **`set_common_params`** pushes `llm_model`, `headless`, `timeout` and the rest into every node's
   config.
5. With `burr_kwargs` set, execution goes through **Burr** (a state-machine/observability UI)
   instead of the plain loop.

`run()` builds the initial state `{"user_prompt": prompt, <input_key>: source}` and calls
`graph.execute()`. It returns `final_state["answer"]`.

### `BaseGraph` (`graphs/base_graph.py`): the execution loop

```
current = entry_point
while current:
    node   = nodes[current]
    result = node.execute(state)          # inside a token/cost callback
    record {node_name, total_tokens, prompt_tokens, completion_tokens, cost_USD, exec_time}
    if node is ConditionalNode: current = result      # the node returns the next node's name
    else:                       current = edges[current]
append "TOTAL RESULT" row → return (state, exec_info)
```

- Edges are a plain `from → to` dict, so the graph is a **linear chain with optional
  conditional branches**. There is no fan-out inside one graph; parallelism comes from
  `GraphIteratorNode` (below).
- `ConditionalNode` must have **exactly two** outgoing edges (true/false). It evaluates a small
  expression (with `simpleeval`), e.g. `not answer or answer=="NA"`.
- `graph.get_execution_info()` gives per-node token and cost accounting. `prettify_exec_info()`
  formats it.
- **Telemetry:** every run (and every failure) is sent through `log_graph_execution()` to
  `https://sgai-oss-tracing.onrender.com/v1/telemetry` with an anonymous id stored in
  `~/.scrapegraphai.conf`. The payload includes the source URL, prompt, schema, model, and on
  success the parsed content and answer. **To turn it off:**
  `export SCRAPEGRAPHAI_TELEMETRY_ENABLED=false` (or `telemetry_enabled = false` in that conf file).

### `BaseNode` (`nodes/base_node.py`)

Each node declares:
- `input`: a **boolean expression over state keys**, e.g.
  `"user_prompt & (relevant_chunks | parsed_doc | doc)"`. `&` means "need both" and `|` means
  "take the first one that exists". So GenerateAnswer uses `relevant_chunks` if a RAG node ran,
  otherwise `parsed_doc`, otherwise raw `doc`.
- `output`: the list of keys it writes.
- `execute(state) -> state`.

This input expression is what lets the same node be reused in many different graphs.

## 1.3 SmartScraperGraph, the main flow step by step

```
 state = {user_prompt, url}
      │
      ▼
┌─────────────┐   doc = [Document(html or markdown)]
│  FetchNode  │──────────────────────────────┐
└─────────────┘                              │
      │ (skipped when html_mode=True)        │
      ▼                                      │
┌─────────────┐   parsed_doc = [chunk1, chunk2, ...]
│  ParseNode  │                              │
└─────────────┘                              │
      │ (only when reasoning=True)           │
      ▼                                      │
┌───────────────┐  refines the prompt / thinks first
│ ReasoningNode │                            │
└───────────────┘                            │
      ▼                                      ▼
┌────────────────────┐  answer = dict
│ GenerateAnswerNode │
└────────────────────┘
      │ (only when reattempt=True)
      ▼
┌─────────────────┐ answer empty or "NA"? ──yes──► GenerateAnswerNode (regen, with extra instructions)
│ ConditionalNode │ ──no──► END
└─────────────────┘
```

Three config flags (`html_mode`, `reasoning`, `reattempt`) select one of **8 prebuilt graph
shapes**, e.g. `(False, False, False)` = Fetch → Parse → Generate (the default).

If `llm.model == "scrapegraphai/smart-scraper"`, the whole local graph is skipped and the request
goes to the paid **ScrapeGraphAI cloud API** (`scrapegraph_py`).

### FetchNode: getting the content

The input key decides the handler:

| State key | What happens |
|---|---|
| `url` | Web fetch (below) |
| `local_dir` | The value *is* HTML text, used as-is |
| `pdf` | LangChain `PyPDFLoader` (in a thread, with timeout) |
| `csv` | `pandas.read_csv` → string |
| `json`, `xml`, `md` | Read file → one `Document` |
| `*_dir` | Passed through for multi-graphs |

Web fetch backends, in priority order:
1. `browser_base` config → **BrowserBase** cloud browser.
2. `scrape_do` config → **Scrape.do** proxy API (geo-codes, super proxies).
3. `plasmate` config → **Plasmate** loader (optional Chrome fallback).
4. Default → **`ChromiumLoader`**: Playwright Chromium (headless by default), or Selenium with
   `undetected-chromedriver` when `backend="selenium"`. Supports `storage_state` (logged-in
   cookies), retries and timeouts.
5. `use_soup=True` → plain `requests.get` + `cleanup_html`.

The HTML is **converted to Markdown** (`convert_to_md`) when the model is OpenAI/Azure or
`force=True`. Markdown is far cheaper in tokens than HTML.

### ParseNode: chunking to fit the model

- HTML mode: `Html2TextTransformer` → text, then `split_text_into_chunks(chunk_size = model_tokens - 250)`.
- Otherwise: `chunk_size = min(model_tokens - 500, 0.8 × model_tokens)` using **semchunk** with
  tiktoken counting.
- Also pulls out link and image URLs.
- A deterministic sanity check (no LLM): if **none** of the words from your prompt or schema field
  names appear anywhere in the parsed text, it logs a warning. This usually means a JS-rendered
  page, an error page or a truncated document, which is where "NA" answers come from.

### GenerateAnswerNode: map-reduce over chunks

```
if schema given     → PydanticOutputParser(schema) → format instructions in prompt
else                → TolerantJsonOutputParser, asks for {"content": ...}

if 1 chunk:
    TEMPLATE_NO_CHUNKS(content, question) → LLM → parse → answer
else:  (MAP)
    for each chunk i: TEMPLATE_CHUNKS(content=chunk_i, chunk_id=i) → LLM
    run all chunk chains in parallel (LangChain RunnableParallel)
    (REDUCE)
    TEMPLATE_MERGE(content=all_chunk_answers, question) → LLM → final answer
```

- Prompts tell the model: *"You are a website scraper… if you don't find the answer put 'NA'…
  output valid JSON, no backticks"*.
- Timeouts and JSON errors don't crash the run. They return `{"error": ..., "raw_response": ...}`.
- `additional_info` in config is prepended to every prompt, which is the hook for custom rules.

**Cost:** N chunks = N + 1 LLM calls. A long page on a small-context model gets expensive.

## 1.4 Graph catalogue

| Graph | Node chain | Use |
|---|---|---|
| `SmartScraperGraph` | Fetch → Parse → [Reasoning] → GenerateAnswer → [Conditional → Regen] | One page + prompt → JSON |
| `SmartScraperLiteGraph` | Fetch → Parse | Content only, no LLM answer |
| `SmartScraperMultiGraph` | GraphIterator(SmartScraper × N) → MergeAnswers | Same prompt over many URLs, merged into one answer |
| `SmartScraperMultiConcatGraph` | GraphIterator → Conditional → Concat / Merge | Many URLs, results concatenated instead of LLM-merged |
| `SmartScraperMultiBatchGraph` | GraphIterator(Fetch+Parse only) → BatchGenerateAnswer → Merge | Batch-API style, cheaper for many pages |
| `SearchGraph` | **SearchInternet** → GraphIterator(SmartScraper) → MergeAnswers | No URL needed: search the web, scrape the top N results |
| `SearchLinkGraph` | Fetch → SearchLink | Find the relevant links on a page |
| `DepthSearchGraph` | FetchNodeLevelK → ParseNodeDepthK → Description → RAG → GenerateAnswerKLevel | Crawl links to depth K, embed into a vector store, answer with RAG |
| `OmniScraperGraph` | Fetch → Parse → ImageToText → GenerateAnswerOmni | Also describes images on the page |
| `OmniSearchGraph` | SearchInternet → GraphIterator(Omni) → Merge | Search + images |
| `ScreenshotScraperGraph` | FetchScreen → GenerateAnswerFromImage | Vision model reads a screenshot |
| `SpeechGraph` | Fetch → Parse → GenerateAnswer → TextToSpeech | Answer as an audio file (OpenAI TTS) |
| `ScriptCreatorGraph` | Fetch → Parse → GenerateScraper | Writes a Python scraper script for you |
| `ScriptCreatorMultiGraph` | GraphIterator → MergeGeneratedScripts | Script for many pages |
| `CodeGeneratorGraph` | Fetch → Parse → GenerateAnswer → PromptRefiner → HtmlAnalyzer → GenerateCode | Generates **and self-tests** extraction code |
| `DocumentScraperGraph` / `JSONScraperGraph` / `XMLScraperGraph` / `CSVScraperGraph` (+ `…Multi`) | Fetch → [Parse] → GenerateAnswer(CSV/…) | Same idea for local files |
| `MarkdownifyGraph` | Fetch → Markdownify | Page → clean Markdown |

### Multi-graphs: `GraphIteratorNode`

```
urls = [u1, u2, ..., uN]
create N copies of the inner graph class (e.g. SmartScraperGraph)
asyncio.Semaphore(batchsize=16 by default)
each copy runs graph.run() in a thread (asyncio.to_thread)
results = [answer1, ..., answerN] → MergeAnswersNode (one more LLM call) → answer
```

### SearchGraph

`SearchInternetNode` has the LLM rewrite your prompt into a search query, then calls
`search_on_web()` (DuckDuckGo by default; also Bing, SearXNG, Serper). It takes `max_results` URLs,
scrapes each one with a SmartScraperGraph, and merges the answers.

### CodeGeneratorGraph: self-correcting code

`GenerateCodeNode` runs up to four nested loops, each with its own max iterations:
1. **Syntax**: does the code parse? If not, the LLM analyses and fixes it.
2. **Execution**: run it on the reduced HTML. Did it throw?
3. **Validation**: does the output match the schema (jsonschema)?
4. **Semantic**: does the output match the LLM's own reference answer (from GenerateAnswer)?

The result is a stand-alone scraper you can run later **without an LLM**. This is a good pattern
to know: pay the LLM once, reuse the code many times.

## 1.5 Custom graphs

```python
from scrapegraphai.graphs import BaseGraph
from scrapegraphai.nodes import FetchNode, ParseNode, GenerateAnswerNode

fetch = FetchNode(input="url | local_dir", output=["doc"])
parse = ParseNode(input="doc", output=["parsed_doc"], node_config={"chunk_size": 4096, "llm_model": llm})
answer = GenerateAnswerNode(input="user_prompt & (relevant_chunks | parsed_doc | doc)",
                            output=["answer"], node_config={"llm_model": llm})

graph = BaseGraph(nodes=[fetch, parse, answer],
                  edges=[(fetch, parse), (parse, answer)],
                  entry_point=fetch)
state, info = graph.execute({"user_prompt": "...", "url": "https://..."})
```

## 1.6 Strengths and weaknesses

- ✅ No selectors to write. Survives layout changes because the LLM reads meaning, not structure.
- ✅ Works with local models (Ollama), so it can run fully offline.
- ✅ Pydantic schema gives typed output. `CodeGeneratorGraph` turns LLM work into reusable code.
- ⚠️ Every page costs tokens, is slow and is non-deterministic. LLMs can hallucinate fields.
- ⚠️ Anti-bot handling is thin (it relies on BrowserBase, Scrape.do or proxies).
- ⚠️ A silent 8192 fallback context truncates long pages. Set `model_tokens` explicitly.
- ⚠️ Telemetry is **on by default** and sends prompts and URLs. Disable it for private work.

---

# 2. Scrapling

## 2.1 What it is

An **adaptive web-scraping framework** in four layers, and **no LLM is required**:

```
┌───────────────────────────────────────────────────────────────┐
│ Spiders  (Scrapy-like crawler: scheduler, sessions, throttle, │
│           checkpoints, cache, robots.txt, templates)          │
├───────────────────────────────────────────────────────────────┤
│ Fetchers / Sessions                                           │
│   Fetcher          → curl_cffi HTTP (TLS impersonation, HTTP3)│
│   DynamicFetcher   → Playwright Chromium / Chrome             │
│   StealthyFetcher  → Patchright (patched Playwright) + CF solve│
├───────────────────────────────────────────────────────────────┤
│ Parser: Selector / Selectors (lxml + cssselect)               │
│   css / xpath / find_all / find_by_text / regex               │
│   ADAPTIVE: auto_save → relocate() when the site changes      │
├───────────────────────────────────────────────────────────────┤
│ Extras: MCP server (AI agents), CLI `extract`, IPython shell, │
│         Markdown for RAG, Scrapy integration, Docker image    │
└───────────────────────────────────────────────────────────────┘
```

Install in layers: `pip install scrapling` gives the **parser only**. `pip install "scrapling[fetchers]"`
followed by `scrapling install` adds browsers and fingerprint data. The `[ai]` extra adds the MCP
server, `[shell]` the IPython shell and `extract` CLI, and `[all]` everything.

## 2.2 The parser (`scrapling/parser.py`)

`Selector` wraps an lxml tree and gives a Scrapy/Parsel-compatible API plus BeautifulSoup-style
helpers:

```python
page.css('.quote .text::text').getall()
page.xpath('//div[@class="quote"]')
page.find_all('div', class_='quote')
page.find_by_text('quote', tag='div')
el.parent, el.next_sibling, el.below_elements(), el.find_similar()
el.generate_css_selector / generate_xpath_selector
page.markdown()          # sanitized Markdown for LLM/RAG
```

The benchmark in the README: text extraction over 5000 nested elements takes about 2 ms, roughly
the same as Parsel/Scrapy and about 780× faster than BeautifulSoup + lxml.

### Adaptive scraping: the signature feature

**Problem:** the site renames `.product` to `.item-card`, and your selector returns nothing.

**Flow:**

```
First run  (Selector created with adaptive=True):
  page.css('.product', auto_save=True)
     └─ for each matched element, save a FINGERPRINT to SQLite:
          {tag, text, attributes, path (ancestor tags), parent_name,
           parent_attribs, parent_text, siblings}
        key = (base domain of url, identifier)  ← identifier defaults to the selector string

Later run (site changed, '.product' matches nothing):
  page.css('.product', adaptive=True)
     └─ selector found nothing → load the fingerprint → relocate():
          for EVERY element in the new page:
              score = similarity(fingerprint, element)
          take the highest score; accept it if ≥ percentage (default 40%)
          return every element that shares that top score
```

**Similarity score** (`__calculate_similarity_score`): the average of these checks, as a
percentage:

| Check | How |
|---|---|
| tag equal | 1 or 0 |
| text | `difflib.SequenceMatcher` ratio |
| all attributes | 50 % key similarity + 50 % value similarity |
| `class`, `id`, `href`, `src` separately | SequenceMatcher on each, when present in the original |
| DOM path (ancestor tag chain) | SequenceMatcher |
| parent tag name, parent attributes, parent text | SequenceMatcher / dict diff |
| sibling tag list | SequenceMatcher |

Storage is `SQLiteStorageSystem`, one table `storage(url, identifier, element_data)`, and it is
pluggable through `StorageSystemMixin`.

**`find_similar()`** (inspired by AutoScraper) finds elements at the same depth with the same tag,
parent tag and grandparent tag, then filters by attribute similarity (`href`/`src` ignored by
default). Useful for "I found one product card, give me all of them".

## 2.3 Fetchers and sessions

| Class | Engine | When to use | Key options |
|---|---|---|---|
| `Fetcher` / `AsyncFetcher` / `FetcherSession` | **curl_cffi** | Static pages, APIs, low-to-mid protection. Fastest. | `impersonate='chrome'` (real browser TLS/JA3 fingerprint), `stealthy_headers=True` (browserforge headers + Google referer), `http3=True`, `proxy`, retries |
| `DynamicFetcher` / `DynamicSession` / `AsyncDynamicSession` | **Playwright** Chromium or real Chrome | JS-rendered sites | `network_idle`, `wait_selector`, `disable_resources` (skip images/fonts), `block_ads` (about 3,500 ad domains), `blocked_domains`, `capture_xhr='pattern'` (collect API responses the page makes), `cdp_url` (remote browser), `page_action` (your own clicks) |
| `StealthyFetcher` / `StealthySession` / `AsyncStealthySession` | **Patchright** (a Playwright fork patched against automation detection) + stealth Chrome args | Cloudflare and other anti-bot sites | `solve_cloudflare=True`, `google_search` referer, `hide_canvas`, `block_webrtc`, `dns_over_https` |

**Session = a persistent browser plus a page pool.** `max_pages=N` keeps N tabs, and
`get_pool_stats()` shows busy, free and error counts. Cookies and state persist across requests.

**Cloudflare flow** (`StealthySessionMixin`):
1. `_detect_cloudflare(html)` looks for `cType: 'non-interactive' | 'managed' | 'interactive'` in the
   challenge script, or an embedded Turnstile `<script src*="challenges.cloudflare.com/turnstile">`.
2. `_cloudflare_solver(page)` waits or clicks the Turnstile box inside its iframe, and loops until
   `_challenge_cleared()`.

**ProxyRotator:** thread-safe, `cyclic_rotation` by default or your own strategy function.
`is_proxy_error()` tells proxy failures apart from site failures. Works on every session type, with
per-request overrides.

Every fetcher returns a `Response`, which **is a `Selector`** (so `.css()` works directly) plus
`.status`, `.headers`, `.cookies`, `.body`, `.captured_xhr`.

## 2.4 Spiders: the crawl flow

```python
class QuotesSpider(Spider):
    name = "quotes"
    start_urls = ["https://quotes.toscrape.com/"]
    concurrent_requests = 10
    async def parse(self, response):
        for q in response.css('.quote'):
            yield {"text": q.css('.text::text').get()}
        if nxt := response.css('.next a'):
            yield response.follow(nxt[0].attrib['href'])

result = QuotesSpider(crawldir="./crawl").start()   # crawldir enables pause/resume
result.items.to_jsonl("quotes.jsonl")
```

**Components:**

| Part | Role |
|---|---|
| `Spider` | Your code: `start_urls`/`start_requests`, `parse` and other callbacks, hooks `on_start`, `on_close`, `on_error`, `on_scraped_item`, `is_blocked`, `retry_blocked_request`, `configure_sessions` |
| `SessionManager` | Several named sessions in one spider (`"fast"` = FetcherSession, `"stealth"` = AsyncStealthySession, lazily started). A `Request(sid=...)` picks one |
| `Scheduler` | `heapq` priority queue + **fingerprint dedup** (URL + method + body …). Snapshot/restore for checkpoints |
| `CrawlerEngine` | The async loop (anyio): concurrency limits, per-domain limiters, dispatch |
| `AutoThrottle` | Per-domain adaptive delay |
| `RobotsTxtManager` | Optional `robots_txt_obey`: Disallow, Crawl-delay, Request-rate, cached per domain, prefetched |
| `ResponseCacheManager` | **Dev mode**: cache responses on disk on the first run and replay them afterwards, so you can iterate on `parse()` without hitting the site |
| `CheckpointManager` | Periodic, atomic save of the scheduler and seen-set. **Ctrl+C = graceful pause**, and a re-run with the same `crawldir` resumes |
| `CrawlResult` / `CrawlStats` / `ItemList` | Items + stats (req/s, status counts, bytes per domain, blocked, cache hits); export to JSON/JSONL/CSV/XML |

**One request's journey (`CrawlerEngine._process_request`):**

```
dequeue Request
  → robots.txt allowed?            no → count & drop
  → dev cache hit?                 yes → run callbacks on cached response, done
  → acquire domain rate limiter
  → delay = AutoThrottle.delay_for(domain)  (≥ download_delay / crawl-delay floor) → sleep
  → session_manager.fetch(request)  (the session chosen by request.sid)
       exception → stats.failed++ → spider.on_error() → done
  → cache.put(response)
  → blocked = spider.is_blocked(response)
  → AutoThrottle.record(latency, ok = 2xx and not blocked, Retry-After)
  → if blocked and retries < max_blocked_retries:
        copy request, retry_count++, priority-1, drop its proxy (so the rotator picks a new one)
        spider.retry_blocked_request() → re-enqueue
  → else run callback → each yielded dict = item (→ on_scraped_item), each Request = enqueue
```

**AutoThrottle maths** (`spiders/throttle.py`):

```
target    = latency / target_concurrency
new_delay = max((current + target) / 2, target)            # smooth toward the target
if not ok (blocked / non-2xx):
    penalty   = Retry-After  or  current × 2 (BLOCK_BACKOFF_FACTOR)
    new_delay = max(new_delay, penalty, current)          # a block never speeds you up
new_delay = clamp(new_delay, floor, max_delay = 60 s)
```

Fast site → it speeds up. A site that starts blocking → the delay doubles, then eases off once
responses are healthy again.

**Streaming:** `async for item in spider.stream(): ...` with live `spider.stats`. Useful for a UI or
a pipeline.

**Ready templates:** `CrawlSpider` (rule-based link following with `LinkExtractor`),
`SitemapSpider`, `XMLFeedSpider` / `CSVFeedSpider`, `ShopifySpider` (whole catalogue through
Shopify's JSON API, one item per variant), `SiteToMarkdownSpider` (whole site → Markdown corpus for
RAG).

## 2.5 AI integration: the MCP server (`scrapling/core/ai.py`)

`pip install "scrapling[ai]"`, then run the MCP server so Claude, Cursor or any MCP client can
scrape through it. Tools exposed:

| Tool | What it does |
|---|---|
| `make_request` / `bulk_get` | curl_cffi HTTP (any method) / bulk GET |
| `fetch` / `bulk_fetch` | Playwright browser fetch |
| `stealthy_fetch` / `bulk_stealthy_fetch` | Patchright + Cloudflare solving |
| `open_session`, `open_request_session`, `session_fetch`, `session_make_request`, `list_sessions`, `close_session` | Persistent sessions across tool calls |
| `screenshot` | Page screenshot |

Every tool takes `css_selector` (narrow the page), `extraction_type` = `markdown` (default) /
`html` / `text`, and `main_content_only` (body only, default on). Content is **stripped of
prompt-injection text** (hidden elements and similar) before the model sees it. Optional bearer-token
auth and host allow-listing for the HTTP transport. The server's own instructions tell the agent to
start with `make_request` and escalate to a browser only when needed.

## 2.6 CLI

```bash
scrapling install                       # browsers + deps
scrapling shell                         # IPython with shortcuts, curl→Scrapling converter, view-in-browser
scrapling extract get   URL out.md                         # static fetch → markdown
scrapling extract fetch URL out.txt --css-selector '#main' # browser fetch → text
scrapling extract stealthy-fetch URL out.html --solve-cloudflare
```

The output format follows the file extension: `.md` gives Markdown, `.txt` text, `.html` raw HTML.

## 2.7 Strengths and weaknesses

- ✅ Very fast parser. Adaptive relocation survives redesigns **without an LLM**.
- ✅ One API from a single HTTP GET up to a multi-session, resumable, throttled crawl.
- ✅ The strongest built-in anti-bot kit of the three (TLS impersonation, Patchright, Turnstile solver).
- ✅ MCP server makes it an agent tool out of the box.
- ⚠️ You still write selectors (or save them once). It doesn't "understand" pages the way an LLM does.
- ⚠️ Browsers are heavy. Stealth and Cloudflare bypass have legal and ToS implications (the README
  itself says educational and research use, and to respect robots.txt).

---

# 3. OpenOutreach (+ OpenOutFind + OpenOutSend)

## 3.1 What it is

A **self-hosted AI lead-generation + cold-email agent**:

> Describe your product and target market → it **finds** matching people from a licensed data
> provider → an LLM **qualifies** each one and **writes down why** → it buys a **verified work
> email** only for the best fits → it **writes and sends** the email from your own mailbox, with
> follow-ups and reply handling.

Three packages, one product:

| Package | Job | Console script | Django apps |
|---|---|---|---|
| **OpenOutreach** | One install, one onboarding wizard, one command. Holds the only config row | `openoutreach` | `openoutreach_config` |
| **OpenOutFind** | Discovery → qualification → enrichment → CRM → export | `outfind` | `outfind_core`, `outfind_crm` |
| **OpenOutSend** | Ingest → mailbox → outreach agent → send guards → replies | `outsend` | `outsend_core`, `outsend_leads`, `outsend_emails` |

All five apps run in **one Django registry, one SQLite file (`~/.openoutreach/data/db.sqlite3`),
one process**. The boundary between finder and sender is a **public JSON Lines contract**:

```bash
outfind find 50 --json | outsend     # standalone, two programs
openoutreach run 50                  # same bytes, through an in-memory buffer
```

**Stack:** Django (ORM, migrations, no web UI), **pydantic-ai** (LLM calls, any `provider:model`),
**FastEmbed** (384-dim embeddings, about 65 MB ONNX), **scikit-learn** GP via `openoutlearn`,
SMTP/IMAP, BetterContact API (discovery + email finder), optional Apollo.

## 3.2 The verbs

```bash
uv tool install openoutreach
openoutreach                  # = run 5 : onboard if needed, find 5 with email, send
openoutreach run 5            # at most 5 email credits
openoutreach init             # onboarding only (--product-docs f.md --target t.md)
openoutreach find 10          # 10 MORE qualified leads → CSV on stdout (free, cannot spend)
openoutreach find 10 emails   # ...each with a verified email (1 credit each)
openoutreach find 0           # no work, just print what you have
openoutreach send [N|all]     # mail what is stored
openoutreach status [--json]  # config, blockers, counts, credit balance, next_action
```

Rules that hold everywhere:
- **stdout is data only** (CSV/JSONL). Logs, prompts and progress go to **stderr**, so
  `> leads.csv` is always clean.
- Expected failures are **one line**: `error: <type>: <message>`, exit 1 (types such as
  `provider_auth`, `provider_out_of_credits`, `goal_unreached`, `bad_config`, `qualify_pending`).
- **Exit 0 only if the goal was met.** Rows print either way.
- **No daemon**: every verb is a bounded run that ends. Re-running continues where it stopped
  ("N more than you had").

## 3.3 Onboarding flow (`openoutreach/wizard.py`)

```
openoutreach (bare) / run / init
  │
  ├─ migrate (all 5 apps, narration → stderr)
  ├─ SiteConfig.load()                ← singleton row: every answer the human gave
  ├─ read --product-docs / --target files (long markdown is never shell-quoted)
  ├─ ask ONLY what is missing (skipped if the row OR an env var already answers it):
  │     1. campaign   : product description + target market
  │     2. LLM        : provider:model + key  → verified with a live ping, re-ask on failure
  │     3. BetterContact key (free: 40 credits)
  │     4. operator   : name, email, country (ISO-2 → jurisdiction + sending timezone)
  │     5. mailbox    : address + APP password, SMTP/IMAP host/port (blank = Google), signature, booking link
  │     + Legal Notice acceptance (default NO, re-asked until yes)
  │     + newsletter: auto-yes outside opt-in jurisdictions, asked inside EU/UK/CA/BR/AU/JP/KR/NZ/CH
  │   (no TTY + something missing → exit naming the exact env vars to set = headless install)
  ├─ copy env-supplied answers back into the row, save
  ├─ apply_to_environment(): row → OPENOUTFIND_* and OUTSEND_* via os.environ.setdefault
  │     (two separate maps, FINDER_ENV / SENDER_ENV, never merged; a blank field exports nothing)
  └─ children check themselves:
        openoutfind.core.readiness.check_ready()   → pings the model, writes the operator User
        cold_outreach.first_run.check_ready()       → real SMTP login to connect the mailbox
```

Each child reads its config **only from the environment, fresh every run**, and remembers nothing.
OpenOutreach is the only layer that remembers what a human typed.

## 3.4 `run`: the whole pipeline in one command

```
_run(goal=5)
  ├─ wizard.onboard()
  ├─ call_command("find", "5", "emails", "--json", stdout=<StringIO buffer>)
  │     (if find stops short but produced rows → keep going; only an empty buffer is a failure)
  ├─ cold_outreach.leads.ingest.ingest(buffer)     ← the sender's normal stdin ingest
  └─ cold_outreach.__main__.main(["send"])         ← one send pass
```

## 3.5 OpenOutFind: the finder, in depth

**Pipeline:** `define ICP → discover → qualify → rank → (optionally) resolve an email → export`.

### Deal state machine (`crm/models/deal.py`)

```
                ┌──────────── (LLM says no-fit) ──► FAILED (outcome=wrong_fit)   [not exported]
                │
candidate ──► QUALIFIED ──(GP confidence gate)──► READY_TO_FIND_EMAIL ──► FINDING_EMAIL
              [exported, no email]                    │    ▲                  │  (async poll,
                                                      │    └── couldn't run ──┤   doubling backoff,
                               free hub cache hit ────┤                       │   never abandoned)
                                                      ▼                       ▼
                                                  RESOLVED ◄─── hit ──────────┤
                                               [exported with email]          └─ miss ► NO_EMAIL_FOUND
```

`QUALIFIED` is already exportable. The email is an optional enrichment on top. A separate
`Lead.disqualified` flag marks a permanent opt-out. Both rejections are always excluded from export.

### The cycle (`core/cycle.py`): one action per call, in priority order

```
run_one_action():
  1. a FINDING_EMAIL deal whose not_before has passed → check_lookup (poll the provider job)
  2. a QUALIFIED deal                                  → promote_to_ready (GP spend gate)
  3. a READY_TO_FIND_EMAIL deal (buy_addresses on)     → buy_address (hub → paid finder)
  4. otherwise                                         → top_up() (discover or qualify ONE thing)
  nothing fired → print pipeline_summary (which gate is holding, and why)
```

**The job** (`core/job.py`): `while produced < goal: if not run_one_action(): break`. No timeout by
design. Each unit of work carries its own back-off (`deal.not_before`, `urllib3.Retry` for 429s).
Progress is a *set* of lead ids, so a rejection can't cancel out a find.

### Step A: the cold start (`core/pipeline/icp.py`)

One LLM pass over `product_docs` + `campaign_target` produces:
- **Seed**: opening search keywords (split into single-word tokens) + a company headcount band.
- **Anchors**: several **synthetic ideal profiles**, stored as `Lead(synthetic=True)` and embedded
  like real leads. They are the GP's first positives, so the model can fit before any real lead has
  been accepted. They are shown to the operator as *"Looking for people like: …"*.

### Step B: discovery, a counted keyword walk (`core/pipeline/select.py`, `discover.py`)

The provider (BetterContact Lead Finder, free to search, returns firmographic profiles with no
emails) is a **keyword index**: words within one field are ANDed, and separate fields are ANDed.

- A **node** = a set of `(field, token)` keywords, e.g. `{title: founder, title: cto, location: germany}`.
  Axes: `lead_job_title`, `lead_seniority`, `lead_location`. At most 2 tokens per field.
- **Children** = the node + one more token that has appeared in an already **qualified** profile
  (the vocabulary grows from accepted leads, `df ≥ 2`).
- **Value of a node:** Laplace-smoothed toward its parent's rate:
  `P̂(node) = (a + 2·P̂(parent)) / (a + b + 2)`, where a/b = qualified/rejected leads whose profile
  contains all of the node's tokens (anchors count as positives).
- **Selection:** Thompson sampling. Draw `θ ~ Beta(a + 2P̂(parent), b + 2(1−P̂(parent)))` for every
  frontier node and fire the highest one.
- **Retirement** only for emptiness, never for a low score: offset 0 empty → `dead` (prune the
  subtree); drained below the 10k window → `drained`; hit the 10k window cap → drained but keep
  children (a narrower query opens a fresh window).

### Step C: qualification, LLM + active learning (`core/pipeline/qualify.py`, `core/ml/qualifier.py`)

- Every lead's `profile_text` is embedded (FastEmbed, 384-dim, cached on `Lead.embedding`).
- A **Gaussian Process** classifier (`openoutlearn.GPBaldQualifier`) is trained **only on the
  LLM's verdicts** (1 = accepted, 0 = `FAILED`/`wrong_fit`) plus the anchors. It is refit in memory
  after every new verdict and never persisted.
- **Which candidate to ask the LLM about next** (`top_up`):
  - **Cold phase** (real positives < anchor count): each pass does one discovery page **and** one
    label, always **exploiting** (the lead most like the ideal profile).
  - After that, **balance** the classes:
    - `neg ≤ pos` → **explore**: BALD picks the lead the model is most uncertain about.
    - `neg > pos` → **exploit**: the strongest lead above `min_gp_confidence`, else the most
      informative lead above `min_bald_gain` (0.04 nats), else **discover** more.
- The LLM answers **fit / no-fit + a written reason**. The reason is the product: it goes into the
  CSV and the operator corrects the pipeline by editing the product description.
- `--agent-qualify`: when the caller is itself an LLM (e.g. Claude Code), the run stops with
  `qualify_pending` + the profile, and the agent re-runs with `--verdict fit|no-fit --reason ...`,
  which saves a second model call.

### Step D: enrichment, the only paid step (`enrichment/`)

- **Spend gate:** a deal is promoted to `READY_TO_FIND_EMAIL` only if the GP posterior clears
  `min_gp_confidence`. This is a budget gate, not a quality score.
- **Spending is opt-in:** a bare `find` never spends. `emails` / `--emails` enables it.
- `buy_address`: first the free **hub cache** (`hub.openoutreach.app`, a shared
  `profile_url → email` store), then the **finder** chosen by `provider.active()`:
  - BetterContact: async waterfall job → `FINDING_EMAIL` → polled with doubling backoff.
  - Apollo: synchronous `people/match` (wired but not exposed yet).
- A fresh paid hit is **given back** to the hub, but only for non-EEA operators.
- The query sent to the provider is **URL-only** (share as little personal data as possible).
- HTTP errors are typed: 401 → `provider_auth`, 402 → `provider_out_of_credits`, 429 → retried
  (5×, exponential, honours `Retry-After`) → `provider_rate_limited`.

### Step E: export (`core/export.py`)

`find` prints **every exportable lead** (not only new ones) progressively. Columns match what
Instantly and Smartlead import without mapping:

```
email, first_name, last_name, company, title, website, linkedin_url, reason, lead_id, qualified_at, full_name
```

`--json` gives JSON Lines + `profile_text`. `--new` limits output to this run's leads, and `--batch`
prints once at the end. No score column, on purpose.

## 3.6 OpenOutSend: the sender, in depth

### Ingest (`leads/ingest.py`)

Reads JSON Lines from stdin and **upserts on `lead_id`** (idempotent; a re-ingest is a correction,
latest value wins). It checks every address against the **Suppression** table at the door
(terminal: an opt-out is never resurrected), skips and counts malformed lines, and stores rows even
when `email` is blank (a later run can fill it). Tables: `Lead`, `Deal` (the conversation),
`Suppression`, `PendingDraft`.

### One send pass (`send_pass.py`): the order is the design

```
1. READ     IMAP sync → store raw mail → classify (human_reply / bounce / auto_reply / opt_out / unrelated / outbound)
            → events; opt-outs suppress BEFORE anything is written
2. MEASURE  each mailbox's warm capacity for today (once per day)
3. ANSWER   every thread where the lead replied          ← no cap, no spacing, no window
4. FOLLOW UP  quiet threads due (after 3, then 5 business days) ← cold volume: capped, spaced, in-window
5. OPEN     first emails, one per free mailbox            ← capped, spaced, in-window
→ print counts + the gate that is holding
```

- `outsend send` = one pass, then exit (cron-friendly).
- `outsend send 5` = keep passing until **5 new conversations** are open. It sleeps until the pool
  says the next opener is allowed (`next_first_email_at`), waking every 5 minutes to answer replies.
- `outsend send all` = until nobody with an address is left.

### Deliverability guards

| Guard | Rule (from `core/conf.py`, `emails/warmth.py`, `core/sending_window.py`) |
|---|---|
| **Sending window** | Mon–Fri, 08:00–20:00 in the **operator's** timezone (derived from country). Each half can be switched off (`OUTSEND_ENFORCE_WORK_HOURS`, `OUTSEND_ENFORCE_WEEKEND_PAUSE`) |
| **Spacing clock** | At least 180 s between sends + random 30–90 s jitter (3.5–4.5 min) |
| **Daily cap = warmup** | Measured from the box's own **Sent folder** over 30 days. Starts at 5/day, grows at most ×1.25 per day when clean, ceiling 100/day, drops immediately on bounces (>5 %) or receiver push-back |
| **SMTP verdicts** (`delivery_policy.py`) | 4xx = deferred (slow down, retry later); 5xx = quota / blocked / refused (pause today); 5.1.1/5.1.2/… = dead address → suppress; socket/auth errors say nothing about reputation |
| **Suppression** | Opt-out alias (`+unsub`), a worded "stop emailing me", dead addresses. Terminal |

### The outreach agent (`core/agents/outreach.py`)

One template (`outreach_agent.j2`), one voice (*Mom Test*-style research, not a hard sell), three
stages:

| Stage | Allowed actions |
|---|---|
| `open` (no thread yet) | `send_message` (must include a subject; ≤ 75 words for cold mail) |
| `follow_up` (no reply) | `send_message` in the same thread, or `mark_completed` (wrong fit) |
| `reply` (they wrote back) | `send_message`, `mark_completed`, or `suppress` |

- **The agent never decides when to send.** Timing is fully deterministic (pools + guards). The LLM
  only decides *what* to write.
- The input is the finder's `profile_text` + `reason`, `OUTSEND_PRODUCT_DOCS`, `CAMPAIGN_TARGET`,
  the booking link and the last 6 turns of the thread.
- **Prompt lines** (`core/prompt_lines.py`): swappable "opening moves" stored as files. One is chosen
  **at random** per opener and recorded (id + hash), so you can later compare reply rates per line.
  Operator files in `state_dir/prompt_lines` override the shipped ones.
- 3 cold touches maximum (open + 2 follow-ups), then the deal closes as `unresponsive`.
- Every email ends with a fixed `Sent with OpenOutreach` line that cannot be turned off.
- `--agent-draft`: an LLM caller writes the opener itself (`draft_pending` → re-run with
  `--subject` and `--body`).

## 3.7 Strengths and weaknesses

- ✅ Clean architecture: bounded runs, typed errors, stdout = data, and a public pipe between two
  independent programs.
- ✅ No scraping, so no platform ban risk. Pay-per-verified-email with a spend gate.
- ✅ Explainable output (the `reason` column), plus real deliverability engineering (warmup from the
  Sent folder, SMTP code interpretation, sending windows).
- ✅ Ships Claude Code skills (`skills/find-leads/SKILL.md`, `skills/send-mail/SKILL.md`), so an agent
  can drive it.
- ⚠️ Depends on BetterContact for discovery (Apollo only covers enrichment).
- ⚠️ The README itself says the GP active-learning loop is "not yet shown to beat random".
- ⚠️ You are the data controller and the sender. GDPR, CAN-SPAM and CASL compliance is your
  responsibility. It also sends a mandatory footer, and the finder may contribute found emails to
  the author's hub (non-EEA only).

---

# 4. Side-by-side: how one request flows

```
ScrapeGraphAI                    Scrapling                         OpenOutreach
─────────────                    ─────────                         ────────────
prompt + URL                     URL + selector / Spider           product + target description
   │                                │                                 │
Fetch (Playwright/etc.)          Fetcher | Dynamic | Stealthy       LLM → ICP seed + ideal profiles
   │                                │  (TLS spoof / CF solve)          │
HTML → Markdown                  Response (= Selector)              keyword-walk discovery (API)
   │                                │                                 │
chunk (semchunk)                 css/xpath  ──fail──► adaptive      LLM verdict + reason; GP+BALD
   │                                │               relocate()        picks the next lead to judge
LLM per chunk (parallel)         items → pipeline/export              │
   │                                │                               GP gate → buy verified email
LLM merge → JSON                 Spider: schedule, throttle,          │
                                 retry blocked, checkpoint          CSV / JSONL ──pipe──► sender
                                                                      │
                                                                    IMAP read → reply → follow-up →
                                                                    open (window, warmup, spacing)
```

---

# 5. Where these could fit in PowPow

PowPow is a multi-channel gateway: skills in `skills/`, plugins in `extensions/`, channels in
`src/channels/`. It already has **LeadMine** (a Chrome extension for Google Maps and LinkedIn
leads) and `research/linkedin-recent-posts`.

| Idea | Which tool | How |
|---|---|---|
| "Scrape this URL" skill for chat users | **Scrapling MCP server** | Register it as an MCP server (e.g. through the `mcporter` skill). The agent gets `make_request`, then `fetch`, then `stealthy_fetch`, returning Markdown narrowed by `css_selector`. Cheap in tokens, and the output has prompt-injection text removed |
| "Extract X from this page as JSON" | **ScrapeGraphAI** `SmartScraperGraph` with a Pydantic schema | Wrap it as a Python skill. Use a local Ollama model for free runs. Set `SCRAPEGRAPHAI_TELEMETRY_ENABLED=false` |
| "Research this question on the web" | ScrapeGraphAI `SearchGraph` | DuckDuckGo → top N → merged answer |
| Recurring structured scrape (e.g. job boards, trainer listings) | **Scrapling Spider** + `adaptive=True` | Runs without an LLM, resumes from checkpoints and survives redesigns. Pipe items to a channel |
| Build a scraper once, run it forever | ScrapeGraphAI `CodeGeneratorGraph` → save the code → run it with Scrapling | The LLM pays once and later runs are free |
| B2B lead finding + cold email from chat | **OpenOutreach CLI** (`find N --json`, `status --json`, `send`) | Call it as a subprocess from a skill. Its typed `error:` lines and `next_action` are easy for an agent to act on. Never run `send` without explicit user approval |
| Enrich LeadMine output | Scrapling fetch of each lead's website + ScrapeGraphAI extraction | Pull company description, services and contact page into the spreadsheet |

A combined pipeline idea:

```
User (Telegram/Slack) ──► PowPow skill
     "find SAP trainers in Chennai and summarise their sites"
        │
        ├─ LeadMine / OpenOutFind  → list of people + company websites
        ├─ Scrapling (Fetcher → Stealthy on block) → each site as Markdown
        ├─ ScrapeGraphAI SmartScraper(schema=TrainerProfile) → structured JSON
        └─ reply in chat with CSV + summary   (optional: OpenOutSend, only with explicit approval)
```

---

# 6. Quick-start cheat sheet

```bash
# ScrapeGraphAI
pip install scrapegraphai && playwright install
export SCRAPEGRAPHAI_TELEMETRY_ENABLED=false
python -c "from scrapegraphai.graphs import SmartScraperGraph as G; \
print(G(prompt='page title and main links', source='https://example.com', \
config={'llm':{'model':'ollama/llama3.2','model_tokens':8192,'format':'json'}}).run())"

# Scrapling
pip install "scrapling[all]" && scrapling install
scrapling extract get 'https://quotes.toscrape.com' quotes.md
python -c "from scrapling.fetchers import Fetcher; \
print(Fetcher.get('https://quotes.toscrape.com').css('.quote .text::text').getall()[:3])"

# OpenOutreach
uv tool install openoutreach
openoutreach init --product-docs product.md --target target.md
openoutreach find 10 > leads.csv        # free: no credits spent
openoutreach status
```

---

# 7. Legal and ethical notes

- **Scraping:** respect robots.txt and site ToS. Scrapling's README describes it as for
  educational/research use. Bypassing anti-bot protection can breach terms of service, and in some
  jurisdictions the law.
- **Personal data (leads):** whoever stores or emails people is the data controller. GDPR (EU/UK),
  India's DPDP Act, CAN-SPAM (US) and CASL (Canada) all apply: honour opt-outs and keep a lawful
  basis.
- **LinkedIn:** automating a logged-in account risks a permanent ban (see LeadMine's own warning).
  The current OpenOutreach avoids LinkedIn automation entirely.
- **Telemetry:** ScrapeGraphAI sends usage data by default. Disable it for client or private work.
