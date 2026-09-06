/**
 * Side panel — the extension's UI.
 *
 * This replaces the popup. A popup is destroyed the moment it loses focus,
 * which is exactly what happens when you click into the Maps tab a run is
 * driving; the side panel stays open beside it for the whole run.
 *
 * The run still lives in the service worker. The panel only renders it — and,
 * because both are extension pages on the same origin, it reads the results
 * straight out of IndexedDB rather than pulling tens of thousands of rows
 * through a message.
 */

import { buildFile } from '../lib/export.js';
import { summariseRates } from '../lib/health.js';
import * as store from '../lib/store.js';

const SETTINGS_KEY = 'mls.settings';
const ROW_HEIGHT = 30; // must match .rows td height in panel.css
const OVERSCAN = 8; // rows rendered above and below the viewport

const el = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  [
    'form', 'statusPill', 'viewSetup', 'viewResults', 'paneSetup', 'paneResults',
    'tabSingle', 'tabBatch', 'modeSingle', 'modeBatch',
    'source', 'sourceNote', 'coverageRow', 'categoryLabel', 'cityLabel',
    'optEmails', 'optContact', 'optVerify', 'optDeep',
    'optCurrentTab', 'useCurrentTab', 'currentTabHint',
    'category', 'city', 'batch', 'grid', 'maxResults',
    'deep', 'fetchEmails', 'followContactPage', 'verifyEmails', 'skipSeen', 'seenNote',
    'start', 'resume', 'stop',
    'status', 'barFill', 'message', 'taskLine',
    'statFound', 'statPhones', 'statEmails', 'statSendable',
    'healthBox', 'healthList', 'error',
    'format', 'download', 'clear', 'filter',
    'scroller', 'viewport', 'spacer', 'rowBody', 'rowNote',
  ].map((id) => [id, el(id)])
);

let current = null;
let batchMode = false;
/** Every record for the current job, loaded from IndexedDB for the table. */
let rows = [];
let visibleRows = [];

/* ----------------------------------------------------------------- source */

/**
 * The two sources ask for genuinely different things, so the form follows the
 * choice: a people search has no geography to grid over and no business
 * website to read an email from, and showing those controls anyway would just
 * be a lie about what the run will do.
 */
const SOURCE_UI = {
  maps: {
    categoryLabel: 'Category',
    cityLabel: 'City',
    categoryPlaceholder: 'e.g. dentists',
    cityPlaceholder: 'e.g. Chennai',
    grid: true,
    emails: true,
    // The grid needs to drive the tab itself, so this is off for Maps.
    currentTab: false,
    note: '',
  },
  linkedin: {
    categoryLabel: 'Keywords',
    cityLabel: 'Location',
    categoryPlaceholder: 'e.g. java developer',
    cityPlaceholder: 'e.g. London',
    grid: false,
    emails: false,
    // Navigating to our own URL would throw away any filter the user applied,
    // so reading the tab they already set up is the better default here.
    currentTab: true,
    note:
      'Uses your signed-in LinkedIn session and reads the same results you see. ' +
      'LinkedIn restricts accounts for automated collection — keep runs small and infrequent.',
  },
};

function applySource() {
  const conf = SOURCE_UI[ui.source.value] || SOURCE_UI.maps;
  ui.optCurrentTab.hidden = !conf.currentTab;
  if (!conf.currentTab) ui.useCurrentTab.checked = false;
  applyCurrentTab();
  ui.categoryLabel.textContent = conf.categoryLabel;
  ui.cityLabel.textContent = conf.cityLabel;
  ui.category.placeholder = conf.categoryPlaceholder;
  ui.city.placeholder = conf.cityPlaceholder;
  ui.coverageRow.hidden = !conf.grid;
  // The detail pass only exists for Maps; a LinkedIn card already carries
  // everything, so offering the option would be a lie about what it does.
  ui.optDeep.hidden = !conf.grid;
  for (const node of [ui.optEmails, ui.optContact, ui.optVerify]) node.hidden = !conf.emails;
  ui.sourceNote.hidden = !conf.note;
  ui.sourceNote.textContent = conf.note;
}

/**
 * In current-tab mode the search comes from the page, so the keyword and
 * location inputs would be ignored — hide them rather than let someone type
 * into a box that does nothing.
 */
function applyCurrentTab() {
  const on = ui.useCurrentTab.checked && !ui.optCurrentTab.hidden;
  ui.modeSingle.hidden = on || batchMode;
  ui.tabSingle.parentElement.hidden = on;
  ui.currentTabHint.hidden = !on;
}

