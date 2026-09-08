/**
 * LeadMine — background service worker.
 *
 * Owns the run. A run is a queue of search tasks (batch entries × grid cells),
 * each of which drives the Maps tab and returns records that are merged into
 * one deduplicated set. The queue and the accumulated records are written to
 * storage after every task, so closing the popup, an evicted service worker or
 * a crashed browser all leave a run that can be resumed rather than repeated.
 *
 * After the queue drains, two enrichment passes run over the merged records:
 * emails (and social links) from each business's website, then email
 * verification over DNS-over-HTTPS.
 *
 * Records live in IndexedDB, not in the job object. Keeping them together
 * meant every progress update re-serialised the entire result set — several
 * gigabytes of writes over a large run — and capped how much could be handed
 * to the UI in one message. Now only the records a task actually touched are
 * written, and the side panel reads the database directly.
 */

import { findEmailForSite, mapWithConcurrency } from '../lib/email.js';
import { verifyEmail, isSendable } from '../lib/verify.js';
import { parseMapUrl } from '../lib/geo.js';
import { absorbInto, recordKey } from '../lib/dedupe.js';
import { assessHealth, gatesFor } from '../lib/health.js';
import { filterByCategory } from '../lib/categories.js';
import { sourceFor, buildUrl, DEFAULT_SOURCE } from '../lib/sources.js';
import * as store from '../lib/store.js';
import { buildTaskList, expandGridTasks, insertAfter, nextPending, taskProgress } from '../lib/tasks.js';
import { URN_KEY, withSeed, learn } from '../lib/urns.js';
import { pageOf, pageUrl } from '../lib/linkedin-query.js';
import { cacheKey, planFrom, absorb } from '../lib/search-cache.js';

const STORE_KEY = 'mls.job';

const DEFAULT_JOB = {
  status: 'idle', // idle | running | paused | done | error | cancelled
  phase: 'idle', // listing | details | emails | verify | done
  message: '',
  error: '',
  config: null,
  jobId: null,
  tasks: [],
  found: 0,
  detailed: 0,
  total: 0,
  emailed: 0,
  emailsFound: 0,
  verified: 0,
  sendable: 0,
  skippedSeen: 0,
  filteredOut: 0,
  // Set when a settled run survives a restart. It stays readable, but it
  // stops owning the screen — see loadJob().
  stale: false,
  health: null,
  tabId: null,
  startedAt: null,
  finishedAt: null,
};

let job = { ...DEFAULT_JOB };
// The working set for the current run. Held in memory so merging stays cheap,
// mirrored to IndexedDB after every task so nothing is lost.
let records = [];
let cancelRequested = false;
let keepAlive = null;

/**
 * Chrome evicts an idle MV3 service worker after 30 seconds, which would
 * abandon a scrape halfway through. Touching an extension API on a timer
 * resets that clock for as long as a run is actually in progress.
 */
function startKeepAlive() {
  if (keepAlive) return;
  keepAlive = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (!keepAlive) return;
  clearInterval(keepAlive);
  keepAlive = null;
}

/* ------------------------------------------------------------------ state */

async function loadJob() {
  const stored = await store.getMeta(STORE_KEY);
  if (stored) job = { ...DEFAULT_JOB, ...stored };
  records = job.jobId ? await store.getRecords(job.jobId) : [];

  // A worker restart means the in-flight task was abandoned. Say so honestly
  // and offer to resume rather than silently reporting the run as finished.
  if (job.status === 'running') {
    for (const task of job.tasks) if (task.status === 'running') task.status = 'pending';
    const resumable = job.tasks.some((t) => t.status === 'pending');
    job.status = resumable ? 'paused' : 'done';
    job.message = resumable
      ? 'Interrupted — press Resume to carry on where it stopped.'
      : `Recovered ${records.length} results from the previous run.`;
  }

  // A run that had already finished before this restart is history. Its rows
  // stay in Results and its file is still downloadable, but it does not get
  // to own the screen: every extension reload was painting a dead run's error
  // back over the form, which reads as "the reload did nothing".
  //
  // A paused run is the exception — it is unfinished, and Resume lives in the
  // run view, so it keeps the screen.
  if (['done', 'error', 'cancelled'].includes(job.status)) job.stale = true;

  return job;
}

const ready = loadJob();

/**
 * Persist the job metadata — the queue and the counters only. This object stays
 * small however many businesses have been collected, which is the whole point
 * of keeping records in their own store.
 */
async function save(patch = {}) {
  job = { ...job, ...patch };
  await store.putMeta(STORE_KEY, job);
  try {
    await chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job: publicJob() });
  } catch {
    /* no popup listening */
  }
}

