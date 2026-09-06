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
import { suggestionsFor } from '../lib/categories.js';
import { planSearches, planToBatch, providerFor, DEFAULT_PROVIDER } from '../lib/ai.js';
import * as store from '../lib/store.js';

const SETTINGS_KEY = 'mls.settings';
/**
 * The planner's credentials, stored apart from the form's settings.
 *
 * Separate on purpose: `readConfig()` is what reaches the service worker, gets
 * written into the job and is available to the export path. An API key has no
 * business in any of those, so it never joins that object.
 */
const AI_KEY = 'mls.ai';
/**
 * Row height, read from the stylesheet rather than duplicated here.
 *
 * These were two separate constants and they drifted: the CSS said 32px while
 * this said 30, which silently mis-positions every row in the virtual window.
 */
const ROW_HEIGHT =
  parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10) || 32;
const OVERSCAN = 8; // rows rendered above and below the viewport

const el = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  [
    'form', 'statusPill', 'viewSetup', 'viewResults', 'paneSetup', 'paneResults', 'tabCount',
    'modeSingle', 'modeBatch', 'toggleBatch',
    'source', 'sourceGroup', 'sourceNote', 'coverageRow', 'coverage',
    'categoryLabel', 'cityLabel', 'limitLabel',
    'optEmails', 'optContact', 'optVerify', 'optDeep',
    'optCurrentTab', 'useCurrentTab', 'currentTabHint',
    'category', 'city', 'batch', 'grid', 'maxResults',
    'categoryFilter', 'categoryFilterRow', 'categoryOptions', 'filterLabel', 'filterHint',
    'deep', 'fetchEmails', 'followContactPage', 'verifyEmails', 'skipSeen', 'seenNote',
    'start', 'resume', 'stop', 'again', 'goResults',
    'runView', 'spinner', 'runTitle', 'barFill', 'message', 'taskLine',
    'statFound', 'statFoundLabel', 'statPhones', 'statEmails', 'statSendable',
    'healthBox', 'healthList', 'error',
    'format', 'download', 'clear', 'filter',
    'scroller', 'viewport', 'spacer', 'rowBody', 'rowNote', 'footnote',
    'emptyResults', 'emptyGoSearch',
    'assist', 'assistSub', 'aiBrief', 'aiPlan', 'aiStatus', 'aiKeyHint', 'aiOpenSettings',
    'aiResult', 'aiUnderstood', 'aiList', 'aiApply', 'aiDiscard',
    'aiSettings', 'aiProvider', 'aiProviderName', 'aiKey', 'aiModel', 'aiKeyLink',
  ].map((id) => [id, el(id)])
);

/**
 * The radio groups are the visible controls; the hidden <select>s behind them
 * stay authoritative so config reading, saved settings and the tests all keep
 * one source of truth.
 */
function bindRadios(name, target, after) {
  for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      target.value = radio.value;
      target.dispatchEvent(new Event('change'));
      if (after) after();
    });
  }
}

function syncRadios(name, value) {
  for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
    radio.checked = radio.value === value;
  }
}

