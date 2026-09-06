/**
 * Maps Lead Scraper — background service worker.
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
 */

import { findEmailForSite, mapWithConcurrency } from '../lib/email.js';
import { verifyEmail, isSendable } from '../lib/verify.js';
import { buildSearchUrl, parseMapUrl } from '../lib/geo.js';
import { dedupeRecords, absorbInto, addToSeen, filterUnseen } from '../lib/dedupe.js';
import { buildTaskList, expandGridTasks, insertAfter, nextPending, taskProgress } from '../lib/tasks.js';

const STORE_KEY = 'mls.job';
const SEEN_KEY = 'mls.seen';

const DEFAULT_JOB = {
  status: 'idle', // idle | running | paused | done | error | cancelled
  phase: 'idle', // listing | details | emails | verify | done
  message: '',
  error: '',
  config: null,
  tasks: [],
  records: [],
  found: 0,
  detailed: 0,
  total: 0,
  emailed: 0,
  emailsFound: 0,
  verified: 0,
  sendable: 0,
  skippedSeen: 0,
  tabId: null,
  startedAt: null,
  finishedAt: null,
};

let job = { ...DEFAULT_JOB };
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
  const stored = await chrome.storage.local.get(STORE_KEY);
  if (stored[STORE_KEY]) job = { ...DEFAULT_JOB, ...stored[STORE_KEY] };

  // A worker restart means the in-flight task was abandoned. Say so honestly
  // and offer to resume rather than silently reporting the run as finished.
  if (job.status === 'running') {
    for (const task of job.tasks) if (task.status === 'running') task.status = 'pending';
    const resumable = job.tasks.some((t) => t.status === 'pending');
    job.status = resumable ? 'paused' : 'done';
    job.message = resumable
      ? 'Interrupted — press Resume to carry on where it stopped.'
      : 'Recovered results from the previous run.';
  }
  return job;
}

const ready = loadJob();

async function save(patch = {}) {
  job = { ...job, ...patch };
  await chrome.storage.local.set({ [STORE_KEY]: job });
  try {
    await chrome.runtime.sendMessage({ type: 'JOB_UPDATE', job: publicJob() });
  } catch {
    /* no popup listening */
  }
}

/** The popup renders a preview and counters, never the whole result set. */
function publicJob() {
  const { records, tasks, ...rest } = job;
  const { settled, total } = taskProgress(tasks);
  return {
    ...rest,
    count: records.length,
    phonesFound: records.filter((r) => r.phone).length,
    websitesFound: records.filter((r) => r.website).length,
    tasksSettled: settled,
    tasksTotal: total,
    canResume: job.status === 'paused' && tasks.some((t) => t.status === 'pending'),
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
    files: ['src/lib/parse.js', 'src/content/scraper.js'],
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
  const url = buildSearchUrl(task.term, task.point);
  await chrome.tabs.update(tabId, { url, active: !config.background });
  await waitForTabComplete(tabId);
  // Maps hydrates its feed after `complete`; a short settle avoids a race.
  await new Promise((r) => setTimeout(r, 2500));
  if (cancelRequested) throw new Error('cancelled');

  await ensureContentScript(tabId);

  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'RUN_SCRAPE',
    config: { ...config, city: task.city, category: task.category },
  });
  if (!response) throw new Error('The Maps tab stopped responding. Keep it open while scraping.');
  if (!response.ok) throw new Error(response.error || 'Scrape failed.');
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
      const records = await runTask(task, config, tabId);
      task.found = records.length;
      task.status = 'done';

      const added = absorbInto(job.records, records);

      // The first search of each term also reveals where the city is; use that
      // to lay the grid before moving on.
      if (task.expandsToGrid) {
        task.expandsToGrid = false;
        const centre = await readMapCentre(tabId);
        const grid = expandGridTasks(task, centre, config);
        if (grid.length) job.tasks = insertAfter(job.tasks, task.id, grid);
        else if (!centre) task.error = 'Could not read the map centre — grid skipped.';
      }

      await save({
        tasks: job.tasks,
        records: job.records,
        found: job.records.length,
        message: `${task.term}: ${records.length} listings (${added} new).`,
      });
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
      console.warn('[maps-lead-scraper] task failed', task.id, message);
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
      console.warn('[maps-lead-scraper] email lookup failed', record.website, err);
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
      console.warn('[maps-lead-scraper] verification failed', record.email, err);
    }
    done += 1;
    if (done % 5 === 0 || done === targets.length) await save({ verified: done, sendable: good });
  });

  await save({ verified: done, sendable: good });
}