ui.source.addEventListener('change', () => {
  applySource();
  saveSettings();
});

ui.useCurrentTab.addEventListener('change', () => {
  applyCurrentTab();
  saveSettings();
});

/* ------------------------------------------------------------------- tabs */

function setView(showResults) {
  ui.paneSetup.hidden = showResults;
  ui.paneResults.hidden = !showResults;
  ui.viewSetup.classList.toggle('is-active', !showResults);
  ui.viewResults.classList.toggle('is-active', showResults);
  if (showResults) refreshRows();
}

ui.viewSetup.addEventListener('click', () => setView(false));
ui.viewResults.addEventListener('click', () => setView(true));

function setMode(useBatch) {
  batchMode = useBatch;
  ui.modeSingle.hidden = useBatch;
  ui.modeBatch.hidden = !useBatch;
  ui.tabSingle.classList.toggle('is-active', !useBatch);
  ui.tabBatch.classList.toggle('is-active', useBatch);
  ui.tabSingle.setAttribute('aria-selected', String(!useBatch));
  ui.tabBatch.setAttribute('aria-selected', String(useBatch));
}

ui.tabSingle.addEventListener('click', () => { setMode(false); saveSettings(); });
ui.tabBatch.addEventListener('click', () => { setMode(true); saveSettings(); });

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
  ui.useCurrentTab.checked = Boolean(s.useCurrentTab);
  // An older build stored "xls"; the exporter only writes real xlsx now.
  ui.format.value = s.format === 'xls' ? 'xlsx' : s.format || 'csv';
  ui.source.value = s.source || 'maps';
  setMode(Boolean(s.batchMode));
  applySource();
}