/** Five grid presets were three too many to choose between. */
const COVERAGE_CHOICES = ['off', 'balanced', 'exhaustive'];

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
    categoryLabel: 'What are you looking for?',
    cityLabel: 'Where?',
    categoryPlaceholder: 'dentists',
    cityPlaceholder: 'Chennai',
    noun: 'businesses',
    limitLabel: 'Stop after this many per search',
    assistSub:
      "Describe your business or who you want to reach. I'll work out the searches that find them.",
    assistPlaceholder:
      'I make industrial floor-cleaning chemicals and want bulk buyers around Chennai',
    filterLabel: 'Category',
    filterHint: 'Pick one, or type your own. Separate several with commas.',
    grid: true,
    emails: true,
    // The grid needs to drive the tab itself, so this is off for Maps.
    currentTab: false,
    note: '',
  },
  linkedin: {
    categoryLabel: 'What are you looking for?',
    cityLabel: 'Where?',
    categoryPlaceholder: 'java developer',
    cityPlaceholder: 'London',
    // One LinkedIn search is the whole run, so "per search" read as a
    // per-page cap and made a limit of 100 look like it had been ignored.
    noun: 'people',
    limitLabel: 'Stop after this many profiles',
    assistSub:
      "Describe the person you need. I'll work out the titles and skills to search for.",
    assistPlaceholder:
      'I need freelance trainers who can teach ServiceNow to corporate teams in India',
    filterLabel: 'Headline contains',
    filterHint: 'A person has no category, so this matches their headline.',
    grid: false,
    emails: false,
    // Navigating to our own URL would throw away any filter the user applied,
    // so reading the tab they already set up is the better default here.
    currentTab: true,
    note:
      'This reads the results you are already signed in to see. LinkedIn restricts ' +
      'accounts for automated collection, so keep runs small and infrequent.',
  },
};

function applySource() {
  const conf = SOURCE_UI[ui.source.value] || SOURCE_UI.maps;
  syncRadios('source', ui.source.value);
  ui.statFoundLabel.textContent = conf.noun;
  ui.filterLabel.textContent = conf.filterLabel;
  ui.limitLabel.textContent = conf.limitLabel;
  ui.filterHint.textContent = conf.filterHint;
  refreshCategoryOptions();
  ui.optCurrentTab.hidden = !conf.currentTab;
  if (!conf.currentTab) ui.useCurrentTab.checked = false;
  applyCurrentTab();
  ui.assistSub.textContent = conf.assistSub;
  ui.aiBrief.placeholder = conf.assistPlaceholder;
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
  ui.modeBatch.hidden = on || !batchMode;
  ui.toggleBatch.hidden = on;
  ui.currentTabHint.hidden = !on;
  // Reading the user's own tab means the planner has nothing to fill in.
  ui.assist.hidden = on;
}

bindRadios('source', ui.source);
bindRadios('coverage', ui.grid);

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
  ui.modeBatch.hidden = !useBatch;
  ui.toggleBatch.textContent = useBatch ? 'Just one search' : 'Search several at once';
  applyCurrentTab();
}

