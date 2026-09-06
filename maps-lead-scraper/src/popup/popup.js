/**
 * Popup — collects the search, renders live progress, and builds the download.
 *
 * The run itself lives in the service worker, so closing the popup never
 * interrupts a scrape; reopening simply re-reads the job state.
 */

import { buildFile } from '../lib/export.js';

const SETTINGS_KEY = 'mls.settings';

const el = (id) => document.getElementById(id);
const ui = {
  form: el('form'),
  tabSingle: el('tabSingle'),
  tabBatch: el('tabBatch'),
  paneSingle: el('paneSingle'),
  paneBatch: el('paneBatch'),
  category: el('category'),
  city: el('city'),
  batch: el('batch'),
  grid: el('grid'),
  maxResults: el('maxResults'),
  deep: el('deep'),
  fetchEmails: el('fetchEmails'),
  followContactPage: el('followContactPage'),
  verifyEmails: el('verifyEmails'),
  skipSeen: el('skipSeen'),
  seenNote: el('seenNote'),
  start: el('start'),
  resume: el('resume'),
  stop: el('stop'),
  status: el('status'),
  barFill: el('barFill'),
  message: el('message'),
  taskLine: el('taskLine'),
  statFound: el('statFound'),
  statPhones: el('statPhones'),
  statEmails: el('statEmails'),
  statSendable: el('statSendable'),
  results: el('results'),
  format: el('format'),
  download: el('download'),
  clear: el('clear'),
  previewBody: el('previewBody'),
  previewNote: el('previewNote'),
  error: el('error'),
};

let current = null;
let batchMode = false;

/* ------------------------------------------------------------------- tabs */

function setMode(useBatch) {
  batchMode = useBatch;
  ui.paneSingle.hidden = useBatch;
  ui.paneBatch.hidden = !useBatch;
  ui.tabSingle.classList.toggle('is-active', !useBatch);
  ui.tabBatch.classList.toggle('is-active', useBatch);
  ui.tabSingle.setAttribute('aria-selected', String(!useBatch));
  ui.tabBatch.setAttribute('aria-selected', String(useBatch));
}

ui.tabSingle.addEventListener('click', () => {
  setMode(false);
  saveSettings();
});
ui.tabBatch.addEventListener('click', () => {
  setMode(true);
  saveSettings();
});

/* ------------------------------------------------------------- persistence */

async function restoreSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const s = stored[SETTINGS_KEY];
  if (!s) return;
  ui.category.value = s.category ?? '';
  ui.city.value = s.city ?? '';
  ui.batch.value = s.batch ?? '';
  ui.grid.value = s.grid || 'balanced';
  ui.maxResults.value = s.maxResults ?? 0;
  ui.deep.checked = s.deep !== false;
  ui.fetchEmails.checked = s.fetchEmails !== false;
  ui.followContactPage.checked = s.followContactPage !== false;
  ui.verifyEmails.checked = s.verifyEmails !== false;
  ui.skipSeen.checked = Boolean(s.skipSeen);
  ui.format.value = s.format || 'csv';
  setMode(Boolean(s.batchMode));
}

function readConfig() {
  return {
    category: ui.category.value.trim(),
    city: ui.city.value.trim(),
    // Only send the batch text when the batch tab is the active one, so a
    // leftover draft cannot hijack a single search.
    batch: batchMode ? ui.batch.value : '',
    batchMode,
    grid: ui.grid.value,
    maxResults: Math.max(0, Number(ui.maxResults.value) || 0),
    deep: ui.deep.checked,
    fetchEmails: ui.fetchEmails.checked,
    followContactPage: ui.followContactPage.checked,
    verifyEmails: ui.verifyEmails.checked,
    skipSeen: ui.skipSeen.checked,
    format: ui.format.value,
    // Pacing knobs — deliberately unhurried so Maps keeps serving results.
    scrollDelay: 900,
    detailDelay: 250,
    detailTimeout: 7000,
    emailConcurrency: 4,
    emailTimeout: 12000,
    verifyConcurrency: 6,
    verifyTimeout: 8000,
  };
}

const saveSettings = () => chrome.storage.local.set({ [SETTINGS_KEY]: readConfig() });

/* ---------------------------------------------------------------- rendering */

function showError(text) {
  ui.error.hidden = !text;
  ui.error.textContent = text || '';
}

/**
 * Progress is only meaningful where a total is known: the queue during the
 * search phase, the record count during enrichment. Everything else shows the
 * indeterminate bar rather than a made-up number.
 */