function readConfig() {
  return {
    source: ui.source.value,
    useCurrentTab: ui.useCurrentTab.checked && !ui.optCurrentTab.hidden,
    category: ui.category.value.trim(),
    city: ui.city.value.trim(),
    // Only send the batch text when the batch tab is active, so a leftover
    // draft cannot hijack a single search.
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

/* ---------------------------------------------------------- virtual table */

/** Load this job's records from IndexedDB and redraw the table. */
async function refreshRows() {
  const jobId = current && current.jobId;
  rows = jobId ? await store.getRecords(jobId) : [];
  relabelColumns();
  applyFilter();
}

/** A LinkedIn run fills different columns; say so in the header. */
function relabelColumns() {
  const isLinkedIn = rows.some((r) => r.source === 'linkedin');
  const labels = isLinkedIn
    ? ['Name', 'Company', 'Headline', 'Location', 'Connection', '']
    : ['Name', 'Phone', 'Email', 'Area', 'Category', '★'];
  document.querySelectorAll('.scroller thead th').forEach((th, i) => {
    th.textContent = labels[i];
  });
}

function applyFilter() {
  const needle = ui.filter.value.trim().toLowerCase();
  visibleRows = !needle
    ? rows
    : rows.filter((r) =>
        [r.name, r.area, r.category, r.city, r.email, r.phone]
          .some((v) => String(v || '').toLowerCase().includes(needle))
      );

  ui.spacer.style.height = `${visibleRows.length * ROW_HEIGHT}px`;
  ui.rowNote.textContent = visibleRows.length
    ? `${visibleRows.length.toLocaleString()}${needle ? ` of ${rows.length.toLocaleString()}` : ''} rows`
    : rows.length
      ? 'No rows match that filter.'
      : 'Nothing collected yet.';
  drawWindow();
}

/**
 * Render only the rows on screen.
 *
 * A 20,000-row table with every row in the DOM makes the panel unusable; this
 * keeps roughly thirty rows alive and shifts them as the user scrolls.
 */
function drawWindow() {
  const scrollTop = ui.viewport.scrollTop;
  const height = ui.viewport.clientHeight || 400;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = visibleRows.slice(first, first + count);

  const body = document.createDocumentFragment();
  for (const record of slice) {
    const tr = document.createElement('tr');
    const cells =
      record.source === 'linkedin'
        ? [
            ['c-name', record.name],
            ['c-phone', record.company],
            ['c-email', record.headline],
            ['c-area', record.location],
            ['c-cat', record.degree],
            ['c-rating', record.openToWork],
          ]
        : [
            ['c-name', record.name],
            ['c-phone', record.phone],
            ['c-email', record.email],
            ['c-area', record.area],
            ['c-cat', record.category],
            ['c-rating', record.rating],
          ];
    for (const [cls, value] of cells) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = value || '—';
      td.title = value || '';
      tr.appendChild(td);
    }
    // Flag addresses verification says will bounce.
    if (record.email && record.emailStatus && !['valid', 'role', 'unknown'].includes(record.emailStatus)) {
      const cell = tr.querySelector('.c-email');
      cell.classList.add('bad');
      cell.title = `${record.email} — ${record.emailStatusReason || record.emailStatus}`;
    }
    body.appendChild(tr);
  }

  ui.rowBody.replaceChildren(body);
  // Offset the rendered block so it sits where those rows belong.
  ui.rowBody.parentElement.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
}

ui.viewport.addEventListener('scroll', () => requestAnimationFrame(drawWindow), { passive: true });
ui.filter.addEventListener('input', applyFilter);

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

const PILL = {
  idle: 'Idle', running: 'Running', paused: 'Paused',
  done: 'Done', error: 'Error', cancelled: 'Stopped',
};

function render(job) {
  const previousCount = current ? current.count : -1;
  const previousJobId = current ? current.jobId : null;
  current = job;

  const running = job.status === 'running';
  ui.statusPill.textContent = PILL[job.status] || job.status;
  ui.statusPill.dataset.state = job.status;

  ui.start.disabled = running;
  ui.start.hidden = running || job.canResume;
  ui.resume.hidden = !job.canResume || running;
  ui.stop.hidden = !running;

  for (const input of [
    ui.source, ui.useCurrentTab, ui.category, ui.city, ui.batch, ui.grid, ui.maxResults,
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

  ui.statFound.textContent = job.count || job.found || 0;
  ui.statPhones.textContent = job.phonesFound || 0;
  ui.statEmails.textContent = job.emailsFound || 0;
  ui.statSendable.textContent = job.sendable || 0;

  renderHealth(job.health);
  // A run can finish with nothing to show; the reason is the useful part.
  showError(
    job.status === 'error' || job.status === 'paused' ? job.error : job.taskError || ''
  );

  // Reload the table when the result count moved or a new job started.
  if (job.count !== previousCount || job.jobId !== previousJobId) {
    if (!ui.paneResults.hidden) refreshRows();
  }
}

function renderHealth(health) {
  if (!health || !health.rates) {
    ui.healthBox.hidden = true;
    return;
  }
  ui.healthBox.hidden = false;
  ui.healthBox.classList.toggle('is-bad', health.ok === false);
  ui.healthList.replaceChildren(
    ...summariseRates(health.rates).map(({ field, rate }) => {
      const li = document.createElement('li');
      const pct = Math.round(rate * 100);
      li.textContent = `${field}: ${pct}%`;
      if (pct < 50) li.classList.add('low');
      return li;
    })
  );
}

function renderSeen(count) {
  ui.seenNote.textContent = count ? `(${count.toLocaleString()} remembered)` : '';
}

/* ------------------------------------------------------------------ actions */

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');

  const config = readConfig();
  const conf = SOURCE_UI[config.source] || SOURCE_UI.maps;
  // Current-tab mode takes the search off the page, so there is nothing to
  // validate here.
  if (config.useCurrentTab) {
    await saveSettings();
    const started = await chrome.runtime.sendMessage({ type: 'START_JOB', config });
    if (started && started.ok === false) showError(started.error);
    return;
  }
  if (batchMode ? !config.batch.trim() : !config.category) {
    showError(
      batchMode
        ? 'Add at least one line to the batch list.'
        : `Enter a ${conf.categoryLabel.toLowerCase()}.`
    );
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
  rows = [];
  applyFilter();
});

ui.format.addEventListener('change', saveSettings);

ui.download.addEventListener('click', async () => {
  showError('');
  ui.download.disabled = true;
  const label = ui.download.textContent;
  ui.download.textContent = 'Building…';
  try {
    // Straight from the database: no message-size ceiling on a big export.
    const all = current && current.jobId ? await store.getRecords(current.jobId) : [];
    if (!all.length) {
      showError('Nothing to download yet.');
      return;
    }

    const meta = (current && current.config) || readConfig();
    const { content, mime, filename } = await buildFile(all, ui.format.value, meta);

    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    showError(String((err && err.message) || err));
  } finally {
    ui.download.disabled = false;
    ui.download.textContent = label;
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
  if (current.count) setView(true);

  // The worker can sleep between broadcasts; a slow poll keeps the panel honest.
  setInterval(async () => {
    if (!current || current.status !== 'running') return;
    const latest = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    if (latest && latest.job) render(latest.job);
  }, 2000);
})();
