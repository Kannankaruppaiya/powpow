# Finding LinkedIn posts from the last 7–10 days by intent

Goal: find only **recent** LinkedIn posts (last 7–10 days) that show a specific
**intent**. Example: someone posting that they need a corporate trainer or have a
corporate training requirement. Then collect them as leads.

This folder is standalone research. It is not part of the PowPow gateway.

---

## 1. Research findings (tested 2026-09-23)

| # | Finding | What it means |
|---|---------|---------------|
| 1 | **Google's date filter (`tbs=qdr:w`, "Past week", `after:`) filters on Google's own date, not the LinkedIn post date.** | Google's date is when Google first saw or estimated the page. The results mix old reposted content with genuinely new posts. |
| 2 | **Search engines index LinkedIn posts 1–3 weeks late.** Asked on 2026-09-23 for posts from the last 10 days, Exa's newest "trainer requirement" post was from **2026-09-07**, 16 days old. Google shows the same lag. | A search engine alone can't give you complete last-7-day coverage. It finds a subset, and the newest posts are often missing. |
| 3 | **Every LinkedIn post ID contains its exact publish time.** Shift the ID right by 22 bits (`id >> 22`) to get milliseconds since 1970. Verified: `7500139413100740609` → 2026-08-31 10:36 UTC, which matches the date LinkedIn shows. | This is the key trick. The post URL alone gives the **exact** post time, with no login and no scraping. The tool uses it to drop every stale result that Google's date filter let through. |
| 4 | **Google Custom Search JSON API** is closed to new customers and shuts down on **2027-01-01**. | Don't build on it. Use a SERP API instead: Serper.dev, SerpAPI or DataForSEO. All of them accept `tbs`. |
| 5 | **Exa** accepts `includeDomains:["linkedin.com"]` plus `startPublishedDate`. Its semantic search suits intent ("someone needs a trainer") better than keyword matching. | A good second source. It also returns the full post text, which improves intent classification. |
| 6 | **LinkedIn's own post search** (`/search/results/content/?keywords=…&datePosted="past-week"&sortBy="date_posted"`) is the only source with complete, real-time coverage of the last 7 days. | It needs a logged-in session. Automated scraping breaks LinkedIn's terms of service and can get the account restricted. Use it manually or through a provider (for example an Apify actor) and accept the risk knowingly. |

## 2. The plan (what `find-posts.mjs` does)

```
 Google (via Serper, tbs=qdr:d15)  ─┐
 Exa (includeDomains+startDate)    ─┼─► collect URLs + snippets
 Manual URLs from LinkedIn search  ─┘         │
                                              ▼
                  extract post ID from the URL (activity / ugcPost / share)
                                              ▼
                  decode exact time = id >> 22  →  drop if older than N days   ← "perfect" recency
                                              ▼
                  dedupe by ID (the same post appears under different URLs)
                                              ▼
                  intent classify: DEMAND (needs trainer) / SUPPLY (trainer self-promo) / RECAP (session done)
                                              ▼
                  extract emails / phones in the post  →  CSV sorted newest first
```

The tool searches a slightly wider window (N+5 days) and then applies the exact
N-day cut from the post ID. Google's date filter is fuzzy, so it can't be trusted
at the boundary.

### Google query design

- `site:linkedin.com/posts OR site:linkedin.com/feed/update` returns only posts.
  Profiles (`/in/`), jobs and company pages are excluded.
- Intent phrases are split into 4 groups because Google caps a query at 32 words:
  `"trainer required"`, `"training requirement"`, `"looking for a corporate trainer"`,
  `"urgent requirement" trainer`, `"interested trainers"`, `"share your profile" trainer`, …
- Negatives remove supply-side noise: `-"#opentowork" -"I am available"`.
- `--topic "SAP"` adds a technology filter to every query.

## 3. How to use

```bash
cd research/linkedin-recent-posts

# A) No API key: print ready-made Google URLs (custom 10-day range, sorted by date)
node find-posts.mjs --print-queries --days 10

# B) Automated: Serper (Google results) and/or Exa
SERPER_API_KEY=xxx EXA_API_KEY=yyy node find-posts.mjs --days 10 --out leads.csv
SERPER_API_KEY=xxx node find-posts.mjs --days 7 --topic "ServiceNow"

# C) Best coverage: also paste URLs you copied from LinkedIn's own
#    "Posts → Past week → Latest" search into urls.txt, one per line
node find-posts.mjs --input urls.txt --days 10 --out verified.csv
```

Flags: `--days N` (default 10), `--topic X`, `--pages N` (Serper pages per query,
default 3), `--keep-all` (also keep SUPPLY/RECAP rows), `--out file.csv`.

CSV columns: `posted_at` (exact, from the ID), `age_days`, `intent`, `score`,
`author`, `emails`, `phones`, `url` (canonical), `original_url`, `sources`, `snippet`.

## 4. Manual method (Google in a browser)

1. Search:
   `site:linkedin.com/posts ("trainer required" OR "training requirement" OR "looking for a corporate trainer")`
2. Open **Tools → Any time → Custom range**, set the last 10 days, then choose **Sorted by date**.
   Or add `&tbs=qdr:d10` to the URL.
3. Check each result's real date: put the 19-digit number after `activity-` in the
   URL into any "LinkedIn post date extractor", or into `--input` above.

## 5. Recommended stack for the best result

1. **Daily run** of `find-posts.mjs` with Serper and Exa. It's cheap and fully automated.
   Daily runs matter: search engines index posts late, so repeated runs pick up posts as they appear.
2. **Plus LinkedIn's native "Past week / Latest" search.** Run it manually, or through
   a provider if you accept the terms-of-service risk. This fills the 0–7 day gap that
   search engines miss. Feed those URLs through `--input` so every lead gets the same
   exact-date check and intent check.
3. Optional: send DEMAND rows to an LLM for a final "is this really a training
   requirement?" pass, and to extract technology, location, dates and commercials.

## Sources

- Google Custom Search API shutdown: https://developers.google.com/custom-search/v1/overview, https://www.heise.de/en/news/Google-is-discontinuing-its-free-web-search-index-for-developers-11152411.html
- Google `tbs` / `qdr` / `cdr` parameters: https://dataforseo.com/help-center/google-search-engine-parameters-and-how-to-use-them, https://brightdata.com/blog/web-data/google-search-url-parameters
- LinkedIn ID → timestamp: https://trevorfox.com/linkedin-post-date-extractor/
- Exa search parameters: https://docs.exa.ai/reference/search