/** The popup renders a preview and counters, never the whole result set. */
function publicJob() {
  const { tasks, ...rest } = job;
  const { settled, total } = taskProgress(tasks);
  return {
    ...rest,
    count: records.length,
    phonesFound: records.filter((r) => r.phone).length,
    websitesFound: records.filter((r) => r.website).length,
    tasksSettled: settled,
    tasksTotal: total,
    // "1 searches failed" with no reason is not a report. Carry the first
    // failure's message so the panel can say what actually went wrong.
    taskError: (tasks.find((t) => t.status === 'failed' && t.error) || {}).error || '',
    // People the source showed but refused to identify, across every search.
    // Without this the panel cannot tell a broken scrape from a run where
    // LinkedIn simply would not say who most of the results were.
    withheld: tasks.reduce((n, t) => n + ((t.context && t.context.withheld) || 0), 0),
    // Why collection ended, from the last search that ran.
    stoppedBecause:
      [...tasks].reverse().find((t) => t.stoppedBecause) &&
      [...tasks].reverse().find((t) => t.stoppedBecause).stoppedBecause,
    canResume: job.status === 'paused' && tasks.some((t) => t.status === 'pending'),
    // A preview only — the side panel pages the full set out of IndexedDB.
    preview: records.slice(0, 60),
  };
}

/* ------------------------------------------------------------- tab plumbing */

/**
 * Wait until the tab has finished loading a URL containing `expect`.
 *
 * The URL check is not decoration: immediately after tabs.update the tab can
 * still report the *previous* page as complete, and without it the very first
 * search would be scraped off about:blank.
 */
function waitForTabComplete(tabId, expect = '/maps/', timeout = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for Google Maps to load.'));
    }, timeout);

    function settle(fn, value) {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(value);
    }

    const arrived = (tab) => tab && tab.status === 'complete' && String(tab.url || '').includes(expect);

    function listener(id, info, tab) {
      if (id !== tabId) return;
      if (info.status === 'complete' && arrived(tab)) settle(resolve);
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (arrived(tab)) settle(resolve);
      },
      (err) => settle(reject, err)
    );
  });
}

/** Content scripts are absent from tabs that loaded before an install. */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong && pong.ok) return;
  } catch {
    /* not injected yet */
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      'src/lib/parse.js',
      'src/content/engine.js',
      'src/content/adapters/maps.js',
      'src/content/adapters/linkedin.js',
      'src/content/adapters/web.js',
    ],
  });
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * Maps rewrites its own URL with the map centre once the results settle, which
 * is where the grid gets its coordinates from — no geocoding service needed.
 * The centre appears a moment after load, so give it a few tries.
 */