/* ------------------------------------------------------------------ the run */

async function finishRun(config) {
  if (cancelRequested) {
    await save({ status: 'cancelled', phase: 'done', message: 'Stopped — partial results kept.', finishedAt: Date.now() });
    return;
  }

  // Cross-run dedupe happens before enrichment so we never spend fetches on
  // businesses the user already exported.
  if (config.skipSeen) {
    const stored = await chrome.storage.local.get(SEEN_KEY);
    const before = job.records.length;
    const fresh = filterUnseen(job.records, stored[SEEN_KEY]);
    await save({
      records: fresh,
      skippedSeen: before - fresh.length,
      message: `${before - fresh.length} already-seen businesses skipped.`,
    });
  }

  if (config.fetchEmails !== false) await enrichEmails(job.records, config);
  if (config.verifyEmails !== false && !cancelRequested) await verifyEmails(job.records, config);

  await save({ records: dedupeRecords(job.records) });

  if (config.rememberSeen !== false) {
    const stored = await chrome.storage.local.get(SEEN_KEY);
    await chrome.storage.local.set({ [SEEN_KEY]: addToSeen(stored[SEEN_KEY], job.records) });
  }

  const failed = job.tasks.filter((t) => t.status === 'failed').length;
  await save({
    status: cancelRequested ? 'cancelled' : 'done',
    phase: 'done',
    found: job.records.length,
    message: `Finished — ${job.records.length} businesses${failed ? `, ${failed} searches failed` : ''}.`,
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

async function startJob(config) {
  if (job.status === 'running') throw new Error('A scrape is already running.');

  const tasks = buildTaskList(config);
  if (!tasks.length) throw new Error('Enter a category and city, or a batch list.');

  cancelRequested = false;
  await save({
    ...DEFAULT_JOB,
    status: 'running',
    phase: 'listing',
    config,
    tasks,
    records: [],
    message: 'Opening Google Maps…',
    startedAt: Date.now(),
  });

  const tab = await chrome.tabs.create({ url: 'about:blank', active: !config.background });
  await save({ tabId: tab.id });
  await execute(config, tab.id);
}

/** Continue a run that was interrupted or stopped, without losing its results. */
async function resumeJob() {
  await ready;
  if (job.status === 'running') throw new Error('The run is already going.');
  if (!job.tasks.some((t) => t.status === 'pending')) throw new Error('Nothing left to resume.');

  const config = job.config || {};
  cancelRequested = false;
  await save({ status: 'running', phase: 'listing', error: '', message: 'Resuming…' });

  // The old tab is long gone after a browser restart, so always take a fresh one.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: !config.background });
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

async function clearSeen() {
  await chrome.storage.local.remove(SEEN_KEY);
}

async function seenCount() {
  const stored = await chrome.storage.local.get(SEEN_KEY);
  return Array.isArray(stored[SEEN_KEY]) ? stored[SEEN_KEY].length : 0;
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
      return reply(ready.then(async () => ({ job: publicJob(), seen: await seenCount() })));

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
      return reply(ready.then(() => ({ records: job.records, config: job.config })));

    case 'CLEAR_JOB':
      return reply(save({ ...DEFAULT_JOB }).then(() => ({ job: publicJob() })));

    case 'CLEAR_SEEN':
      return reply(clearSeen().then(() => ({ seen: 0 })));

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

chrome.runtime.onInstalled.addListener(() => {
  ready.catch(() => {});
});
