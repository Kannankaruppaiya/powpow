/** LeadMine — background service worker. */

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
import { cacheKey, planFrom, absorb, markEnd, clearEnd } from '../lib/search-cache.js';
import { annotatePost, narrowPosts } from '../lib/posts.js';
import { suppressionChecker } from '../lib/crm.js';
import { HOOK_KEY, DEFAULT_HOOK, buildHookMessage, sendToPowPow, shouldSend } from '../lib/powpow.js';
import { loadGccMatcher } from '../lib/gcc.js';
import {
  SCHEDULE_KEY, ALARM_NAME, DEFAULT_SCHEDULE, nextRunAt, scheduledConfig, cannotSchedule, missedRun,
} from '../lib/schedule.js';

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
  // Sites that needed a real tab to show their email.
  rendered: 0,
  // Rows on the do-not-contact list, set aside before any enrichment.
  suppressed: 0,
  // Started by the schedule rather than by a person.
  scheduled: false,
  // What happened when the run was handed to PowPow, in words.
  notified: '',
  skippedSeen: 0,
  filteredOut: 0,
  // Set when a settled run survives a restart.
  stale: false,
  health: null,
  tabId: null,
  startedAt: null,
  finishedAt: null,
};

let job = { ...DEFAULT_JOB };
// The working set for the current run.
let records = [];
let cancelRequested = false;
let keepAlive = null;

/** Chrome evicts an idle MV3 service worker after 30 seconds, which would abandon a scrape halfway through. */
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

  // A worker restart means the in-flight task was abandoned.
  if (job.status === 'running') {
    for (const task of job.tasks) if (task.status === 'running') task.status = 'pending';
    const resumable = job.tasks.some((t) => t.status === 'pending');
    job.status = resumable ? 'paused' : 'done';
    job.message = resumable
      ? 'Interrupted — press Resume to carry on where it stopped.'
      : `Recovered ${records.length} results from the previous run.`;
  }

  // A run that had already finished before this restart is history.
  if (['done', 'error', 'cancelled'].includes(job.status)) job.stale = true;

  return job;
}

const ready = loadJob();

/** Persist the job metadata — the queue and the counters only. */
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
    // "1 searches failed" with no reason is not a report.
    taskError: (tasks.find((t) => t.status === 'failed' && t.error) || {}).error || '',
    // People the source showed but refused to identify, across every search.
    withheld: tasks.reduce((n, t) => n + ((t.context && t.context.withheld) || 0), 0),
    // Why collection ended, from the last search that ran.
    stoppedBecause:
      [...tasks].reverse().find((t) => t.stoppedBecause) &&
      [...tasks].reverse().find((t) => t.stoppedBecause).stoppedBecause,
    canResume: job.status === 'paused' && tasks.some((t) => t.status === 'pending'),
    // Selectors that stopped matching and were found again from memory.
    healed: [...new Set(tasks.flatMap((t) => (t.context && t.context.healed) || []))],
    // A preview only — the side panel pages the full set out of IndexedDB.
    preview: records.slice(0, 60),
  };
}

/* ------------------------------------------------------------- tab plumbing */

/** Wait until the tab has finished loading a URL containing `expect`. */
function waitForTabComplete(tabId, expect = '/maps/', timeout = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      // Every source waits here, not only Maps.
      reject(new Error(`Timed out waiting for the page to load (${expect}).`));
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
      'src/content/heal.js',
      'src/content/engine.js',
      'src/content/adapters/maps.js',
      'src/content/adapters/linkedin.js',
      'src/content/adapters/web.js',
      'src/content/adapters/linkedin-posts.js',
    ],
  });
  await new Promise((r) => setTimeout(r, 300));
}

/** Maps rewrites its own URL with the map centre once the results settle. */
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

/** A failure that is about the tab rather than about the page. */
function isTransient(message) {
  return /back\/forward cache|message channel is closed|message port closed|Receiving end does not exist|No tab with id|Frame with ID/i.test(
    String(message || '')
  );
}