function progressFor(job) {
  if (job.phase === 'emails' && job.total) return job.emailed / job.total;
  if (job.phase === 'verify' && job.total) return job.verified / job.total;
  if (job.tasksTotal > 1) return job.tasksSettled / job.tasksTotal;
  if (job.phase === 'details' && job.total) return job.detailed / job.total;
  return null;
}

function render(job) {
  current = job;
  const running = job.status === 'running';

  ui.start.disabled = running;
  ui.start.hidden = running || job.canResume;
  ui.resume.hidden = !job.canResume || running;
  ui.stop.hidden = !running;

  for (const input of [
    ui.category, ui.city, ui.batch, ui.grid, ui.maxResults,
    ui.deep, ui.fetchEmails, ui.followContactPage, ui.verifyEmails, ui.skipSeen,
  ]) {
    input.disabled = running;
  }

  ui.status.hidden = job.status === 'idle';
  ui.message.textContent = job.message || '';

  ui.taskLine.hidden = !job.tasksTotal;
  if (job.tasksTotal) {
    const skipped = job.skippedSeen ? ` · ${job.skippedSeen} already seen` : '';
    ui.taskLine.textContent = `${job.tasksSettled} of ${job.tasksTotal} searches done${skipped}`;
  }

  const ratio = progressFor(job);
  if (running && ratio === null) {
    ui.barFill.classList.add('indeterminate');
    ui.barFill.style.width = '';
  } else {
    ui.barFill.classList.remove('indeterminate');
    ui.barFill.style.width = `${Math.round((job.status === 'done' ? 1 : ratio || 0) * 100)}%`;
  }

  // Counted by the worker over every record, not just the rows previewed here.
  ui.statFound.textContent = job.count || job.found || 0;
  ui.statPhones.textContent = job.phonesFound || 0;
  ui.statEmails.textContent = job.emailsFound || 0;
  ui.statSendable.textContent = job.sendable || 0;

  showError(job.status === 'error' ? job.error : '');

  const preview = job.preview || [];
  ui.results.hidden = !job.count;
  if (job.count) {
    ui.previewBody.replaceChildren(
      ...preview.map((r) => {
        const tr = document.createElement('tr');
        for (const value of [r.name, r.phone, r.email, r.area, r.rating]) {
          const td = document.createElement('td');
          td.textContent = value || '—';
          td.title = value || '';
          tr.appendChild(td);
        }
        // Flag addresses verification says will bounce.
        if (r.email && r.emailStatus && !['valid', 'role', 'unknown'].includes(r.emailStatus)) {
          tr.children[2].classList.add('bad');
          tr.children[2].title = `${r.email} — ${r.emailStatusReason || r.emailStatus}`;
        }
        return tr;
      })
    );
    ui.previewNote.textContent =
      job.count > preview.length
        ? `Showing ${preview.length} of ${job.count} — the download has all ${job.count}.`
        : `${job.count} business${job.count === 1 ? '' : 'es'} ready to download.`;
  }
}

function renderSeen(count) {
  ui.seenNote.textContent = count ? `(${count.toLocaleString()} remembered)` : '';
}

/* ------------------------------------------------------------------ actions */

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  const config = readConfig();
  if (batchMode ? !config.batch.trim() : !config.category || !config.city) {
    showError(batchMode ? 'Add at least one line to the batch list.' : 'Enter both a category and a city.');
    return;
  }

  await saveSettings();
  const res = await chrome.runtime.sendMessage({ type: 'START_JOB', config });
  if (res && res.ok === false) showError(res.error);
});

ui.resume.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'RESUME_JOB' }));
ui.stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CANCEL_JOB' }));

ui.clear.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'CLEAR_JOB' });
  if (res && res.job) render(res.job);
});

ui.format.addEventListener('change', saveSettings);

ui.download.addEventListener('click', async () => {
  showError('');
  ui.download.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_RECORDS' });
    const records = (res && res.records) || [];
    if (!records.length) {
      showError('Nothing to download yet.');
      return;
    }

    const meta = (res && res.config) || readConfig();
    const { content, mime, filename } = await buildFile(records, ui.format.value, meta);

    // Blob URLs need a document, which is why the download is built here in
    // the popup rather than in the service worker.
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    showError(String((err && err.message) || err));
  } finally {
    ui.download.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'JOB_UPDATE') render(msg.job);
});

(async function init() {
  await restoreSettings();
  const res = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
  render((res && res.job) || { status: 'idle', count: 0 });
  renderSeen((res && res.seen) || 0);

  // The worker can sleep between broadcasts; a slow poll keeps the popup honest.
  setInterval(async () => {
    if (!current || current.status !== 'running') return;
    const latest = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    if (latest && latest.job) render(latest.job);
  }, 2000);
})();