async function readMapCentre(tabId, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const centre = parseMapUrl(tab.url);
      if (centre) return centre;
    } catch {
      return null;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/* ---------------------------------------------------------------- the queue */

/**
 * A failure that is about the tab rather than about the page.
 *
 * These come from Chrome's own messaging layer when the tab navigates, is
 * discarded, or goes into the back/forward cache mid-scrape. The scrape was
 * never wrong; the channel it was speaking over went away.
 */
function isTransient(message) {
  return /back\/forward cache|message channel is closed|message port closed|Receiving end does not exist|No tab with id|Frame with ID/i.test(
    String(message || '')
  );
}

async function runTask(task, config, tabId) {
  const source = sourceFor(config.source);

  if (!task.useCurrentTab) {
    // A LinkedIn task built from facets already knows its exact URL — the
    // keyword string cannot express geoUrn or serviceCategory, so it is not
    // asked to.
    const url = task.url || buildUrl(source.id, task.term, task.point);

    /*
     * A search already answered costs nothing — including its first page.
     *
     * This has to be checked before the tab moves. Consulted inside the
     * paging loop instead, the first navigation and its count had already
     * happened, so a "free" repeat still spent a search while the panel said
     * none were spent.
     *
     * Only when the URL is final. A task whose filters LinkedIn still has to
     * apply does not know its own identity yet: the facet ids are what the
     * key is built from, and LinkedIn has not written them.
     */
    if (pagesByUrl(config) && !(task.applyFilters && task.applyFilters.length)) {
      const hit = await servedFromCache(task, config, url);
      if (hit) return hit;
    }

    if (pagesByUrl(config) && (await budgetLeft(config)) <= 0) {
      throw new Error(
        'The monthly LinkedIn search budget is spent. LinkedIn gives a free account ' +
          'about 300 searches a month and then returns three results per search. ' +
          'Raise the budget in More options if you know yours is higher, or wait for the 1st.'
      );
    }
    await chrome.tabs.update(tabId, { url, active: !config.background });
    await waitForTabComplete(tabId, source.urlPart);
    if (pagesByUrl(config)) await countSearchPage();
    // Maps hydrates its feed after `complete`; a short settle avoids a race.
    await new Promise((r) => setTimeout(r, 2500));

    /*
     * Filters LinkedIn has to apply for us.
     *
     * A facet takes LinkedIn's own id — geoUrn wants 102784390, not "Chennai"
     * — and those numbers are undocumented, so a name nobody has looked up
     * cannot be put in a URL. It can be put in LinkedIn's filter panel
     * though: type it, tick what comes back, press Show results, and LinkedIn
     * writes the URL itself. The ids are learned on the way, so the same
     * search skips all of this next time.
     */
    if (task.applyFilters && task.applyFilters.length) {
      await ensureContentScript(tabId);
      const applied = await chrome.tabs.sendMessage(tabId, {
        type: 'APPLY_FILTERS',
        wants: task.applyFilters,
      });
      if (!applied || !applied.ok) {
        throw new Error(
          `Could not apply the filters on LinkedIn: ${(applied && applied.reason) || 'no answer'}`
        );
      }
      await rememberUrns(applied.applied);
      // Pressing "Show results" makes LinkedIn run the search again, once per
      // filter. A run with two unresolved filters costs three search pages,
      // not one — which is invisible unless it is counted.
      for (let i = 0; i < task.applyFilters.length; i += 1) await countSearchPage();
      // The results list rebuilds after a filter lands.
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (cancelRequested) throw new Error('cancelled');

  await ensureContentScript(tabId);

  // Page from where the tab actually is. Applying a filter makes LinkedIn
  // rewrite the URL, and paging the one we asked for would quietly drop the
  // filters that had just been applied.
  try {
    const live = await chrome.tabs.get(tabId);
    if (live && live.url) task.currentUrl = live.url;
  } catch {
    /* the tab went away; pageThrough will fall back to task.url */
  }

  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'RUN_SCRAPE',
    config: { ...config, city: task.city, category: task.category, singlePage: pagesByUrl(config) },
  });
  if (!response) {
    throw new Error(`The ${source.label} tab stopped responding. Keep it open while scraping.`);
  }
  if (!response.ok) throw new Error(response.error || 'Scrape failed.');

  // The page knows what it is searching for; on a current-tab run that is the
  // only place the query and the user's filters exist.
  if (response.context) task.context = response.context;
  // The page is the only place a filter's name and LinkedIn's id for it appear
  // together. Whatever it saw, keep — one filter applied by hand is one filter
  // this extension can build for itself from then on.
  if (response.context && response.context.learned) await rememberUrns(response.context.learned);
  if (response.stoppedBecause) task.stoppedBecause = response.stoppedBecause;

  let records = response.records || [];
  if (pagesByUrl(config) && !task.useCurrentTab) {
    records = await pageThrough(records, task, config, tabId);
  }
  return records;
}

/* ------------------------------------------------------------------ pacing */

/**
 * How long to wait between pages.
 *
 * Everything else about this extension already looks like a person: it runs
 * in the user's own Chrome, from their own address, in their own signed-in
 * session. There is no headless browser to detect, no datacenter address, no
 * automation framework to fingerprint.
 *
 * What does not look like a person is the clock. Ten pages at a fixed 1200ms
 * is twenty seconds of perfectly even spacing, and evenness is the signal —
 * a person reads a page for three seconds, then eleven, then one. So the wait
 * is a range rather than a number, and it lengthens as a run goes on, the way
 * attention does.
 *
 * This makes a run slower on purpose. It is the only thing about the run that
 * was worth hiding, and a detected run returns nothing at all.
 */
function pageDelay(pagesSoFar = 0) {
  const base = 1800 + Math.min(pagesSoFar, 10) * 260;
  return Math.round(base + Math.random() * 3400);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- the search budget */

const BUDGET_KEY = 'searchBudget';

/*
 * Roughly what a free LinkedIn account gets in a calendar month before the
 * commercial-use limit lands. Not a published number and not a fixed one —
 * LinkedIn decides it from behaviour — so it is a default to stop at, not a
 * fact, and `config.searchBudget` overrides it.
 */
const MONTHLY_ALLOWANCE = 300;

/** Search pages left this month, by our own count. */
async function budgetLeft(config = {}) {
  const cap = Number(config.searchBudget) || MONTHLY_ALLOWANCE;
  const { inMonth } = await readBudget();
  return cap - inMonth;
}

/** The calendar month LinkedIn's own allowance is keyed on. */
const thisMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Count one search-results page fetched from LinkedIn.
 *
 * LinkedIn's allowance is a number on their server that nothing here can
 * read. What CAN be counted, exactly, is what this extension itself asks
 * for — every navigation to a people-search URL is one, and nothing else in
 * a run touches that surface. Counting our own actions is the whole of what
 * is knowable, and it is enough to stop before the wall instead of finding
 * it.
 *
 * A month of testing spent an allowance nobody was counting. This is that
 * counter.
 */
async function countSearchPage() {
  const stored = (await chrome.storage.local.get(BUDGET_KEY))[BUDGET_KEY] || {};
  const month = thisMonth();
  const day = today();
  const next = {
    month,
    day,
    // A new month resets, the way LinkedIn's own allowance does.
    inMonth: stored.month === month ? (stored.inMonth || 0) + 1 : 1,
    inDay: stored.day === day ? (stored.inDay || 0) + 1 : 1,
  };
  await chrome.storage.local.set({ [BUDGET_KEY]: next });
  return next;
}

/** What has been spent, without spending anything. */
async function readBudget() {
  const stored = (await chrome.storage.local.get(BUDGET_KEY))[BUDGET_KEY] || {};
  return {
    inMonth: stored.month === thisMonth() ? stored.inMonth || 0 : 0,
    inDay: stored.day === today() ? stored.inDay || 0 : 0,
  };
}

/*
 * Which sources turn a page by changing the URL.
 *
 * LinkedIn does, and its own Network panel is where that was settled: turning
 * a page fires ONE `document` request for `…&page=N`, and no XHR at all. The
 * adapter had been scrolling twice, waiting 1.4 seconds, then hunting four
 * more for a control whose label reads like "next" — all to add one to a
 * number. When the hunt failed the run stopped and blamed LinkedIn.
 */
const pagesByUrl = (config) => config.source === 'linkedin';

/**
 * The whole answer, if it is already on disk.
 *
 * Returns the records and leaves the tab where it is — no navigation, no
 * count against the allowance. Returns null when the cache cannot cover what
 * this run wants, and the run proceeds normally from page one.
 */
async function servedFromCache(task, config, url) {
  const key = cacheKey(url);
  if (!key) return null;
  const wantPages = Math.min(config.maxPages || 10, 100);
  const plan = planFrom(await store.getMeta(key), wantPages);
  if (plan.reused < wantPages) return null;

  // The stored pages are raw: LinkedIn repeats people across pages, and a
  // live run merges them. Handing back the concatenation would give a cached
  // answer fewer unique people than the search that produced it, and report
  // the inflated number.
  const byKey = new Map();
  for (const record of plan.have) {
    const id = recordKey(record) || record.profileUrl;
    if (id && !byKey.has(id)) byKey.set(id, record);
  }
  const people = [...byKey.values()];

  task.pagesFetched = 0;
  task.pagesReused = plan.reused;
  // Deliberately not `stoppedBecause`: the panel renders that as "stopped
  // because …", and a run answered in full from disk did not stop early.
  await save({
    found: people.length,
    message: `Answered from an earlier run — ${plan.reused} pages, no LinkedIn searches spent.`,
  });
  const want = config.maxResults || 0;
  return want ? people.slice(0, want) : people;
}

/**
 * The rest of the pages, one navigation each.
 *
 * A navigation kills the content script, so this cannot live in the harvest
 * loop; the worker owns it. Every page is scraped on its own and merged here.
 *
 * It stops on the first page that adds nobody new. LinkedIn serves the last
 * page over and over rather than erroring, so "nothing new" is the end — and
 * it is also what a wrong URL looks like, which is the same thing to a run.
 */
async function pageThrough(first, task, config, tabId) {
  const source = sourceFor(config.source);
  const want = config.maxResults || 0;
  /*
   * How deep to go by default.
   *
   * LinkedIn will serve 100 pages of ten to a free account, and paging by URL
   * made reaching all of them reliable for the first time — which is exactly
   * the danger. At 100 pages a run, three runs spend a month's allowance, and
   * the previous version only avoided that by failing to find its own Next
   * button. Ten pages is a hundred people, which is what a search is usually
   * for; the number is the user's to raise.
   */
  const lastPage = Math.min(config.maxPages || 10, 100);

  const byKey = new Map(first.map((r) => [recordKey(r) || r.profileUrl, r]));
  const base = task.currentUrl || task.url || '';
  const start = pageOf(base);
  task.pagesFetched = 1;

  /*
   * What this search already returned, the last time it was run.
   *
   * Most of a month's allowance went on repeats: a run stops early and is
   * re-run, a filter is adjusted and the whole thing starts from page one
   * again. None of those needed to touch LinkedIn. Pages already held are
   * merged in and skipped, so a repeat is free and only going deeper costs.
   */
  const key = cacheKey(base);
  let entry = key ? await store.getMeta(key) : null;
  // Whether this run actually paid for a page. Comparing depths could not
  // tell: `reused` is clamped to the requested depth and the stored depth is
  // not, so a run asking for fewer pages than are held looked like a fetch
  // and refreshed the very timestamps the cache ages on.
  let fetchedAny = false;
  const plan = planFrom(entry, lastPage);
  // Page one came back with `first`, before this function was called. Folded
  // in here, after `entry` exists — above the declarations it was a temporal
  // dead zone, and every multi-page run threw after paying for page one.
  if (key) entry = absorb(entry, start, first);
  for (const record of plan.have) {
    const id = recordKey(record) || record.profileUrl;
    if (id && !byKey.has(id)) byKey.set(id, record);
  }
  if (plan.reused > 1) {
    await save({
      found: byKey.size,
      message: `${plan.reused} pages already held from an earlier run — no searches spent.`,
    });
  }
  task.pagesReused = plan.reused;

  for (let page = Math.max(start + 1, plan.from); page <= lastPage; page += 1) {
    if (cancelRequested) break;
    if (want && byKey.size >= want) {
      task.stoppedBecause = `the limit of ${want}`;
      break;
    }
    if ((await budgetLeft(config)) <= 0) {
      task.stoppedBecause =
        'the monthly LinkedIn search budget is spent — raise it in More options, or wait for the 1st';
      break;
    }

    if (!base) break;
    const url = pageUrl(base, page);

    await chrome.tabs.update(tabId, { url, active: !config.background });
    await waitForTabComplete(tabId, source.urlPart);
    await wait(pageDelay(page - start));
    await countSearchPage();
    task.pagesFetched = page - start + 1;
    fetchedAny = true;
    if (cancelRequested) break;

    await ensureContentScript(tabId);
    const next = await chrome.tabs.sendMessage(tabId, {
      type: 'RUN_SCRAPE',
      config: { ...config, city: task.city, category: task.category, singlePage: true },
    });
    if (!next || !next.ok) {
      task.stoppedBecause = (next && next.error) || `page ${page} could not be read`;
      break;
    }

    const before = byKey.size;
    // Recorded only now, with the page read. Marking it held at navigation
    // time would let a failed scrape or a cancel record a page whose people
    // were never collected, and the next run would skip it for good.
    if (key) entry = absorb(entry, page, next.records || []);
    for (const record of next.records || []) {
      const key = recordKey(record) || record.profileUrl;
      if (key && !byKey.has(key)) byKey.set(key, record);
    }
    if (next.context) task.context = { ...(task.context || {}), ...next.context,
      // The count of people LinkedIn would not name is per page; it has to add
      // up across them or the panel understates it by a factor of the pages.
      withheld: ((task.context || {}).withheld || 0) + (next.context.withheld || 0) };

    if (byKey.size === before) {
      task.stoppedBecause = `page ${page} repeated what page ${page - 1} already had`;
      break;
    }
    await save({ found: byKey.size, message: `Page ${page} — ${byKey.size} so far…` });
  }

  const out = [...byKey.values()];
  // Written even when the run stopped early: a partial answer still saves the
  // pages it did pay for, and the next run resumes past them.
  // Only when something was actually fetched. Rewriting the timestamp on a
  // pure cache hit would keep a week-old answer alive forever, simply because
  // it kept being asked for.
  if (key && fetchedAny) await store.putMeta(key, entry);
  return want ? out.slice(0, want) : out;
}

/**
 * Turn a filter's name into LinkedIn's id for it, by asking LinkedIn.
 *
 * `geoUrn` wants 102784390, not "Chennai", and that number is LinkedIn's own —
 * undocumented, and not derivable from anything held here. But the page has a
 * resolver already: the filter panel's typeahead. This drives it, on whichever
 * LinkedIn search tab is open, and stores the answer so it happens once per
 * name and never again.
 */
/**
 * Store filter-name-to-id pairs the page handed back.
 *
 * Written only when something is genuinely new, because this runs after every
 * task and a run that learned nothing should not touch storage.
 */
async function rememberUrns(pairs) {
  if (!pairs || !pairs.length) return;
  const stored = await chrome.storage.local.get(URN_KEY);
  const { table, changed } = learn(withSeed(stored[URN_KEY]), pairs);
  if (changed) await chrome.storage.local.set({ [URN_KEY]: table });
}

/** Drive the queue until it drains, is cancelled, or hits a fatal error. */
async function drainQueue(config, tabId) {
  for (;;) {
    if (cancelRequested) return;

    const task = nextPending(job.tasks);
    if (!task) return;

    task.status = 'running';
    const { settled, total } = taskProgress(job.tasks);
    await save({
      tasks: job.tasks,
      tabId,
      message: `Search ${settled + 1} of ${total}: ${task.term}${task.point ? ' (grid cell)' : ''}…`,
    });

    try {
      const harvested = await runTask(task, config, tabId);
      task.found = harvested.length;
      task.status = 'done';

      const { added, touched } = absorbInto(records, harvested);
      // Only the rows this task changed are written, so the cost of a progress
      // save is proportional to the task rather than to the whole run.
      await store.putRecords(job.jobId, touched);

      // The first search of each term also reveals where the city is; use that
      // to lay the grid before moving on. Non-geographic sources never set
      // this flag, so the tab URL is not read at all for them.
      if (task.expandsToGrid) {
        task.expandsToGrid = false;
        const centre = await readMapCentre(tabId);
        const grid = expandGridTasks(task, centre, config);
        if (grid.length) job.tasks = insertAfter(job.tasks, task.id, grid);
        else if (!centre) task.error = 'Could not read the map centre — grid skipped.';
      }

      // If every selector for a field has stopped matching, stop now rather
      // than filling a spreadsheet with blank columns. Which fields count
      // depends on the source: a business always has a place link, a person
      // always has a profile URL.
      // A current-tab run learns its search from the page, so fold that back
      // into the job for the status line and the download's filename.
      if (task.context && task.context.query && !job.config.category) {
        await save({ config: { ...job.config, category: task.context.query } });
      }

      const health = assessHealth(records, gatesFor(sourceFor(config.source)));
      await save({
        tasks: job.tasks,
        found: records.length,
        health: { ok: health.ok, rates: health.rates, sample: health.sample },
        message: `${task.term}: ${harvested.length} listings (${added} new).`,
      });

      if (!health.ok) {
        await save({
          status: 'paused',
          phase: 'idle',
          error: health.reason,
          message: health.reason,
        });
        return;
      }
    } catch (err) {
      const message = String((err && err.message) || err);
      if (message === 'cancelled' || cancelRequested) {
        task.status = 'pending'; // leave it for a resume
        return;
      }
      // Some failures are the tab moving, not the scrape being wrong: Chrome
      // closes the message channel when the page it belongs to is put into
      // the back/forward cache. Losing a whole search to that is a bad trade
      // when re-running it costs one navigation.
      task.attempts = (task.attempts || 0) + 1;
      if (isTransient(message) && task.attempts < 3) {
        task.status = 'pending';
        await save({ tasks: job.tasks, message: `Retrying search: ${task.term}…` });
        console.warn('[leadmine] task retrying', task.id, message);
        continue;
      }

      // One failed cell must not sink the whole run.
      task.status = 'failed';
      task.error = message;
      await save({ tasks: job.tasks });
      console.warn('[leadmine] task failed', task.id, message);
    }
  }
}

/* --------------------------------------------------------- email enrichment */

async function enrichEmails(records, config) {
  const targets = records.filter((r) => r.website && !r.email);
  await save({ phase: 'emails', emailed: 0, total: targets.length, message: 'Looking up emails…' });

  let done = 0;
  let hits = 0;

  await mapWithConcurrency(targets, config.emailConcurrency || 4, async (record) => {
    if (cancelRequested) return;
    try {
      const { email, allEmails, source, social } = await findEmailForSite(record.website, {
        timeout: config.emailTimeout || 12000,
        followContactPage: config.followContactPage !== false,
      });
      if (email) {
        record.email = email;
        record.allEmails = allEmails.slice(1, 5);
        record.emailSource = source;
        hits += 1;
      }
      // Social profiles are free — they come out of the HTML already fetched.
      if (social) {
        record.facebook = social.facebook || '';
        record.instagram = social.instagram || '';
        record.linkedin = social.linkedin || '';
        record.twitter = social.twitter || '';
        record.youtube = social.youtube || '';
      }
    } catch (err) {
      console.warn('[leadmine] email lookup failed', record.website, err);
    }
    done += 1;
    if (done % 3 === 0 || done === targets.length) await save({ emailed: done, emailsFound: hits });
  });

  await save({ emailed: done, emailsFound: hits });
}

async function verifyEmails(records, config) {
  const targets = records.filter((r) => r.email);
  await save({ phase: 'verify', verified: 0, total: targets.length, message: 'Verifying emails…' });

  let done = 0;
  let good = 0;

  await mapWithConcurrency(targets, config.verifyConcurrency || 6, async (record) => {
    if (cancelRequested) return;
    try {
      const { status, reason } = await verifyEmail(record.email, { timeout: config.verifyTimeout || 8000 });
      record.emailStatus = status;
      record.emailStatusReason = reason;
      if (isSendable(status)) good += 1;
    } catch (err) {
      record.emailStatus = 'unknown';
      console.warn('[leadmine] verification failed', record.email, err);
    }
    done += 1;
    if (done % 5 === 0 || done === targets.length) await save({ verified: done, sendable: good });
  });

  await save({ verified: done, sendable: good });
}

/* ------------------------------------------------------------------ the run */

async function finishRun(config) {
  if (cancelRequested) {
    await save({
      status: 'cancelled',
      phase: 'done',
      message: 'Stopped — partial results kept.',
      finishedAt: Date.now(),
    });
    return;
  }

  // Narrowing happens before enrichment for the same reason as the dedupe
  // below: there is no point fetching a website for a listing the user has
  // already said they do not want.
  const source = sourceFor(config.source);
  const filterText = String(config.categoryFilter || '').trim();
  if (filterText) {
    const { kept, dropped } = filterByCategory(records, config.categoryFilter, source.filterField);
    if (dropped.length) {
      // Marked, never deleted. A filter that sets aside everything is almost
      // always the wrong filter, and deleting the rows destroys the evidence
      // at exactly the moment the user needs it — along with an hour of
      // scraping they would have to repeat to get it back.
      await store.putRecords(job.id, dropped.map((r) => ({ ...r, setAside: filterText })));
      records = kept;
      await save({
        filteredOut: dropped.length,
        found: records.length,
        message: kept.length
          ? `${dropped.length} listings set aside — ${source.filterLabel.toLowerCase()} did not match.`
          : `All ${dropped.length} were set aside by the ${source.filterLabel.toLowerCase()} filter “${filterText}”. They are kept — open Results to see them.`,
      });
    }
  }

  // Cross-run dedupe happens before enrichment so we never spend fetches on
  // businesses the user already exported.
  if (config.skipSeen) {
    const seen = await store.filterSeen(records.map((r) => r.key));
    if (seen.size) {
      // These rows were written as each task finished, so drop them from the
      // database too — not just from the working set.
      await store.deleteRecords(records.filter((r) => seen.has(r.key)).map((r) => r.key));
      records = records.filter((r) => !seen.has(r.key));
      await save({
        skippedSeen: seen.size,
        found: records.length,
        message: `${seen.size} already-seen businesses skipped.`,
      });
    }
  }

  if (source.supportsEmails && config.fetchEmails !== false) await enrichEmails(records, config);
  if (source.supportsEmails && config.verifyEmails !== false && !cancelRequested) {
    await verifyEmails(records, config);
  }

  // Enrichment mutated the working set in place; flush it all once at the end.
  await store.putRecords(job.jobId, records);

  if (config.rememberSeen !== false) {
    await store.addSeen(records.map((r) => r.key || recordKey(r)).filter(Boolean));
  }

  const failedTasks = job.tasks.filter((t) => t.status === 'failed');
  const firstError = (failedTasks.find((t) => t.error) || {}).error || '';
  await save({
    status: 'done',
    phase: 'done',
    found: records.length,
    error: firstError,
    message:
      `${records.length} ${source.noun} from ${job.tasks.length} ` +
      `${job.tasks.length === 1 ? 'search' : 'searches'}` +
      (failedTasks.length ? `, ${failedTasks.length} of them failed` : '') +
      '.',
    finishedAt: Date.now(),
  });
}

async function execute(config, tabId) {
  startKeepAlive();
  try {
    await drainQueue(config, tabId);
    if (cancelRequested) {
      await save({ status: 'paused', phase: 'idle', message: 'Stopped — press Resume to carry on.' });
      return;
    }
    await finishRun(config);
  } catch (err) {
    const message = String((err && err.message) || err);
    await save({ status: 'error', phase: 'done', error: message, message, finishedAt: Date.now() });
  } finally {
    stopKeepAlive();
  }
}

/**
 * The tab a run will drive.
 *
 * Normally the extension opens its own and navigates it per task. In
 * current-tab mode it adopts the tab the user already has open — the whole
 * point being that navigating would discard the filters they set by hand.
 */
async function acquireTab(config) {
  if (!config.useCurrentTab) {
    // A fresh tab: after a browser restart the previous one is long gone.
    return chrome.tabs.create({ url: 'about:blank', active: !config.background });
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const source = sourceFor(config.source);
  if (!active || !String(active.url || '').includes(source.urlPart)) {
    throw new Error(
      `Open your ${source.label} search in this tab first, then press Start. ` +
        'Current-tab mode scrapes the page you are on so your filters are kept.'
    );
  }
  return active;
}

async function startJob(config) {
  if (job.status === 'running') throw new Error('A scrape is already running.');

  const settings = { ...config, source: config.source || DEFAULT_SOURCE };
  const tasks = buildTaskList(settings);
  if (!tasks.length) throw new Error('Enter a search, or a batch list.');

  cancelRequested = false;
  // A fresh job id keeps this run's rows separate from the previous one's.
  const jobId = `job-${Date.now()}`;
  records = [];
  await save({
    ...DEFAULT_JOB,
    status: 'running',
    phase: 'listing',
    config: settings,
    jobId,
    tasks,
    message: `Opening ${sourceFor(settings.source).label}…`,
    startedAt: Date.now(),
  });

  const tab = await acquireTab(settings);
  await save({ tabId: tab.id });
  await execute(settings, tab.id);
}

/** Continue a run that was interrupted or stopped, without losing its results. */
async function resumeJob() {
  await ready;
  if (job.status === 'running') throw new Error('The run is already going.');
  if (!job.tasks.some((t) => t.status === 'pending')) throw new Error('Nothing left to resume.');

  const config = job.config || {};
  cancelRequested = false;
  await save({ status: 'running', phase: 'listing', error: '', message: 'Resuming…' });

  const tab = await acquireTab(config);
  await save({ tabId: tab.id });
  await execute(config, tab.id);
}

async function cancelJob() {
  cancelRequested = true;
  if (job.tabId != null) {
    try {
      await chrome.tabs.sendMessage(job.tabId, { type: 'CANCEL_SCRAPE' });
    } catch {
      /* tab gone */
    }
  }
  await save({ message: 'Stopping…' });
}

async function clearJob() {
  if (job.jobId) await store.clearRecords(job.jobId);
  records = [];
  await save({ ...DEFAULT_JOB });
}

/* --------------------------------------------------------------- messaging */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  const reply = (promise) => {
    promise.then(
      (value) => sendResponse({ ok: true, ...value }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  };

  switch (msg.type) {
    case 'GET_JOB':
      return reply(
        ready.then(async () => ({
          job: publicJob(),
          seen: await store.countSeen(),
          budget: await readBudget(),
        }))
      );

    case 'START_JOB':
      // Fire and forget: the run outlives this message and reports through
      // JOB_UPDATE broadcasts.
      ready
        .then(() => startJob(msg.config))
        .catch((err) => save({ status: 'error', error: String(err.message || err), message: String(err.message || err) }));
      sendResponse({ ok: true });
      return undefined;

    case 'RESUME_JOB':
      resumeJob().catch((err) =>
        save({ status: 'error', error: String(err.message || err), message: String(err.message || err) })
      );
      sendResponse({ ok: true });
      return undefined;

    case 'CANCEL_JOB':
      return reply(cancelJob().then(() => ({})));

    case 'GET_RECORDS':
      // The side panel normally reads IndexedDB itself; this stays for any
      // caller that cannot, and for small result sets.
      return reply(ready.then(() => ({ records, config: job.config })));

    case 'CLEAR_JOB':
      return reply(clearJob().then(() => ({ job: publicJob() })));

    case 'CLEAR_SEEN':
      return reply(store.clearSeen().then(() => ({ seen: 0 })));

    case 'SCRAPE_PROGRESS': {
      // Relayed from the content script while a single search is running.
      const { settled, total } = taskProgress(job.tasks);
      const prefix = total > 1 ? `Search ${Math.min(settled + 1, total)}/${total} — ` : '';
      const patch = { phase: msg.phase, detailed: msg.detailed };
      if (msg.phase === 'listing') patch.message = `${prefix}found ${msg.found} listings…`;
      if (msg.phase === 'details') patch.message = `${prefix}listing ${msg.detailed} of ${msg.total}…`;
      save(patch);
      return undefined;
    }

    default:
      return undefined;
  }
});

/**
 * Clicking the toolbar icon opens the side panel. Without this the action has
 * no popup and would do nothing at all.
 */
chrome.runtime.onInstalled.addListener(() => {
  ready.catch(() => {});
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[leadmine] side panel behaviour', err));
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