async function runTask(task, config, tabId) {
  const source = sourceFor(config.source);

  if (!task.useCurrentTab) {
    // A LinkedIn task built from facets already knows its exact URL.
    const url = task.url || buildUrl(source.id, task.term, task.point);

    // A search already answered costs nothing — including its first page.
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

    // Filters LinkedIn has to apply for us.
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
      // Pressing "Show results" makes LinkedIn run the search again, once per filter.
      for (let i = 0; i < task.applyFilters.length; i += 1) await countSearchPage();
      // The results list rebuilds after a filter lands.
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (cancelRequested) throw new Error('cancelled');

  await ensureContentScript(tabId);

  // Page from where the tab actually is.
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

  // The page knows what it is searching for.
  if (response.context) task.context = response.context;
  // The page is the only place a filter's name and LinkedIn's id for it appear together.
  if (response.context && response.context.learned) await rememberUrns(response.context.learned);
  if (response.stoppedBecause) task.stoppedBecause = response.stoppedBecause;

  let records = response.records || [];
  if (pagesByUrl(config) && !task.useCurrentTab) {
    records = await pageThrough(records, task, config, tabId);
  }
  return records;
}

/* ------------------------------------------------------------------ pacing */

/** How long to wait between pages. */
function pageDelay(pagesSoFar = 0) {
  const base = 1800 + Math.min(pagesSoFar, 10) * 260;
  return Math.round(base + Math.random() * 3400);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------- the search budget */

const BUDGET_KEY = 'searchBudget';

// Roughly what a free LinkedIn account gets in a calendar month before the commercial-use limit lands.
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

/** Count one search-results page fetched from LinkedIn. */
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

// Which sources turn a page by changing the URL.
const pagesByUrl = (config) => config.source === 'linkedin';

/** The whole answer, if it is already on disk. */
async function servedFromCache(task, config, url) {
  const key = cacheKey(url);
  if (!key) return null;
  const wantPages = Math.min(config.maxPages || 10, 100);
  const plan = planFrom(await store.getMeta(key), wantPages);
  // A search that has fewer pages than were asked for is still answered in full once all of its pages are held.
  if (plan.reused < wantPages && !plan.complete) return null;

  // The stored pages are raw: LinkedIn repeats people across pages, and a live run merges them.
  const byKey = new Map();
  for (const record of plan.have) {
    const id = recordKey(record) || record.profileUrl;
    if (id && !byKey.has(id)) byKey.set(id, record);
  }
  const people = [...byKey.values()];

  task.pagesFetched = 0;
  task.pagesReused = plan.reused;
  // Deliberately not `stoppedBecause`.
  await save({
    found: people.length,
    message: `Answered from an earlier run — ${plan.reused} pages, no LinkedIn searches spent.`,
  });
  const want = config.maxResults || 0;
  return want ? people.slice(0, want) : people;
}

/** The rest of the pages, one navigation each. */
async function pageThrough(first, task, config, tabId) {
  const source = sourceFor(config.source);
  const want = config.maxResults || 0;
  // How deep to go by default.
  const lastPage = Math.min(config.maxPages || 10, 100);

  const byKey = new Map(first.map((r) => [recordKey(r) || r.profileUrl, r]));
  const base = task.currentUrl || task.url || '';
  const start = pageOf(base);
  task.pagesFetched = 1;

  // What this search already returned, the last time it was run.
  const key = cacheKey(base);
  let entry = key ? await store.getMeta(key) : null;
  // Whether this run actually paid for a page.
  let fetchedAny = false;
  const plan = planFrom(entry, lastPage);
  // Page one came back with `first`, before this function was called.
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

  // Every page this search has is already held: going on would only pay to be shown the last page again.
  const firstToFetch = plan.complete ? lastPage + 1 : Math.max(start + 1, plan.from);
  for (let page = firstToFetch; page <= lastPage; page += 1) {
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
    // Recorded only now, with the page read.
    if (key) entry = absorb(entry, page, next.records || []);
    for (const record of next.records || []) {
      const key = recordKey(record) || record.profileUrl;
      if (key && !byKey.has(key)) byKey.set(key, record);
    }
    if (next.context) task.context = { ...(task.context || {}), ...next.context,
      // The count of people LinkedIn would not name is per page.
      withheld: ((task.context || {}).withheld || 0) + (next.context.withheld || 0) };

    if (byKey.size === before) {
      task.stoppedBecause = `page ${page} repeated what page ${page - 1} already had`;
      // Where the search ends, so a repeat is answered from disk instead of paying to rediscover it.
      if (key) entry = markEnd(entry, page - 1);
      break;
    }
    // A page past a recorded end had people on it: the search grew.
    if (key && entry && entry.end !== undefined && page > entry.end) entry = clearEnd(entry);
    await save({ found: byKey.size, message: `Page ${page} — ${byKey.size} so far…` });
  }

  const out = [...byKey.values()];
  // Written even when the run stopped early.
  if (key && fetchedAny) await store.putMeta(key, entry);
  return want ? out.slice(0, want) : out;
}

/** Turn a filter's name into LinkedIn's id for it, by asking LinkedIn. */
/** Store filter-name-to-id pairs the page handed back. */
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
      let harvested = await runTask(task, config, tabId);
      // A post is dated and judged as it arrives.
      if (config.source === 'posts') {
        const topic = task.category || (task.context && task.context.query) || config.category || '';
        const now = Date.now();
        harvested = harvested.map((record) => annotatePost(record, { now, topic }));
      }
      task.found = harvested.length;
      task.status = 'done';

      const { added, touched } = absorbInto(records, harvested);
      // Only the rows this task changed are written.
      await store.putRecords(job.jobId, touched);

      // The first search of each term also reveals where the city is; use that to lay the grid before moving on.
      if (task.expandsToGrid) {
        task.expandsToGrid = false;
        const centre = await readMapCentre(tabId);
        const grid = expandGridTasks(task, centre, config);
        if (grid.length) job.tasks = insertAfter(job.tasks, task.id, grid);
        else if (!centre) task.error = 'Could not read the map centre — grid skipped.';
      }

      // If every selector for a field has stopped matching.
      if (task.context && task.context.query && !job.config.category) {
        await save({ config: { ...job.config, category: task.context.query } });
      }

      const health = assessHealth(records, gatesFor(sourceFor(config.source)));
      await save({
        tasks: job.tasks,
        found: records.length,
        health: { ok: health.ok, rates: health.rates, sample: health.sample },
        message: `${task.term}: ${harvested.length} ${sourceFor(config.source).noun} (${added} new).`,
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
      // Some failures are the tab moving, not the scrape being wrong.
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

// A real tab, for the sites a plain fetch cannot read.
let renderChain = Promise.resolve();
let rendersThisRun = 0;

function renderInTab(url, { timeout = 20000, settle = 1500 } = {}) {
  const work = renderChain.then(async () => {
    if (cancelRequested) return '';
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url, active: false });
      // "http" rather than the host.
      await waitForTabComplete(tab.id, 'http', timeout);
      await wait(settle);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.documentElement.outerHTML,
      });
      return (result && result.result) || '';
    } catch (err) {
      console.warn('[leadmine] render failed', url, err);
      return '';
    } finally {
      if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    }
  });
  // The chain must survive a failure, or one bad site stops every later one.
  renderChain = work.catch(() => '');
  return work;
}

