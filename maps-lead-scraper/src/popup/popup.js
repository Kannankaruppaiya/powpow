/**
 * Popup — collects the search, renders live progress, and builds the download.
 *
 * The job itself lives in the service worker, so closing the popup never
 * interrupts a scrape; reopening re-reads the job state.
 */

import { buildFile } from '../lib/export.js';

const SETTINGS_KEY = 'mls.settings';

const el = (id) => document.getElementById(id);
const ui = {
  form: el('form'),
  category: el('category'),
  city: el('city'),
  maxResults: el('maxResults'),
  deep: el('deep'),
  fetchEmails: el('fetchEmails'),
  followContactPage: el('followContactPage'),
  start: el('start'),
  stop: el('stop'),
  status: el('status'),
  barFill: el('barFill'),
  message: el('message'),
  statFound: el('statFound'),
  statPhones: el('statPhones'),
  statEmails: el('statEmails'),
  results: el('results'),
  format: el('format'),
  download: el('download'),
  clear: el('clear'),
  previewBody: el('previewBody'),
  previewNote: el('previewNote'),
  error: el('error'),
};

let current = null;

/* ------------------------------------------------------------- persistence */

async function restoreSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const s = stored[SETTINGS_KEY];
  if (!s) return;
  ui.category.value = s.category ?? '';
  ui.city.value = s.city ?? '';
  ui.maxResults.value = s.maxResults ?? 0;
  ui.deep.checked = s.deep !== false;
  ui.fetchEmails.checked = s.fetchEmails !== false;
  ui.followContactPage.checked = s.followContactPage !== false;
  ui.format.value = s.format || 'csv';
}

function readConfig() {
  return {
    category: ui.category.value.trim(),
    city: ui.city.value.trim(),
    maxResults: Math.max(0, Number(ui.maxResults.value) || 0),
    deep: ui.deep.checked,
    fetchEmails: ui.fetchEmails.checked,
    followContactPage: ui.followContactPage.checked,
    format: ui.format.value,
    // Pacing knobs — deliberately unhurried so Maps keeps serving results.
    scrollDelay: 900,
    detailDelay: 250,
    detailTimeout: 7000,
    emailConcurrency: 4,
    emailTimeout: 12000,
  };
}

const saveSettings = () => chrome.storage.local.set({ [SETTINGS_KEY]: readConfig() });

/* ---------------------------------------------------------------- rendering */

function showError(text) {
  ui.error.hidden = !text;
  ui.error.textContent = text || '';
}

function progressFor(job) {
  if (job.phase === 'details' && job.total) return job.detailed / job.total;
  if (job.phase === 'emails' && job.total) return job.emailed / job.total;
  return null; // listing has no known total — show the indeterminate bar
}

function render(job) {
  current = job;
  const running = job.status === 'running';

  ui.start.disabled = running;
  ui.start.textContent = running ? 'Scraping…' : 'Start scraping';
  ui.stop.hidden = !running;
  [ui.category, ui.city, ui.maxResults, ui.deep, ui.fetchEmails, ui.followContactPage].forEach(
    (input) => {
      input.disabled = running;
    }
  );

  ui.status.hidden = job.status === 'idle';
  ui.message.textContent = job.message || '';

  const ratio = progressFor(job);
  if (running && ratio === null) {
    ui.barFill.classList.add('indeterminate');
    ui.barFill.style.width = '';
  } else {
    ui.barFill.classList.remove('indeterminate');
    ui.barFill.style.width = `${Math.round((job.status === 'done' ? 1 : ratio || 0) * 100)}%`;
  }

  const preview = job.preview || [];
  ui.statFound.textContent = job.count || job.found || 0;
  // Counted by the worker over every record, not just the rows previewed here.
  ui.statPhones.textContent = job.phonesFound || 0;
  ui.statEmails.textContent = job.emailsFound || 0;

  showError(job.status === 'error' ? job.error : '');

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
        return tr;
      })
    );
    ui.previewNote.textContent =
      job.count > preview.length
        ? `Showing ${preview.length} of ${job.count} — the download has all ${job.count}.`
        : `${job.count} listing${job.count === 1 ? '' : 's'} ready to download.`;
  }
}

/* ------------------------------------------------------------------ actions */

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  const config = readConfig();
  if (!config.category || !config.city) {
    showError('Enter both a category and a city.');
    return;
  }

  await saveSettings();
  const res = await chrome.runtime.sendMessage({ type: 'START_JOB', config });
  if (res && res.ok === false) showError(res.error);
});

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
    const { content, mime, filename } = buildFile(records, ui.format.value, meta);

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
  // The worker can sleep between broadcasts; a slow poll keeps the popup honest.
  setInterval(async () => {
    if (!current || current.status !== 'running') return;
    const latest = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    if (latest && latest.job) render(latest.job);
  }, 2000);
})();