ui.toggleBatch.addEventListener('click', () => {
  setMode(!batchMode);
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
  ui.useCurrentTab.checked = Boolean(s.useCurrentTab);
  ui.categoryFilter.value = s.categoryFilter ?? '';
  // An older build stored "xls"; the exporter only writes real xlsx now.
  ui.format.value = s.format === 'xls' ? 'xlsx' : s.format || 'xlsx';
  ui.source.value = s.source || 'maps';
  // Only the three offered levels can be restored; anything else falls back.
  ui.grid.value = COVERAGE_CHOICES.includes(s.grid) ? s.grid : 'balanced';
  syncRadios('coverage', ui.grid.value);
  setMode(Boolean(s.batchMode));
  applySource();
}

function readConfig() {
  return {
    source: ui.source.value,
    categoryFilter: ui.categoryFilter.value.trim(),
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

/* ------------------------------------------------------- the search planner */

/*
 * A lot of people know their business perfectly well and still cannot guess
 * which Maps searches find its customers. "I make floor-cleaning chemicals" is
 * not a search; "facility management companies" is. This turns the first into
 * the second, and shows its reasoning so the user stays the one deciding.
 */

let ai = { provider: DEFAULT_PROVIDER, key: '', model: '' };
let plan = null;

async function restoreAi() {
  const stored = await chrome.storage.local.get(AI_KEY);
  ai = { provider: DEFAULT_PROVIDER, key: '', model: '', ...(stored[AI_KEY] || {}) };
  ui.aiProvider.value = ai.provider;
  syncRadios('aiProvider', ai.provider);
  ui.aiKey.value = ai.key;
  ui.aiModel.value = ai.model;
  applyProvider();
}

const saveAi = () =>
  chrome.storage.local.set({
    [AI_KEY]: {
      provider: ui.aiProvider.value,
      key: ui.aiKey.value.trim(),
      model: ui.aiModel.value.trim(),
    },
  });

/** Everything that changes when you switch between Gemini and Groq. */
function applyProvider() {
  const conf = providerFor(ui.aiProvider.value);
  ui.aiProviderName.textContent = conf.label;
  ui.aiKeyLink.href = conf.keyUrl;
  // The model box shows the default as a placeholder rather than a value, so
  // leaving it blank keeps following the default when it changes.
  ui.aiModel.placeholder = conf.defaultModel;
  ui.aiKey.placeholder = `API key — ${conf.keyHint}`;
  ui.aiKeyHint.hidden = Boolean(ui.aiKey.value.trim());
  ui.aiPlan.disabled = !ui.aiKey.value.trim();
}

function setAiStatus(text, kind = '') {
  ui.aiStatus.textContent = text;
  ui.aiStatus.className = `small ${kind === 'error' ? 'assist-error' : 'muted'}`;
}

const TIER_LABEL = { 1: 'best fit', 2: 'resellers', 3: 'bulk users', 4: 'wider net' };

/** Render the proposal. Every line is a checkbox: the user still decides. */
function renderPlan(next) {
  plan = next;
  ui.aiList.replaceChildren();

  for (const [i, search] of next.searches.entries()) {
    const row = document.createElement('label');
    row.className = 'assist-item';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.dataset.index = String(i);

    const body = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = search.city ? `${search.query} — ${search.city}` : search.query;
    const why = document.createElement('em');
    why.textContent = search.reason;
    body.append(title, why);

    const tier = document.createElement('span');
    tier.className = 'assist-tier';
    tier.textContent = TIER_LABEL[search.tier] || '';

    row.append(box, body, tier);
    ui.aiList.append(row);
  }

  ui.aiUnderstood.textContent = next.understood;
  ui.aiUnderstood.hidden = !next.understood;
  ui.aiResult.hidden = false;
}

function clearPlan() {
  plan = null;
  ui.aiResult.hidden = true;
  ui.aiList.replaceChildren();
}

ui.aiPlan.addEventListener('click', async () => {
  clearPlan();
  ui.aiPlan.disabled = true;
  setAiStatus('Thinking…');
  try {
    const next = await planSearches({
      brief: ui.aiBrief.value,
      source: ui.source.value,
      city: ui.city.value.trim(),
      // The plan's size follows the same dial as the run's: someone after a
      // quick look does not want sixteen searches queued.
      depth: { off: 'quick', balanced: 'balanced', exhaustive: 'deep' }[ui.grid.value] || 'balanced',
      provider: ui.aiProvider.value,
      apiKey: ui.aiKey.value.trim(),
      model: ui.aiModel.value.trim(),
    });

    if (next.status === 'needs_clarification') {
      // One question, asked in the box they are already typing in.
      setAiStatus(next.question);
      ui.aiBrief.focus();
      return;
    }

    renderPlan(next);
    setAiStatus(`${next.searches.length} searches — untick any you don't want.`);
  } catch (err) {
    setAiStatus(err.message, 'error');
  } finally {
    ui.aiPlan.disabled = !ui.aiKey.value.trim();
  }
});

ui.aiApply.addEventListener('click', () => {
  if (!plan) return;
  const chosen = [...ui.aiList.querySelectorAll('input:checked')].map(
    (box) => plan.searches[Number(box.dataset.index)]
  );
  if (!chosen.length) {
    setAiStatus('Tick at least one search first.', 'error');
    return;
  }

  // The batch box is the queue's own input format, so the plan lands somewhere
  // the user can still edit by hand before pressing Start.
  ui.batch.value = planToBatch(chosen);
  setMode(true);
  clearPlan();
  setAiStatus(`${chosen.length} searches ready — press Start.`);
  saveSettings();
  ui.batch.scrollIntoView({ block: 'nearest' });
});

ui.aiDiscard.addEventListener('click', () => {
  clearPlan();
  setAiStatus('');
});

ui.aiOpenSettings.addEventListener('click', () => {
  const details = ui.aiSettings.closest('details');
  if (details) details.open = true;
  ui.aiKey.focus();
});

bindRadios('aiProvider', ui.aiProvider);
ui.aiProvider.addEventListener('change', () => {
  applyProvider();
  saveAi();
});
for (const field of [ui.aiKey, ui.aiModel]) {
  field.addEventListener('change', () => {
    applyProvider();
    saveAi();
  });
}
// The Plan button unlocks as soon as a key is typed, without waiting for blur.
ui.aiKey.addEventListener('input', applyProvider);

/* ---------------------------------------------------------- virtual table */

/** Load this job's records from IndexedDB and redraw the table. */
async function refreshRows() {
  const jobId = current && current.jobId;
  rows = jobId ? await store.getRecords(jobId) : [];
  relabelColumns();
  refreshCategoryOptions();
  applyFilter();
}

/**
 * Offer the categories this run actually produced, ahead of the standing list.
 *
 * A curated list can only guess; "wholesale store" comes back labelled
 * Wholesale market, Furniture wholesaler and Produce market, and those are the
 * three the user wants to choose between.
 */
function refreshCategoryOptions() {
  const field = (SOURCE_UI[ui.source.value] || SOURCE_UI.maps) === SOURCE_UI.linkedin
    ? 'headline'
    : 'category';
  ui.categoryOptions.replaceChildren(
    ...suggestionsFor(rows, field).slice(0, 60).map((value) => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    })
  );
}

/** A LinkedIn run fills different columns; say so in the header. */
function relabelColumns() {
  const isLinkedIn = rows.some((r) => r.source === 'linkedin');
  const labels = isLinkedIn
    ? ['Name', 'Company', 'Headline', 'Location', 'Degree', '']
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

  // An empty results view gets a designed state, not a bare sentence.
  const bare = !rows.length;
  ui.emptyResults.hidden = !bare;
  ui.scroller.hidden = bare;
  ui.rowNote.hidden = bare;

  ui.spacer.style.height = `${visibleRows.length * ROW_HEIGHT}px`;
  ui.rowNote.textContent = visibleRows.length
    ? `${visibleRows.length.toLocaleString()}${needle ? ` of ${rows.length.toLocaleString()}` : ''} rows`
    : rows.length
      ? 'Nothing matches that filter.'
      : 'Nothing collected yet — run a search first.';
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
  done: 'Done', error: 'Failed', cancelled: 'Stopped',
};

/** What the run is doing, in words rather than phase names. */
const PHASE_TITLE = {
  listing: 'Collecting listings…',
  details: 'Opening each listing…',
  emails: 'Looking for emails…',
  verify: 'Checking emails…',
};

function render(job) {
  const previousCount = current ? current.count : -1;
  const previousJobId = current ? current.jobId : null;
  current = job;

  const running = job.status === 'running';
  const settled = ['done', 'error', 'cancelled', 'paused'].includes(job.status);

  ui.statusPill.hidden = job.status === 'idle';
  ui.statusPill.textContent = PILL[job.status] || job.status;
  ui.statusPill.dataset.state = job.status;

  // The form and the run never share the screen: while a scrape is going,
  // the settings that started it are not what the user needs to look at.
  const showRun = running || (settled && job.status !== 'idle' && job.tasksTotal > 0);
  ui.form.hidden = showRun;
  ui.runView.hidden = !showRun;

  ui.start.hidden = job.canResume;
  ui.resume.hidden = !job.canResume;
  ui.stop.hidden = !running;
  ui.again.hidden = running;
  ui.goResults.hidden = running || !job.count;
  ui.spinner.hidden = !running;

  // One primary action per view. A paused run wants resuming; a finished one
  // wants reading. Two indigo buttons side by side answer neither question.
  const primary = job.canResume ? ui.resume : ui.goResults;
  for (const btn of [ui.resume, ui.goResults]) {
    btn.classList.toggle('btn--primary', btn === primary);
  }
  ui.footnote.hidden = !running;

  ui.runTitle.textContent = running
    ? PHASE_TITLE[job.phase] || 'Working…'
    : { done: 'Finished', cancelled: 'Stopped', paused: 'Paused', error: "Couldn't finish" }[job.status] ||
      'Finished';
  ui.message.textContent = job.message || '';

  ui.taskLine.hidden = !job.tasksTotal;
  if (job.tasksTotal) {
    const notes = [
      job.filteredOut ? `${job.filteredOut} set aside by ${(SOURCE_UI[job.config && job.config.source] || SOURCE_UI.maps).filterLabel.toLowerCase()}` : '',
      job.skippedSeen ? `${job.skippedSeen} already downloaded` : '',
    ].filter(Boolean);
    ui.taskLine.textContent =
      `Search ${Math.min(job.tasksSettled + (running ? 1 : 0), job.tasksTotal)} of ${job.tasksTotal}` +
      (notes.length ? ` · ${notes.join(' · ')}` : '') +
      (!running && job.stoppedBecause ? ` · stopped because ${job.stoppedBecause}` : '');
  }

  // Progress belongs to a run in progress. Once it has settled, the title and
  // the status chip say everything, and a full-width bar is just weight.
  ui.barFill.parentElement.hidden = !running;

  const ratio = progressFor(job);
  if (running && ratio === null) {
    ui.barFill.classList.add('indeterminate');
    ui.barFill.style.width = '';
  } else {
    ui.barFill.classList.remove('indeterminate');
    ui.barFill.style.width = `${Math.round((job.status === 'done' ? 1 : ratio || 0) * 100)}%`;
  }

  // Counted by the worker over every record, not just the rows previewed here.
  ui.statFound.textContent = (job.count || job.found || 0).toLocaleString();
  ui.statPhones.textContent = (job.phonesFound || 0).toLocaleString();
  ui.statEmails.textContent = (job.emailsFound || 0).toLocaleString();
  ui.statSendable.textContent = (job.sendable || 0).toLocaleString();

  ui.tabCount.hidden = !job.count;
  ui.tabCount.textContent = (job.count || 0).toLocaleString();

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
  ui.seenNote.textContent = count ? `${count.toLocaleString()} remembered so far` : '';
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
    void conf;
    showError(
      batchMode ? 'Add at least one line first.' : 'Type what you are looking for first.'
    );
    return;
  }

  await saveSettings();
  const res = await chrome.runtime.sendMessage({ type: 'START_JOB', config });
  if (res && res.ok === false) showError(res.error);
});

ui.resume.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'RESUME_JOB' }));

// Back to the form without discarding what was collected.
ui.again.addEventListener('click', () => {
  ui.form.hidden = false;
  ui.runView.hidden = true;
});

ui.goResults.addEventListener('click', () => setView(true));
ui.emptyGoSearch.addEventListener('click', () => setView(false));
ui.stop.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'CANCEL_JOB' }));

ui.clear.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'CLEAR_JOB' });
  if (res && res.job) render(res.job);
  rows = [];
  applyFilter();
});

ui.categoryFilter.addEventListener('change', saveSettings);
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

    // Confirm it happened; a dialog that closes with no trace reads as a
    // failure to anyone who was not watching the download shelf.
    ui.rowNote.textContent = `Saved ${filename}`;
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
  await restoreAi();
  const res = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
  render((res && res.job) || { status: 'idle', count: 0, tasksTotal: 0 });
  renderSeen((res && res.seen) || 0);

  // The worker can sleep between broadcasts; a slow poll keeps the panel honest.
  setInterval(async () => {
    if (!current || current.status !== 'running') return;
    const latest = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    if (latest && latest.job) render(latest.job);
  }, 2000);
})();
