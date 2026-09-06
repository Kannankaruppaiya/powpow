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

async function runTask(task, config, tabId) {
  const source = sourceFor(config.source);

  if (!task.useCurrentTab) {
    const url = buildUrl(source.id, task.term, task.point);
    await chrome.tabs.update(tabId, { url, active: !config.background });
    await waitForTabComplete(tabId, source.urlPart);
    // Maps hydrates its feed after `complete`; a short settle avoids a race.
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (cancelRequested) throw new Error('cancelled');

  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'RUN_SCRAPE',
    config: { ...config, city: task.city, category: task.category },
  });
  if (!response) {
    throw new Error(`The ${source.label} tab stopped responding. Keep it open while scraping.`);
  }
  if (!response.ok) throw new Error(response.error || 'Scrape failed.');

  // The page knows what it is searching for; on a current-tab run that is the
  // only place the query and the user's filters exist.
  if (response.context) task.context = response.context;
  return response.records || [];
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
  if (config.categoryFilter && String(config.categoryFilter).trim()) {
    const { kept, dropped } = filterByCategory(records, config.categoryFilter, source.filterField);
    if (dropped.length) {
      await store.deleteRecords(dropped.map((r) => r.key));
      records = kept;
      await save({
        filteredOut: dropped.length,
        found: records.length,
        message: `${dropped.length} listings set aside — ${source.filterLabel.toLowerCase()} did not match.`,
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
      return reply(ready.then(async () => ({ job: publicJob(), seen: await store.countSeen() })));

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