async function enrichEmails(records, config) {
  const targets = records.filter((r) => r.website && (!r.email || !r.siteText));
  await save({ phase: 'emails', emailed: 0, total: targets.length, message: 'Looking up emails…' });

  let done = 0;
  let hits = 0;
  rendersThisRun = 0;
  const renderCap = Number(config.maxRenders) || 150;
  const render =
    config.renderBlockedSites === false
      ? null
      : (url) => {
          if (rendersThisRun >= renderCap) return Promise.resolve('');
          rendersThisRun += 1;
          return renderInTab(url);
        };

  await mapWithConcurrency(targets, config.emailConcurrency || 4, async (record) => {
    if (cancelRequested) return;
    try {
      const found = await findEmailForSite(record.website, {
        timeout: config.emailTimeout || 12000,
        followContactPage: config.followContactPage !== false,
        render,
      });
      const { email, allEmails, source, social, siteText, structured, rendered } = found;
      if (email && !record.email) {
        record.email = email;
        record.allEmails = allEmails.slice(1, 5);
        record.emailSource = source;
        hits += 1;
      }
      // What the site says about itself, for the lead judge.
      if (siteText) record.siteText = siteText;
      if (structured) {
        if (structured.description) record.siteDescription = structured.description;
        if (structured.people.length) record.sitePeople = structured.people.join('; ');
        if (structured.employees) record.employees = structured.employees;
        if (!record.phone && structured.phones.length) record.phone = structured.phones[0];
      }
      if (rendered) record.siteRendered = true;
      // Social profiles are free — they come out of the HTML already fetched.
      if (social) {
        record.facebook = social.facebook || record.facebook || '';
        record.instagram = social.instagram || record.instagram || '';
        record.linkedin = social.linkedin || record.linkedin || '';
        record.twitter = social.twitter || record.twitter || '';
        record.youtube = social.youtube || record.youtube || '';
      }
    } catch (err) {
      console.warn('[leadmine] email lookup failed', record.website, err);
    }
    done += 1;
    if (done % 3 === 0 || done === targets.length) {
      await save({ emailed: done, emailsFound: hits, rendered: rendersThisRun });
    }
  });

  await save({ emailed: done, emailsFound: hits, rendered: rendersThisRun });
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

  // Narrowing happens before enrichment for the same reason as the dedupe below.
  const source = sourceFor(config.source);

  // Posts: keep the recent ones that ask for something.
  if (source.id === 'posts') {
    const now = Date.now();
    records = records.map((r) => annotatePost(r, { now, topic: r.searchCategory || config.category || '' }));
    const days = Number(config.postsDays) || 10;
    const { kept, dropped } = narrowPosts(records, { days, intentOnly: config.postsIntentOnly !== false, now });
    if (dropped.length) await store.putRecords(job.jobId, dropped);
    records = kept;
    await save({
      filteredOut: dropped.length,
      found: records.length,
      message: kept.length
        ? `${kept.length} recent posts kept — ${dropped.length} set aside (older than ${days} days, or not asking for anything).`
        : `No post from the last ${days} days asked for anything. ${dropped.length} set aside — open Results to see them.`,
    });
  }

  const filterText = String(config.categoryFilter || '').trim();
  if (filterText) {
    const { kept, dropped } = filterByCategory(records, config.categoryFilter, source.filterField);
    if (dropped.length) {
      // Marked, never deleted.
      await store.putRecords(job.jobId, dropped.map((r) => ({ ...r, setAside: filterText })));
      records = kept;
      await save({
        // Added to, not replaced: a Posts run may already have set some aside.
        filteredOut: (job.filteredOut || 0) + dropped.length,
        found: records.length,
        message: kept.length
          ? `${dropped.length} ${source.noun} set aside — ${source.filterLabel.toLowerCase()} did not match.`
          : `All ${dropped.length} were set aside by the ${source.filterLabel.toLowerCase()} filter “${filterText}”. They are kept — open Results to see them.`,
      });
    }
  }

  // The do-not-contact list, before anything else is spent on these rows.
  const suppression = await store.getSuppression().catch(() => []);
  if (suppression.length) {
    const notes = await store.getNotes(records.map((r) => r.key)).catch(() => new Map());
    const blocked = suppressionChecker(suppression);
    const hits = records.filter((r) => blocked(r, notes.get(r.key) || {}));
    if (hits.length) {
      await store.putRecords(job.jobId, hits.map((r) => ({ ...r, setAside: 'on your do-not-contact list' })));
      const drop = new Set(hits.map((r) => r.key));
      records = records.filter((r) => !drop.has(r.key));
      await save({
        suppressed: hits.length,
        filteredOut: (job.filteredOut || 0) + hits.length,
        found: records.length,
        message: `${hits.length} ${source.noun} set aside — on your do-not-contact list.`,
      });
    }
  }

  // Cross-run dedupe happens before enrichment so we never spend fetches on businesses the user already exported.
  if (config.skipSeen) {
    const seen = await store.filterSeen(records.map((r) => r.key));
    if (seen.size) {
      // These rows were written as each task finished, so drop them from the database too.
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

  await notifyPowPow(config);
}

/** Hand the finished run to PowPow, if the user asked for that. */
async function notifyPowPow(config) {
  const stored = (await chrome.storage.local.get(HOOK_KEY))[HOOK_KEY] || {};
  const settings = { ...DEFAULT_HOOK, ...stored };
  if (!shouldSend(settings, { scheduled: job.scheduled })) return;

  const notes = await store.getNotes(records.map((r) => r.key)).catch(() => new Map());
  const message = buildHookMessage({
    records,
    notes,
    config,
    job,
    scheduled: job.scheduled,
    maxLeads: Number(settings.maxLeads) || 15,
    gccOf: await loadGccMatcher(),
  });
  const sent = await sendToPowPow(settings, message);
  await save({
    notified: sent.ok ? `Sent to PowPow (${settings.channel === 'last' ? 'your last chat' : settings.channel}).` : sent.error,
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

/** The tab a run will drive. */
async function acquireTab(config) {
  if (!config.useCurrentTab) {
    // A fresh tab: after a browser restart the previous one is long gone.
    return chrome.tabs.create({ url: 'about:blank', active: !config.background });
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const source = sourceFor(config.source);
  const url = String((active && active.url) || '');
  const fits = source.matchesTab ? source.matchesTab(url) : url.includes(source.urlPart);
  if (!active || !fits) {
    throw new Error(
      `Open your ${source.label} search in this tab first, then press Start. ` +
        'Current-tab mode scrapes the page you are on so your filters are kept.'
    );
  }
  return active;
}

async function startJob(config, { scheduled = false } = {}) {
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
    scheduled,
    message: `${scheduled ? 'Scheduled run — ' : ''}Opening ${sourceFor(settings.source).label}…`,
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
      // Fire and forget: the run outlives this message and reports through JOB_UPDATE broadcasts.
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
      // The side panel normally reads IndexedDB itself.
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
      if (msg.phase === 'listing') {
        const noun = sourceFor(job.config && job.config.source).noun;
        patch.message = `${prefix}found ${msg.found} ${noun}…`;
      }
      if (msg.phase === 'details') patch.message = `${prefix}listing ${msg.detailed} of ${msg.total}…`;
      save(patch);
      return undefined;
    }

    default:
      return undefined;
  }
});

/* ---------------------------------------------------------------- schedule */

/** Arm the alarm for the saved schedule, or clear it. */
async function armSchedule({ catchUp = false } = {}) {
  const schedule = { ...DEFAULT_SCHEDULE, ...((await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY] || {}) };
  await chrome.alarms.clear(ALARM_NAME);
  if (!schedule.enabled || cannotSchedule(schedule.config)) return;
  // Chrome was closed at the scheduled time.
  if (catchUp && missedRun(schedule)) {
    void runScheduled();
    return;
  }
  const when = nextRunAt(schedule);
  if (when) await chrome.alarms.create(ALARM_NAME, { when });
}

/** At startup Chrome may fire an overdue alarm while the catch-up above is starting the same run. */
let scheduledStarting = false;

async function runScheduled() {
  if (scheduledStarting) return;
  scheduledStarting = true;
  await ready;
  const schedule = { ...DEFAULT_SCHEDULE, ...((await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY] || {}) };
  try {
    if (!schedule.enabled) return;
    const why = cannotSchedule(schedule.config);
    if (why) throw new Error(why);
    // A run already going is the user's; the schedule waits for tomorrow rather than stopping it.
    if (job.status === 'running') return;
    await chrome.storage.local.set({ [SCHEDULE_KEY]: { ...schedule, lastRunAt: Date.now() } });
    const started = startJob(scheduledConfig(schedule.config), { scheduled: true });
    // The job's own status guards from here on.
    scheduledStarting = false;
    await started;
  } catch (err) {
    await save({ status: 'error', error: String(err.message || err), message: String(err.message || err) });
  } finally {
    scheduledStarting = false;
    await armSchedule();
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM_NAME) void runScheduled();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SCHEDULE_KEY]) {
    // Only the panel's edits re-arm.
    void armSchedule();
  }
});

/** Clicking the toolbar icon opens the side panel. */
chrome.runtime.onInstalled.addListener(() => {
  ready.catch(() => {});
  void armSchedule();
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[leadmine] side panel behaviour', err));
});

chrome.runtime.onStartup.addListener(() => {
  void armSchedule({ catchUp: true });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
