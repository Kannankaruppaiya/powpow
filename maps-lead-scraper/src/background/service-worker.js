/**
 * Maps Lead Scraper — background service worker.
 *
 * Owns the job: it opens the Maps search tab, drives the content script,
 * enriches the results with emails, and keeps everything in chrome.storage so
 * the popup can be closed and reopened mid-run without losing the job.
 */

import { findEmailForSite, mapWithConcurrency } from '../lib/email.js';

const STORE_KEY = 'mls.job';

const DEFAULT_JOB = {
  status: 'idle', // idle | running | done | error | cancelled
  phase: 'idle', // listing | details | emails | done
  message: '',
  error: '',
  config: null,
  found: 0,
  detailed: 0,
  total: 0,
  emailed: 0,
  emailsFound: 0,
  records: [],
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
 * resets that clock for as long as a job is actually running.
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
  // A worker restart means any "running" job is orphaned; don't lie about it.
  if (job.status === 'running') {
    job.status = job.records.length ? 'done' : 'idle';
    job.phase = 'idle';
    job.message = job.records.length ? 'Recovered results from the previous run.' : '';
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

/** The popup only renders a preview, so don't ship it thousands of records. */
function publicJob() {
  const { records, ...rest } = job;
  return {
    ...rest,
    count: records.length,
    phonesFound: records.filter((r) => r.phone).length,
    preview: records.slice(0, 60),
  };
}

/* ------------------------------------------------------------- tab plumbing */

function buildSearchUrl({ city, category }) {
  const term = `${category} in ${city}`.trim();
  // hl=en keeps the aria-label prefixes the content script parses in English.
  return `https://www.google.com/maps/search/${encodeURIComponent(term)}?hl=en`;
}

function waitForTabComplete(tabId, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for Google Maps to load.'));
    }, timeout);

    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }

    function listener(id, info) {
      if (id === tabId && info.status === 'complete') finish();
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') finish();
      },
      (err) => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(err);
      }
    );
  });
}

/** Content scripts are not present on tabs that loaded before an install. */
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
  // Give the freshly injected listener a moment to register.
  await new Promise((r) => setTimeout(r, 300));
}

/* --------------------------------------------------------- email enrichment */

async function enrichEmails(records, config) {
  const targets = records.filter((r) => r.website);
  await save({ phase: 'emails', emailed: 0, total: targets.length, message: 'Looking up emails…' });

  let done = 0;
  let hits = 0;

  await mapWithConcurrency(targets, config.emailConcurrency || 4, async (record) => {
    if (cancelRequested) return;
    try {
      const { email, allEmails, source } = await findEmailForSite(record.website, {
        timeout: config.emailTimeout || 12000,
        followContactPage: config.followContactPage !== false,
      });
      if (email) {
        record.email = email;
        record.allEmails = allEmails.slice(1, 5);
        record.emailSource = source;
        hits += 1;
      }
    } catch (err) {
      console.warn('[maps-lead-scraper] email lookup failed', record.website, err);
    }
    done += 1;
    if (done % 3 === 0 || done === targets.length) {
      await save({ emailed: done, emailsFound: hits });
    }
  });

  await save({ emailed: done, emailsFound: hits });
}

/* ------------------------------------------------------------------ the job */

async function startJob(config) {
  if (job.status === 'running') throw new Error('A scrape is already running.');

  cancelRequested = false;
  startKeepAlive();
  await save({
    ...DEFAULT_JOB,
    status: 'running',
    phase: 'listing',
    config,
    records: [],
    message: 'Opening Google Maps…',
    startedAt: Date.now(),
  });

  let tabId = null;
  try {
    const url = buildSearchUrl(config);
    const tab = config.reuseTab
      ? await chrome.tabs.update(config.reuseTab, { url, active: true })
      : await chrome.tabs.create({ url, active: !config.background });
    tabId = tab.id;
    await save({ tabId });

    await waitForTabComplete(tabId);
    // Maps hydrates its feed after `complete`; a short settle avoids a race.
    await new Promise((r) => setTimeout(r, 2500));
    if (cancelRequested) throw new Error('cancelled');

    await ensureContentScript(tabId);
    await save({ message: 'Scrolling the results list…' });

    const response = await chrome.tabs.sendMessage(tabId, { type: 'RUN_SCRAPE', config });
    if (!response) throw new Error('The Maps tab stopped responding. Keep it open while scraping.');
    if (!response.ok) throw new Error(response.error || 'Scrape failed.');

    const records = response.records || [];
    await save({ records, total: records.length, found: records.length, message: 'Listings collected.' });

    if (cancelRequested) {
      await save({ status: 'cancelled', phase: 'done', message: 'Stopped — partial results kept.', finishedAt: Date.now() });
      return publicJob();
    }

    if (config.fetchEmails !== false) {
      await enrichEmails(records, config);
      await save({ records });
    }

    await save({
      status: 'done',
      phase: 'done',
      message: `Finished — ${records.length} listings.`,
      finishedAt: Date.now(),
    });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (message === 'cancelled' || cancelRequested) {
      await save({ status: 'cancelled', phase: 'done', message: 'Stopped.', finishedAt: Date.now() });
    } else {
      await save({ status: 'error', phase: 'done', error: message, message, finishedAt: Date.now() });
    }
  } finally {
    stopKeepAlive();
  }

  return publicJob();
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
      return reply(ready.then(() => ({ job: publicJob() })));

    case 'START_JOB':
      // Fire and forget: the run outlives this message, progress arrives via
      // JOB_UPDATE broadcasts.
      ready.then(() => startJob(msg.config)).catch((err) => console.error(err));
      sendResponse({ ok: true });
      return undefined;

    case 'CANCEL_JOB':
      return reply(cancelJob().then(() => ({})));

    case 'GET_RECORDS':
      return reply(ready.then(() => ({ records: job.records, config: job.config })));

    case 'CLEAR_JOB':
      return reply(save({ ...DEFAULT_JOB }).then(() => ({ job: publicJob() })));

    case 'SCRAPE_PROGRESS': {
      // Relayed from the content script while it works.
      const patch = { phase: msg.phase, found: msg.found, total: msg.total, detailed: msg.detailed };
      if (msg.phase === 'listing') patch.message = `Found ${msg.found} listings…`;
      if (msg.phase === 'details') patch.message = `Opening listing ${msg.detailed} of ${msg.total}…`;
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
