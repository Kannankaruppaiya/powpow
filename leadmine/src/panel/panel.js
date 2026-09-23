/** Side panel — the extension's UI. */

import { buildFile } from '../lib/export.js';
import { summariseRates } from '../lib/health.js';
import { suggestionsFor, observedCategories } from '../lib/categories.js';
import { planSearches, listModels, planToBatch, providerFor, DEFAULT_PROVIDER } from '../lib/ai.js';
import { loadCountries, loadCountry, citiesFor, regionsFor, CITY_LIMIT } from '../lib/places.js';
import { URN_KEY, withSeed, lookup, labelsFor } from '../lib/urns.js';
import * as store from '../lib/store.js';
import { judgeLeads, effectiveVerdict, VERDICT_LABEL } from '../lib/qualify.js';
import { lookupTargets, findEmails, FINDERS, DEFAULT_FINDER } from '../lib/enrich.js';
import {
  STATUSES, statusPatch, isDue, suppressionChecker, suppressionEntriesFor,
  parseSuppressionText, suppressionText,
} from '../lib/crm.js';
import { linkRecords } from '../lib/link.js';
import { HOOK_KEY, DEFAULT_HOOK, sendToPowPow } from '../lib/powpow.js';
import { SCHEDULE_KEY, DEFAULT_SCHEDULE, cannotSchedule, describeSchedule, nextRunAt } from '../lib/schedule.js';

const SETTINGS_KEY = 'mls.settings';
/** The planner's credentials, stored apart from the form's settings. */
const AI_KEY = 'mls.ai';
/** The email finder's provider, key and spend limit. */
const FINDER_KEY = 'mls.finder';
/** What the user said a good lead is — the judge's brief, kept between runs. */
const JUDGE_BRIEF_KEY = 'mls.judgeBrief';
/** Row height, read from the stylesheet rather than duplicated here. */
const ROW_HEIGHT =
  parseInt(getComputedStyle(document.documentElement).getPropertyValue('--row-h'), 10) || 32;
const OVERSCAN = 8; // rows rendered above and below the viewport

const el = (id) => document.getElementById(id);
const ui = Object.fromEntries(
  [
    'form', 'statusPill', 'version', 'viewSetup', 'viewResults', 'paneSetup', 'paneResults', 'tabCount',
    'modeSingle', 'modeBatch', 'toggleBatch',
    'source', 'sourceGroup', 'sourceNote', 'coverageRow', 'coverage', 'coverageHint',
    'categoryLabel', 'cityLabel', 'limitLabel', 'limitHint', 'limitRow', 'limitSlot', 'advancedBody',
    'optEmails', 'optContact', 'optVerify', 'optDeep',
    'optCurrentTab', 'useCurrentTab', 'currentTabHint',
    'category', 'city', 'batch', 'grid', 'maxResults', 'postsRow', 'postsDays', 'postsIntentOnly',
    'country', 'region', 'cityOptions', 'placeRow', 'placeHint', 'cityIgnored', 'useTypedCity',
    'liFilters', 'optSplit', 'splitLocations',
    'geoInput', 'geoAdd', 'geoOptions', 'geoChips', 'geoHelp',
    'svcInput', 'svcAdd', 'svcOptions', 'svcChips',
    'categoryFilter', 'categoryFilterRow', 'categoryOptions', 'filterLabel', 'filterHint',
    'filterChip', 'filterChipText',
    'deep', 'fetchEmails', 'followContactPage', 'verifyEmails', 'skipSeen', 'seenNote',
    'start', 'resume', 'stop', 'again', 'goResults',
    'actionbar', 'barSearch', 'barResults', 'toast',
    'runView', 'spinner', 'runTitle', 'barFill', 'message', 'taskLine', 'withheldNote', 'budgetNote',
    'recentBox', 'recentList',
    'statFound', 'statFoundLabel', 'statPhones', 'statEmails', 'statSendable',
    'healthBox', 'healthList', 'error',
    'format', 'download', 'clear', 'filter',
    'scroller', 'viewport', 'spacer', 'rowBody', 'rowNote', 'footnote',
    'asideNote', 'asideText', 'asideToggle',
    'emptyResults', 'emptyGoSearch',
    'assist', 'assistSub', 'aiBrief', 'aiPlan', 'aiStatus', 'aiKeyHint', 'aiOpenSettings',
    'aiResult', 'aiUnderstood', 'aiList', 'aiApply', 'aiDiscard',
    'aiSettings', 'aiProvider', 'aiProviderName', 'aiKey', 'aiKeyLink',
    'aiModel', 'aiModelRow', 'aiModelToggle', 'aiModelHelp',
    'optRender', 'renderBlockedSites',
    'scheduleOn', 'scheduleRow', 'scheduleDays', 'scheduleTime', 'scheduleNote', 'scheduleUpdate',
    'powpowOn', 'powpowBody', 'powpowUrl', 'powpowToken', 'powpowChannel', 'powpowTo', 'powpowWhen',
    'powpowTest', 'powpowStatus',
    'runNotes', 'show', 'dueNote', 'dueText', 'dueShow', 'toolsBox',
    'judgeBrief', 'judgeScope', 'judgeRun', 'judgeStatus', 'judgeHelp',
    'finderBox', 'finderProvider', 'finderMax', 'finderKey', 'finderMaybe', 'finderRun', 'finderStatus',
    'finderHelp', 'dncText', 'dncSave', 'dncStatus', 'linkNote',
  ].map((id) => [id, el(id)])
);

/** The radio groups are the visible controls. */
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

/** What each level actually costs. */
const COVERAGE_HINT = {
  off: 'About 120 results · a few minutes',
  balanced: 'About 600 results · around 25 minutes',
  exhaustive: 'About 1,500 results · an hour or more',
};

function applyCoverage() {
  ui.coverageHint.textContent = COVERAGE_HINT[ui.grid.value] || '';
}

let current = null;
let batchMode = false;
/** Every record for the current job, loaded from IndexedDB for the table. */
let rows = [];
let visibleRows = [];
/** Rows the category filter set aside. Kept, so this is a view, not a re-run. */
let asideRows = [];
let showAside = false;
/** A finished job the user has pressed "New search" on. */
let dismissedJobId = null;
/** Whether the user has ever opened or closed the planner themselves. */
let assistChosen = false;
/** The state the code last asked the planner to be in. */
let assistIntended = null;

function setAssistOpen(open) {
  assistIntended = open;
  ui.assist.open = open;
}

/* ----------------------------------------------------------------- source */

/** The two sources ask for genuinely different things, so the form follows the choice. */
const SOURCE_UI = {
  maps: {
    categoryLabel: 'What are you looking for?',
    cityLabel: 'Where?',
    categoryPlaceholder: 'dentists',
    cityPlaceholder: 'Chennai',
    noun: 'businesses',
    limitLabel: 'Stop after this many per search',
    limitHint: 'Leave blank for no limit.',
    filterField: 'category',
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
    // One LinkedIn search is the whole run.
    noun: 'people',
    limitLabel: 'How many profiles?',
    limitHint: 'Leave blank for every profile LinkedIn will show you.',
    filterField: 'headline',
    assistSub:
      "Describe the person you need. I'll work out the titles and skills to search for.",
    assistPlaceholder:
      'I need freelance trainers who can teach ServiceNow to corporate teams in India',
    filterLabel: 'Headline contains',
    filterHint: 'A person has no category, so this matches their headline.',
    grid: false,
    emails: false,
    // Navigating to our own URL would throw away any filter the user applied.
    currentTab: true,
    note:
      'This reads the results you are already signed in to see. LinkedIn restricts ' +
      'accounts for automated collection, so keep runs small and infrequent.',
  },

  // The public web.
  web: {
    categoryLabel: 'What are you looking for?',
    cityLabel: 'Where?',
    categoryPlaceholder: 'corporate trainer kotlin',
    cityPlaceholder: 'Chennai',
    noun: 'people',
    limitLabel: 'How many results?',
    limitHint: 'Leave blank for every result the search engine will show.',
    filterField: 'headline',
    assistSub:
      "Describe the person you need. I'll work out what to search the public web for.",
    assistPlaceholder:
      'I need freelance trainers who can teach Kotlin to corporate teams in India',
    filterLabel: 'Result text contains',
    filterHint: 'This matches the name, headline and snippet of the result.',
    grid: false,
    emails: false,
    currentTab: false,
    note:
      'Searches Google for public LinkedIn profiles — no LinkedIn login and no ' +
      'connection-degree limit, so it names people a signed-in search would show only ' +
      'as “LinkedIn Member”. Public, indexed profiles only.',
  },

  // Recent posts that ask for something — "SAP FI trainer required, Mumbai".
  posts: {
    categoryLabel: 'What do they need?',
    cityLabel: 'Where?',
    categoryPlaceholder: 'corporate trainer',
    cityPlaceholder: 'Chennai',
    noun: 'posts',
    limitLabel: 'How many posts?',
    limitHint: 'Leave blank for every post the search will show.',
    filterField: 'text',
    assistSub:
      "Describe what people would be asking for. I'll work out the words their posts use.",
    assistPlaceholder: 'Companies posting that they need a ServiceNow trainer for their team',
    filterLabel: 'Post text contains',
    filterHint: 'Only keep posts that mention one of these. Separate several with commas.',
    grid: false,
    emails: false,
    // A LinkedIn post search the user has open has today's posts; an engine has them a week or more later.
    currentTab: true,
    note:
      'Finds public LinkedIn posts through Google — no login. Engines index posts days ' +
      'late, so for the newest ones open LinkedIn search → Posts → Latest → Past week, ' +
      'tick “Use the tab I’m on” and press Start.',
  },
};

function applySource() {
  const conf = SOURCE_UI[ui.source.value] || SOURCE_UI.maps;
  syncRadios('source', ui.source.value);
  ui.statFoundLabel.textContent = conf.noun;
  ui.filterLabel.textContent = conf.filterLabel;
  ui.limitLabel.textContent = conf.limitLabel;
  ui.limitHint.textContent = conf.limitHint;
  // A people search has no grid, so the slot the grid occupies asks the question that does apply to it.
  (conf.grid ? ui.advancedBody : ui.limitSlot).appendChild(ui.limitRow);
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
  applyCityOptions();
  ui.coverageRow.hidden = !conf.grid;
  applyCoverage();
  // The country/state picker names places; LinkedIn's filter takes its own ids.
  const people = ui.source.value === 'linkedin';
  ui.liFilters.hidden = !people;
  ui.placeRow.hidden = people;
  applyFacets();
  // The detail pass only exists for Maps.
  ui.optDeep.hidden = !conf.grid;
  for (const node of [ui.optEmails, ui.optContact, ui.optVerify, ui.optRender]) node.hidden = !conf.emails;
  ui.sourceNote.hidden = !conf.note;
  ui.sourceNote.textContent = conf.note;
  ui.postsRow.hidden = ui.source.value !== 'posts';
  applyFilterNote();
}

/** Say when a narrowing filter is active. */
function applyFilterNote() {
  const term = ui.categoryFilter.value.trim();
  const conf = SOURCE_UI[ui.source.value] || SOURCE_UI.maps;
  // The results view has its own bar, and the filter says nothing about rows that were already collected.
  ui.filterChip.hidden = !term || !ui.paneResults.hidden;
  if (!term) return;
  ui.filterChipText.textContent = `Only ${conf.filterLabel.toLowerCase()} matches “${term}”`;
}

/** In current-tab mode the search comes from the page, so the keyword and location inputs would be ignored. */
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
bindRadios('coverage', ui.grid, applyCoverage);

ui.source.addEventListener('change', () => {
  applySource();
  saveSettings();
});

ui.useCurrentTab.addEventListener('change', () => {
  applyCurrentTab();
  saveSettings();
});

/* ----------------------------------------------------------------- places */

// Country → state → town, as an aid to filling one box.

/** The country file for whatever is selected, or null for "Any country". */
let country = null;

async function fillCountries() {
  let list = [];
  try {
    list = await loadCountries();
  } catch {
    // The picker is an aid.
    ui.placeRow.hidden = true;
    return;
  }
  const any = new Option('Any country', '');
  ui.country.replaceChildren(
    any,
    ...list.map((item) => new Option(`${item.e ? `${item.e}  ` : ''}${item.n}`, item.c))
  );
}

/** Load the chosen country and rebuild the state list and the town list. */
async function applyCountry({ keepRegion = false } = {}) {
  const code = ui.country.value;
  country = code ? await loadCountry(code).catch(() => null) : null;

  const regions = regionsFor(country);
  const wanted = keepRegion ? ui.region.value : '';
  ui.region.hidden = !regions.length;
  ui.region.replaceChildren(
    new Option(regions.length ? 'Any state' : '', ''),
    ...regions.map((name) => new Option(name, name))
  );
  // A state from another country is not a state here.
  ui.region.value = regions.includes(wanted) ? wanted : '';

  applyCityOptions();
}

/** The towns the box offers. */
function applyCityOptions() {
  const towns = citiesFor(country, ui.region.value, { source: ui.source.value });
  ui.cityOptions.replaceChildren(...towns.map((name) => new Option(name)));

  // Only worth saying when the list is the reason something is missing.
  const capped = towns.length >= CITY_LIMIT;
  ui.placeHint.hidden = !capped;
  if (capped) {
    ui.placeHint.textContent =
      `Showing the first ${CITY_LIMIT.toLocaleString()} towns — pick a state to narrow it, ` +
      'or just type the town.';
  }
}

ui.country.addEventListener('change', async () => {
  await applyCountry();
  saveSettings();
});

ui.region.addEventListener('change', () => {
  applyCityOptions();
  saveSettings();
});

/* ------------------------------------------------------ LinkedIn filters */

// LinkedIn's own filters, which take ids rather than names.

let urns = {};
/** What the user has chosen, as [{ id, label }] per facet. */
const chosen = { geoUrn: [], serviceCategory: [] };

const FACET_UI = {
  geoUrn: { input: 'geoInput', options: 'geoOptions', chips: 'geoChips', help: 'geoHelp' },
  serviceCategory: { input: 'svcInput', options: 'svcOptions', chips: 'svcChips' },
};

async function restoreUrns() {
  const stored = await chrome.storage.local.get(URN_KEY);
  urns = withSeed(stored[URN_KEY]);
  for (const facet of Object.keys(FACET_UI)) fillFacetOptions(facet);
}

function fillFacetOptions(facet) {
  const ui_ = FACET_UI[facet];
  const labels = labelsFor(urns, facet);
  ui[ui_.options].replaceChildren(...labels.map((label) => new Option(label)));
  if (!ui_.help) return;

  // Say where the list comes from.
  ui[ui_.help].textContent = labels.length
    ? `Type any place. ${labels.length} already known, so those skip a step; ` +
      'anything else is looked up on LinkedIn when the run starts.'
    : 'Type any place — LeadMine picks it in LinkedIn’s own filter when the run starts.';
}

function renderChips(facet) {
  const ui_ = FACET_UI[facet];
  ui[ui_.chips].replaceChildren(
    ...chosen[facet].map((value) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.title = `${value.label} — click to remove`;
      chip.append(Object.assign(document.createElement('span'), { textContent: value.label }));
      chip.append(Object.assign(document.createElement('em'), { textContent: '✕' }));
      chip.addEventListener('click', () => {
        // By label, not by id: a name LinkedIn has never been asked about has no id yet.
        chosen[facet] = chosen[facet].filter((v) => v !== value);
        renderChips(facet);
        applyFacets();
        saveSettings();
      });
      return chip;
    })
  );
}

function setFacetHelp(facet, text) {
  const ui_ = FACET_UI[facet];
  if (ui_.help) ui[ui_.help].textContent = text;
}

/** Add a filter value. */
function addFacet(facet) {
  const ui_ = FACET_UI[facet];
  const label = ui[ui_.input].value.trim();
  if (!label) return;

  if (!chosen[facet].some((v) => v.label.toLowerCase() === label.toLowerCase())) {
    // The id when it is known, so the run can skip the panel; blank otherwise, and the run asks LinkedIn.
    chosen[facet].push({ id: lookup(urns, facet, label), label });
  }
  ui[ui_.input].value = '';
  fillFacetOptions(facet);
  renderChips(facet);
  applyFacets();
  saveSettings();
}

/** Take up anything typed but not added. */
function flushFacets() {
  for (const facet of Object.keys(FACET_UI)) addFacet(facet);
}

/** Show the split option only when there is something to split, and say which place the run will actually search. */
function applyFacets() {
  // These are LinkedIn's filters.
  const people = ui.source.value === 'linkedin';
  const places = people ? chosen.geoUrn.map((v) => v.label) : [];
  ui.optSplit.hidden = places.length < 2;
  // A box that is silently ignored is a box people fill in and then distrust.
  ui.city.disabled = places.length > 0;
  ui.cityIgnored.hidden = !places.length;

  const typed = ui.city.value.trim();
  const covered =
    !typed || places.some((p) => p.toLowerCase() === typed.toLowerCase());

  if (places.length) {
    ui.cityIgnored.textContent = covered
      ? `Searching ${places.join(', ')} — the LinkedIn location filter below.`
      : `Searching ${places.join(', ')} — the LinkedIn location filter below. “${typed}” is not being used.`;
  }
  ui.useTypedCity.hidden = !places.length || covered;
  if (!ui.useTypedCity.hidden) ui.useTypedCity.textContent = `Search ${typed} instead`;
}

// Replace the location filter with the town in the box.
ui.useTypedCity.addEventListener('click', () => {
  const label = ui.city.value.trim();
  if (!label) return;
  chosen.geoUrn = [{ id: lookup(urns, 'geoUrn', label), label }];
  renderChips('geoUrn');
  applyFacets();
  saveSettings();
});

for (const [facet, ui_] of Object.entries(FACET_UI)) {
  ui[`${facet === 'geoUrn' ? 'geo' : 'svc'}Add`].addEventListener('click', () => addFacet(facet));
  ui[ui_.input].addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // The form would otherwise take this as "start the run".
    event.preventDefault();
    addFacet(facet);
  });
  // Looking away is as clear a signal as pressing the button.
  ui[ui_.input].addEventListener('blur', () => addFacet(facet));
}

/* ------------------------------------------------------------------- tabs */

function setView(showResults) {
  ui.paneSetup.hidden = showResults;
  ui.paneResults.hidden = !showResults;
  ui.viewSetup.classList.toggle('is-active', !showResults);
  ui.viewResults.classList.toggle('is-active', showResults);
  // The bar always carries the action of the view above it.
  ui.barSearch.hidden = showResults;
  ui.barResults.hidden = !showResults;
  applyFilterNote();
  if (showResults) refreshRows();
}

ui.viewSetup.addEventListener('click', () => setView(false));
ui.viewResults.addEventListener('click', () => setView(true));

function setMode(useBatch) {
  batchMode = useBatch;
  ui.modeBatch.hidden = !useBatch;
  ui.toggleBatch.textContent = useBatch ? '− Just one search' : '+ Search several at once';
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
  // A first-ever open has nothing stored and still needs the source applied.
  if (!s) {
    applyCoverage();
    applySource();
    return;
  }
  ui.category.value = s.category ?? '';
  ui.city.value = s.city ?? '';
  ui.country.value = s.country ?? '';
  ui.region.value = s.region ?? '';
  ui.splitLocations.checked = s.splitLocations !== false;
  for (const facet of Object.keys(chosen)) {
    const ids = (s.facets && s.facets[facet]) || [];
    const labels = (s.facetLabels && s.facetLabels[facet]) || [];
    chosen[facet] = ids.map((id, i) => ({ id, label: labels[i] || id })).filter((v) => v.id);
    renderChips(facet);
  }
  ui.batch.value = s.batch ?? '';
  ui.grid.value = s.grid || 'balanced';
  // Blank and zero mean the same thing to `readConfig`.
  ui.maxResults.value = s.maxResults || '';
  ui.deep.checked = s.deep !== false;
  ui.fetchEmails.checked = s.fetchEmails !== false;
  ui.followContactPage.checked = s.followContactPage !== false;
  ui.verifyEmails.checked = s.verifyEmails !== false;
  ui.renderBlockedSites.checked = s.renderBlockedSites !== false;
  ui.show.value = ['all', 'fit', 'fitmaybe', 'unjudged', 'due', 'active'].includes(s.show) ? s.show : 'all';
  ui.skipSeen.checked = Boolean(s.skipSeen);
  ui.useCurrentTab.checked = Boolean(s.useCurrentTab);
  ui.categoryFilter.value = s.categoryFilter ?? '';
  ui.postsDays.value = ['3', '7', '10', '14', '30'].includes(String(s.postsDays)) ? String(s.postsDays) : '10';
  ui.postsIntentOnly.checked = s.postsIntentOnly !== false;
  // Someone who knows their own searches closes the planner once and should never have to close it again.
  assistChosen = typeof s.assistOpen === 'boolean';
  if (assistChosen) setAssistOpen(s.assistOpen);
  // An older build stored "xls"; the exporter only writes real xlsx now.
  ui.format.value = s.format === 'xls' ? 'xlsx' : s.format || 'xlsx';
  ui.source.value = s.source || 'maps';
  // Only the three offered levels can be restored; anything else falls back.
  ui.grid.value = COVERAGE_CHOICES.includes(s.grid) ? s.grid : 'balanced';
  syncRadios('coverage', ui.grid.value);
  applyCoverage();
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
    // Kept so the picker comes back where it was left.
    country: ui.country.value,
    region: ui.region.value,
    // LinkedIn's real filters: ids for the run, labels for the records and for putting the form back the way it was.
    facets: Object.fromEntries(
      Object.entries(chosen).map(([facet, values]) => [facet, values.map((v) => v.id)])
    ),
    facetLabels: Object.fromEntries(
      Object.entries(chosen).map(([facet, values]) => [facet, values.map((v) => v.label)])
    ),
    splitLocations: ui.splitLocations.checked,
    // Only send the batch text when the batch tab is active, so a leftover draft cannot hijack a single search.
    batch: batchMode ? ui.batch.value : '',
    batchMode,
    grid: ui.grid.value,
    assistOpen: ui.assist.open,
    maxResults: Math.max(0, Number(ui.maxResults.value) || 0),
    postsDays: Number(ui.postsDays.value) || 10,
    postsIntentOnly: ui.postsIntentOnly.checked,
    deep: ui.deep.checked,
    fetchEmails: ui.fetchEmails.checked,
    followContactPage: ui.followContactPage.checked,
    verifyEmails: ui.verifyEmails.checked,
    renderBlockedSites: ui.renderBlockedSites.checked,
    skipSeen: ui.skipSeen.checked,
    format: ui.format.value,
    // Which leads Results shows.
    show: ui.show.value,
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

// A lot of people know their business perfectly well and still cannot guess which Maps searches find its.

// Keys and models are kept per provider.
let ai = { provider: DEFAULT_PROVIDER, keys: {}, models: {} };
let plan = null;

async function restoreAi() {
  const stored = await chrome.storage.local.get(AI_KEY);
  const saved = stored[AI_KEY] || {};
  ai = {
    provider: saved.provider || DEFAULT_PROVIDER,
    keys: { ...(saved.keys || {}) },
    models: { ...(saved.models || {}) },
  };
  // An earlier build stored one key and one model, with no provider attached.
  if (saved.key) ai.keys[ai.provider] = ai.keys[ai.provider] || saved.key;
  if (saved.model) ai.models[ai.provider] = ai.models[ai.provider] || saved.model;

  ui.aiProvider.value = ai.provider;
  syncRadios('aiProvider', ai.provider);
  applyProvider();
}

const saveAi = () => {
  ai.provider = ui.aiProvider.value;
  ai.keys[ai.provider] = ui.aiKey.value.trim();
  ai.models[ai.provider] = ui.aiModel.value.trim();
  return chrome.storage.local.set({ [AI_KEY]: ai });
};

/** Everything that changes when you switch between Gemini and Groq. */
function applyProvider() {
  const conf = providerFor(ui.aiProvider.value);
  ui.aiKey.value = ai.keys[conf.id] || '';
  ui.aiProviderName.textContent = conf.label;
  ui.aiKeyLink.href = conf.keyUrl;
  ui.aiKey.placeholder = `${conf.label} key — ${conf.keyHint}`;

  // The picker starts as just the recommended model.
  const chosen = ai.models[conf.id] || '';
  setModelOptions(chosen ? [{ id: chosen, label: chosen }] : [], chosen);
  const open = Boolean(chosen);
  ui.aiModelRow.hidden = !open;
  ui.aiModelToggle.hidden = open;
  if (open) loadModels();
  applyKeyState();
}

/** Fill the picker. */
function setModelOptions(models, selected) {
  const conf = providerFor(ui.aiProvider.value);
  const options = [{ id: '', label: `Recommended — ${conf.defaultModel}` }, ...models];
  // A model chosen earlier must stay selectable even if the list has not arrived yet.
  if (selected && !models.some((m) => m.id === selected)) {
    options.push({ id: selected, label: selected });
  }

  ui.aiModel.replaceChildren();
  for (const model of options) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    ui.aiModel.append(option);
  }
  ui.aiModel.value = selected || '';
}

let modelsToken = 0;

/** Ask the provider which models this key can use. */
async function loadModels() {
  const conf = providerFor(ui.aiProvider.value);
  const key = ui.aiKey.value.trim();
  if (!key) {
    ui.aiModelHelp.textContent = 'Add a key first, then this lists what it can use.';
    return;
  }

  const token = (modelsToken += 1);
  ui.aiModelHelp.textContent = 'Loading the list…';
  try {
    const models = await listModels({ provider: conf.id, apiKey: key });
    // A slow answer for a provider the user has since switched away from must not overwrite the picker.
    if (token !== modelsToken || providerFor(ui.aiProvider.value).id !== conf.id) return;
    setModelOptions(models, ai.models[conf.id] || '');
    ui.aiModelHelp.textContent = `${models.length} models available to this key.`;
  } catch (err) {
    if (token !== modelsToken) return;
    ui.aiModelHelp.textContent = err.message;
  }
}

/** The one thing that gates the button: is there a key for this provider? */
function applyKeyState() {
  const has = Boolean(ui.aiKey.value.trim());
  ui.aiKeyHint.hidden = has;
  ui.aiPlan.disabled = !has;
  // No key means nothing here can run, so it starts folded.
  if (!assistChosen) setAssistOpen(has);
  // The judge uses the same key, so it unlocks with it.
  applyJudgeState();
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
      // The plan's size follows the same dial as the run's.
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

  // The batch box is the queue's own input format.
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
  // Save the boxes as they stand before repainting them for the new provider.
  ai.keys[ai.provider] = ui.aiKey.value.trim();
  ai.models[ai.provider] = ui.aiModel.value.trim();
  applyProvider();
  saveAi();
});
for (const field of [ui.aiKey, ui.aiModel]) {
  field.addEventListener('change', () => {
    applyKeyState();
    saveAi();
  });
}
// The Plan button unlocks as soon as a key is typed, without waiting for blur.
ui.aiKey.addEventListener('input', applyKeyState);
ui.aiKey.addEventListener('change', () => {
  if (!ui.aiModelRow.hidden) loadModels();
});

ui.aiModelToggle.addEventListener('click', () => {
  ui.aiModelRow.hidden = false;
  ui.aiModelToggle.hidden = true;
  ui.aiModel.focus();
  loadModels();
});

/* ---------------------------------------------------------- virtual table */

// What was decided about the leads, loaded beside the leads themselves.
let notes = new Map();
let library = [];
let links = { personToBusiness: new Map(), businessToPeople: new Map() };
let suppression = [];
let isSuppressed = () => false;
let libraryAt = 0;

async function refreshAnnotations(all) {
  notes = await store.getNotes(all.map((r) => r.key)).catch(() => new Map());
  // Every record from every run is a read of the whole database.
  const running = current && current.status === 'running';
  if (!running || Date.now() - libraryAt > 30000) {
    library = await store.getAllRecords().catch(() => all);
    links = linkRecords(library);
    libraryAt = Date.now();
  }
  await loadSuppression();
  renderDue();
  renderLinkNote();
  applyFinderBox();
}

async function loadSuppression() {
  suppression = await store.getSuppression().catch(() => []);
  isSuppressed = suppressionChecker(suppression);
  // Never overwrite a list the user is in the middle of typing.
  if (document.activeElement !== ui.dncText) ui.dncText.value = suppressionText(suppression);
}

/** Load this job's records from IndexedDB and redraw the table. */
async function refreshRows() {
  const jobId = current && current.jobId;
  const all = jobId ? await store.getRecords(jobId) : [];
  rows = all.filter((r) => !r.setAside);
  asideRows = all.filter((r) => r.setAside);
  // Nothing kept and something set aside is the filter being wrong, not the scraper finding nothing.
  if (!rows.length && asideRows.length) showAside = true;
  await refreshAnnotations(all);
  refreshCategoryOptions();
  applyFilter();
}

/** Somebody is waiting on a reply today — said before anything else. */
function renderDue() {
  const due = rows.filter((r) => isDue(notes.get(r.key)));
  ui.dueNote.hidden = !due.length || ui.show.value === 'due';
  if (due.length) {
    ui.dueText.textContent = `${due.length} ${due.length === 1 ? 'lead is' : 'leads are'} due a follow-up today.`;
  }
}

function renderLinkNote() {
  const people = rows.filter((r) => links.personToBusiness.has(r.key)).length;
  const businesses = rows.filter((r) => links.businessToPeople.has(r.key)).length;
  ui.linkNote.hidden = !people && !businesses;
  ui.linkNote.textContent = people
    ? `${people} of these ${people === 1 ? 'person works' : 'people work'} at a business you found on Maps — the export has its phone and website.`
    : businesses
      ? `${businesses} of these businesses have people you found on LinkedIn — the export names them.`
      : '';
}

/** A view filter over what was decided, not what the lead says. */
function passesShow(record) {
  const note = notes.get(record.key) || {};
  const verdict = effectiveVerdict(note);
  switch (ui.show.value) {
    case 'fit':
      return verdict === 'fit';
    case 'fitmaybe':
      return verdict === 'fit' || verdict === 'maybe';
    case 'unjudged':
      return !verdict;
    case 'due':
      return isDue(note);
    case 'active':
      return ['contacted', 'followed_up', 'replied', 'meeting'].includes(note.status);
    default:
      return true;
  }
}

/** What the filter set aside, and what it could have matched. */
function renderAside() {
  ui.asideNote.hidden = !asideRows.length;
  if (!asideRows.length) return;

  const sourceId = current && current.config && current.config.source;
  const conf = SOURCE_UI[sourceId] || SOURCE_UI.maps;

  // A Posts run sets rows aside for several reasons at once.
  const reasons = new Map();
  for (const row of asideRows) reasons.set(row.setAside, (reasons.get(row.setAside) || 0) + 1);
  if (sourceId === 'posts' || reasons.size > 1) {
    const parts = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n.toLocaleString()} ${reason}`);
    ui.asideText.textContent = `${asideRows.length.toLocaleString()} set aside — ${parts.join(', ')}. `;
    ui.asideToggle.textContent = showAside ? 'Hide them' : 'Show them';
    return;
  }

  const term = asideRows[0].setAside;
  const found = observedCategories(asideRows, conf.filterField).slice(0, 4);

  ui.asideText.textContent =
    `${asideRows.length.toLocaleString()} set aside by ${conf.filterLabel.toLowerCase()} “${term}”` +
    (rows.length ? '. ' : ` — nothing else matched. What was found: ${found.join(', ')}. `);
  ui.asideToggle.textContent = showAside ? 'Hide them' : 'Show them';
}

/** Offer the categories this run actually produced, ahead of the standing list. */
function refreshCategoryOptions() {
  const field = (SOURCE_UI[ui.source.value] || SOURCE_UI.maps).filterField;
  ui.categoryOptions.replaceChildren(
    ...suggestionsFor(rows, field).slice(0, 60).map((value) => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    })
  );
}

function applyFilter() {
  const needle = ui.filter.value.trim().toLowerCase();
  // What is on screen is what Download writes — no hidden discrepancy.
  const source = (showAside ? [...rows, ...asideRows] : rows).filter(passesShow);
  visibleRows = !needle
    ? source
    : source.filter((r) =>
        // Every field a card shows, whichever kind of row it is.
        [r.name, r.area, r.category, r.city, r.email, r.phone,
          r.headline, r.company, r.location, r.summary, r.text, r.emails, r.phones, r.intent,
          ...(() => {
            // What the judge said is searchable too: "trainer" should find the business whose reason reads "hires trainers".
            const n = notes.get(r.key) || {};
            return [n.reason, n.services, n.decisionMaker, n.personEmail];
          })()]
          .some((v) => String(v || '').toLowerCase().includes(needle))
      );

  renderAside();

  // An empty results view gets a designed state, not a bare sentence.
  const bare = !visibleRows.length && !ui.filter.value.trim();
  ui.emptyResults.hidden = !bare;
  ui.scroller.hidden = bare;
  ui.rowNote.hidden = bare;

  ui.spacer.style.height = `${visibleRows.length * ROW_HEIGHT}px`;
  ui.rowNote.textContent = visibleRows.length
    ? `${visibleRows.length.toLocaleString()}${needle ? ` of ${source.length.toLocaleString()}` : ''} rows`
    : source.length
      ? 'Nothing matches that filter.'
      : 'Nothing collected yet — run a search first.';
  drawWindow();
}

/** One lead, three lines. */
// How much of LinkedIn's monthly allowance this extension has spent.
function renderBudget(budget) {
  if (!budget || !ui.budgetNote) return;
  const month = budget.inMonth || 0;
  ui.budgetNote.hidden = !month;
  if (!month) return;
  const near = month >= 250;
  ui.budgetNote.classList.toggle('warn', near);
  ui.budgetNote.textContent =
    `${month} LinkedIn search pages this month (${budget.inDay || 0} today). ` +
    (near
      ? 'A free account gets roughly 300 before LinkedIn shows only three results per search.'
      : 'A free account gets roughly 300 a month.');
}

function leadCard(record) {
  const card = document.createElement('div');
  card.className = 'lead';
  card.dataset.key = record.key || '';
  const note = notes.get(record.key) || {};
  if (isSuppressed(record, note)) card.classList.add('is-dnc');
  const business = links.personToBusiness.get(record.key);
  const staff = links.businessToPeople.get(record.key) || [];
  // A record about a person, whichever door it came through.
  const person = record.source === 'linkedin' || record.source === 'web';
  const lines = record.source === 'posts'
    ? postLines(record)
    : person
    ? [
        [
          'lead-1',
          [
            // A person's profile link is the thing you actually go and do something with.
            record.profileUrl
              ? copyable(record.profileUrl, 'lead-name', record.name)
              : text('lead-name', record.name),
            // Outside LinkedIn there is no degree to show.
            text('lead-mark', record.degree || (record.source === 'web' ? 'public' : '')),
          ],
        ],
        ['lead-2', [text('lead-sub lead-headline', record.headline)]],
        [
          'lead-3',
          [
            // A found work email is the thing to act on, so it leads the line.
            note.personEmail ? copyable(note.personEmail, 'lead-email') : null,
            text('lead-sub lead-area', [record.company, record.location].filter(Boolean).join(' · ')),
            text(
              'lead-tag',
              business ? `at ${business.name} (Maps)` : record.openToWork ? 'open to work' : ''
            ),
          ],
        ],
      ]
    : [
        [
          'lead-1',
          [text('lead-name', record.name), text('lead-mark', record.rating ? `★ ${record.rating}` : '')],
        ],
        [
          'lead-2',
          [
            copyable(record.phone, 'lead-phone'),
            record.area ? text('lead-dot', '·') : null,
            record.area ? text('lead-sub lead-area', record.area) : null,
            staff.length ? text('lead-tag', `${staff.length} ${staff.length === 1 ? 'person' : 'people'} on LinkedIn`) : null,
          ],
        ],
        ['lead-3', [emailCell(record), text('lead-tag', record.category)]],
      ];

  lines.push(['lead-4', decisionLine(record, note)]);

  for (const [cls, kids] of lines) {
    const row = document.createElement('div');
    row.className = `lead-line ${cls}`;
    row.append(...kids.filter(Boolean));
    card.appendChild(row);
  }
  return card;
}

/** The fourth line: what was decided about this lead. */
function decisionLine(record, note) {
  const verdict = effectiveVerdict(note);
  const badge = document.createElement('span');
  badge.className = 'verdict';
  if (verdict) {
    badge.dataset.v = verdict;
    badge.textContent = VERDICT_LABEL[verdict];
  }
  const reason = note.feedback && note.feedbackWhy ? note.feedbackWhy : note.reason || '';
  const why = text('lead-why', reason || (note.services ? note.services : ''));
  if (note.decisionMaker) why.title = `${reason}${reason ? ' — ' : ''}${note.decisionMaker}`;

  const status = document.createElement('select');
  status.className = 'lead-status';
  status.dataset.status = record.key || '';
  status.setAttribute('aria-label', `Status of ${record.name || record.author || 'this lead'}`);
  for (const option of STATUSES) status.append(new Option(option.label, option.id));
  status.value = note.status || 'new';
  if (isDue(note)) {
    status.classList.add('is-due');
    status.title = `Follow up due ${note.followUpOn}`;
  } else if (note.followUpOn) {
    status.title = `Follow up on ${note.followUpOn}`;
  }

  const mark = (value, glyph, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mark';
    button.dataset.mark = value;
    button.textContent = glyph;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(note.feedback === value));
    return button;
  };

  return [
    verdict ? badge : null,
    why,
    status,
    mark('good', '👍', 'A good lead — the judge should find more like this'),
    mark('bad', '👎', 'Not a good lead — the judge should skip ones like this'),
  ];
}

/** A post, three lines: who and how long ago, what it says, how to reach them. */
function postLines(record) {
  const age = record.ageDays === '' || record.ageDays === undefined ? '' : ageLabel(Number(record.ageDays));
  return [
    [
      'lead-1',
      [
        record.postUrl
          ? copyable(record.postUrl, 'lead-name', record.author || record.name || 'LinkedIn post')
          : text('lead-name', record.author || record.name),
        text('lead-mark', age),
      ],
    ],
    ['lead-2', [text('lead-sub lead-headline', record.text || record.headline)]],
    [
      'lead-3',
      [
        (notes.get(record.key) || {}).personEmail
          ? copyable(notes.get(record.key).personEmail, 'lead-email')
          : record.emails
            ? copyable(String(record.emails).split(';')[0].trim(), 'lead-email')
            : null,
        record.phones ? copyable(String(record.phones).split(';')[0].trim(), 'lead-phone') : null,
        text('lead-tag', record.setAside || (record.intent && record.intent !== 'DEMAND' ? record.intent.toLowerCase() : '')),
      ],
    ],
  ];
}

/** "today", "1 day ago", "9 days ago" — a post's age as a person says it. */
function ageLabel(days) {
  if (!Number.isFinite(days)) return '';
  const whole = Math.floor(days);
  if (whole <= 0) return 'today';
  return whole === 1 ? '1 day ago' : `${whole} days ago`;
}

function text(cls, value) {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = value || '';
  if (value) span.title = value;
  return span;
}

/** A value you are going to paste somewhere else, rendered as the button that puts it there. */
function copyable(value, cls, label) {
  if (!value) return text(`lead-none ${cls}`, '—');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `copy ${cls}`;
  button.textContent = label || value;
  button.title = `${value} — click to copy`;
  button.dataset.copy = value;
  return button;
}

function emailCell(record) {
  const cell = copyable(record.email, 'lead-email');
  // Verification says this one will bounce.
  if (
    record.email &&
    record.emailStatus &&
    !['valid', 'role', 'unknown'].includes(record.emailStatus)
  ) {
    cell.classList.add('bad');
    cell.title = `${record.email} — ${record.emailStatusReason || record.emailStatus}`;
  }
  return cell;
}

/** Render only the cards on screen. */
function drawWindow() {
  const scrollTop = ui.viewport.scrollTop;
  const height = ui.viewport.clientHeight || 400;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;

  const body = document.createDocumentFragment();
  for (const record of visibleRows.slice(first, first + count)) body.appendChild(leadCard(record));

  ui.rowBody.replaceChildren(body);
  // Offset the rendered block so it sits where those cards belong.
  ui.rowBody.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
}

/** Says a value reached the clipboard. Nothing else would. */
let toastTimer = null;
function flash(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 1400);
}

/** The record a card belongs to, from what is on screen. */
const recordFor = (key) => visibleRows.find((r) => r.key === key) || rows.find((r) => r.key === key);

/** Merge a patch into the in-memory notes as well as the store. */
async function saveNote(key, patch) {
  await store.putNotes([{ key, ...patch }]);
  const next = { ...(notes.get(key) || { key }), ...patch };
  for (const [field, value] of Object.entries(next)) if (value === null) delete next[field];
  notes.set(key, next);
}

ui.rowBody.addEventListener('click', async (event) => {
  const markButton = event.target.closest('.mark');
  if (markButton) {
    const key = markButton.closest('.lead').dataset.key;
    if (!key) return;
    const value = markButton.dataset.mark;
    const note = notes.get(key) || {};
    // Pressing the mark that is already on takes it back.
    const next = note.feedback === value ? null : value;
    await saveNote(key, { feedback: next, feedbackAt: next ? Date.now() : null });
    flash(next ? (next === 'good' ? 'Marked good — the judge will learn from it' : 'Marked not a fit') : 'Mark removed');
    applyFilter();
    return;
  }

  const target = event.target.closest('.copy');
  if (!target) return;
  try {
    await navigator.clipboard.writeText(target.dataset.copy);
    flash('Copied');
  } catch {
    flash('Could not copy');
  }
});

ui.rowBody.addEventListener('change', async (event) => {
  const select = event.target.closest('.lead-status');
  if (!select) return;
  const key = select.dataset.status;
  const record = recordFor(key);
  const note = notes.get(key) || {};
  await saveNote(key, statusPatch(note, select.value));

  // "Do not contact" is not a label, it is a promise.
  if (select.value === 'do_not_contact' && record) {
    await store.addSuppression(suppressionEntriesFor(record, notes.get(key)));
    await loadSuppression();
    flash('On the do-not-contact list');
  } else if (select.value === 'contacted') {
    flash(`Follow up on ${notes.get(key).followUpOn}`);
  }
  renderDue();
  applyFilter();
});

ui.viewport.addEventListener('scroll', () => requestAnimationFrame(drawWindow), { passive: true });
ui.filter.addEventListener('input', applyFilter);
ui.show.addEventListener('change', () => {
  renderDue();
  applyFilter();
  saveSettings();
});
ui.dueShow.addEventListener('click', () => {
  ui.show.value = 'due';
  renderDue();
  applyFilter();
  saveSettings();
});

/* ---------------------------------------------------------------- rendering */

function showError(text) {
  ui.error.hidden = !text;
  ui.error.textContent = text || '';
}

/** Progress is only meaningful where a total is known. */
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
  const previousStatus = current ? current.status : null;
  current = job;

  const running = job.status === 'running';
  const settled = ['done', 'error', 'cancelled', 'paused'].includes(job.status);

  // The form and the run never share the screen.
  const dismissed = !running && job.jobId && (job.stale || job.jobId === dismissedJobId);
  const showRun = !dismissed && (running || (settled && job.status !== 'idle' && job.tasksTotal > 0));

  // The chip reports the run on screen, so a run that is no longer on screen has no status to report.
  ui.statusPill.hidden = dismissed || job.status === 'idle';
  ui.statusPill.textContent = PILL[job.status] || job.status;
  ui.statusPill.dataset.state = job.status;
  ui.form.hidden = showRun;
  ui.runView.hidden = !showRun;

  // The bar answers one question — what do I do now?
  ui.start.hidden = showRun || job.canResume;
  ui.resume.hidden = !job.canResume;
  ui.stop.hidden = !running;
  ui.again.hidden = !showRun || running;
  ui.goResults.hidden = !showRun || running || !job.count;
  ui.spinner.hidden = !running;

  // One primary action per view.
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

  // LinkedIn shows people it will not name.
  const withheld = job.withheld || 0;
  ui.withheldNote.hidden = !withheld || running;
  if (withheld && !running) {
    ui.withheldNote.textContent =
      `LinkedIn would not name ${withheld} ${withheld === 1 ? 'person' : 'people'} it showed — ` +
      'they are outside your network, so the card reads “LinkedIn Member” with no profile ' +
      'link on it. Nothing was lost in the scrape. Run the same search on Public web to ' +
      'find them by name.';
  }

  ui.taskLine.hidden = !job.tasksTotal;
  if (job.tasksTotal) {
    const notes = [
      job.filteredOut ? `${job.filteredOut} set aside by ${(SOURCE_UI[job.config && job.config.source] || SOURCE_UI.maps).filterLabel.toLowerCase()}` : '',
      job.skippedSeen ? `${job.skippedSeen} already downloaded` : '',
    ].filter(Boolean);
    const term = job.task && [job.task.term, job.task.city].filter(Boolean).join(', ');
    ui.taskLine.textContent =
      `Search ${Math.min(job.tasksSettled + (running ? 1 : 0), job.tasksTotal)} of ${job.tasksTotal}` +
      (running && term ? ` · ${term}` : '') +
      (notes.length ? ` · ${notes.join(' · ')}` : '') +
      (!running && job.stoppedBecause ? ` · stopped because ${job.stoppedBecause}` : '');
  }

  renderRunNotes(job, running);

  // Progress belongs to a run in progress.
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
  if (job.count !== previousCount || job.status !== previousStatus) void refreshRecent(job);
  // A run can finish with nothing to show; the reason is the useful part — until the user has moved on from it.
  showError(
    dismissed
      ? ''
      : job.status === 'error' || job.status === 'paused'
        ? job.error
        : job.taskError || ''
  );

  // Reload the list when the result count moved or a new job started.
  if (job.count !== previousCount || job.jobId !== previousJobId) {
    if (!ui.paneResults.hidden) refreshRows();
  }

  // A finished run exists for the rows it produced, and reaching them meant noticing a tab and clicking it.
  if (job.status === 'done' && previousStatus === 'running' && job.count) setView(true);
}

/** What the run did beyond collecting, one line each, only when it happened. */
function renderRunNotes(job, running) {
  const lines = [];
  if (job.healed && job.healed.length) {
    lines.push(
      `Maps moved part of its page (${job.healed.join(', ')}). LeadMine found it again by how it looks, ` +
        'so the results are fine — docs/SELECTORS.md still wants updating.'
    );
  }
  if (job.rendered) {
    lines.push(`${job.rendered} ${job.rendered === 1 ? 'website' : 'websites'} needed a real browser tab to show their email.`);
  }
  if (job.suppressed && !running) {
    lines.push(`${job.suppressed} set aside — on your do-not-contact list.`);
  }
  if (job.scheduled) lines.push('This was a scheduled run: only leads you had not seen before.');
  if (job.notified && !running) lines.push(job.notified);
  ui.runNotes.hidden = !lines.length;
  ui.runNotes.replaceChildren(
    ...lines.map((line) => Object.assign(document.createElement('li'), { textContent: line }))
  );
}

/** The last few names to arrive. */
let recentNames = [];
async function refreshRecent(job) {
  if (!job || job.status !== 'running' || !job.jobId || !job.count) {
    ui.recentBox.hidden = true;
    recentNames = [];
    return;
  }
  const tail = await store.pageRecords(job.jobId, Math.max(0, job.count - 5), 5);
  const names = tail.map((r) => r.name).filter(Boolean).reverse();
  ui.recentBox.hidden = !names.length;
  if (!names.length) return;

  // Only what is actually new animates.
  const before = new Set(recentNames);
  ui.recentList.replaceChildren(
    ...names.map((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      li.title = name;
      if (!before.has(name)) li.classList.add('is-new');
      return li;
    })
  );
  recentNames = names;
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

  // A filter typed and left in its box is a filter the user meant.
  if (ui.source.value === 'linkedin' && !ui.liFilters.hidden) flushFacets();

  const config = readConfig();
  const conf = SOURCE_UI[config.source] || SOURCE_UI.maps;
  // Current-tab mode takes the search off the page, so there is nothing to validate here.
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
  dismissedJobId = (current && current.jobId) || null;
  ui.form.hidden = false;
  ui.runView.hidden = true;
  ui.statusPill.hidden = true;
  // The bar follows the view: the form is back, so Start is the action again.
  ui.again.hidden = true;
  ui.goResults.hidden = true;
  ui.start.hidden = false;
  showError('');
  applyFilterNote();
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

ui.asideToggle.addEventListener('click', () => {
  showAside = !showAside;
  applyFilter();
});

ui.categoryFilter.addEventListener('input', applyFilterNote);
ui.categoryFilter.addEventListener('change', () => {
  applyFilterNote();
  saveSettings();
});

ui.filterChip.addEventListener('click', () => {
  ui.categoryFilter.value = '';
  applyFilterNote();
  saveSettings();
});

ui.assist.addEventListener('toggle', () => {
  if (ui.assist.open === assistIntended) {
    assistIntended = null;
    return;
  }
  assistChosen = true;
  saveSettings();
});
ui.format.addEventListener('change', saveSettings);

// Keep whatever is in the form.
let saveTimer = null;
ui.form.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 250);
});

ui.download.addEventListener('click', async () => {
  showError('');
  ui.download.disabled = true;
  const label = ui.download.textContent;
  ui.download.textContent = 'Building…';
  try {
    // Straight from the database: no message-size ceiling on a big export.
    const stored = current && current.jobId ? await store.getRecords(current.jobId) : [];
    const all = showAside ? stored : stored.filter((r) => !r.setAside);
    if (!all.length) {
      showError('Nothing to download yet.');
      return;
    }

    const meta = (current && current.config) || readConfig();
    // What was decided about each lead rides along.
    const allNotes = await store.getNotes(all.map((r) => r.key)).catch(() => notes);
    const { content, mime, filename, count } = await buildFile(all, ui.format.value, meta, {
      notes: allNotes,
      linked: links.personToBusiness,
      people: links.businessToPeople,
      isSuppressed,
    });
    if (ui.format.value === 'sequencer' && !count) {
      showError(
        'No lead here has an email a cold-email tool can send to. Leads without an address, ' +
          'on the do-not-contact list, judged not a fit or closed are left out of this file.'
      );
      return;
    }

    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    // Confirm it happened; a dialog that closes with no trace reads as a failure to anyone who was not watching the.
    ui.rowNote.textContent = `Saved ${filename}`;
  } catch (err) {
    showError(String((err && err.message) || err));
  } finally {
    ui.download.disabled = false;
    ui.download.textContent = label;
  }
});

/* ------------------------------------------------------------ the judge */

// Judge the leads against what the user says a good one is.
let judging = false;
let stopJudging = false;

function aiCredentials() {
  const provider = ui.aiProvider.value;
  return {
    provider,
    apiKey: (ai.keys[provider] || ui.aiKey.value || '').trim(),
    model: (ai.models[provider] || '').trim(),
  };
}

function applyJudgeState() {
  const { apiKey } = aiCredentials();
  ui.judgeRun.textContent = judging ? 'Stop' : 'Judge leads';
  ui.judgeRun.disabled = !judging && !apiKey;
  if (!apiKey && !judging) {
    ui.judgeStatus.textContent = 'Needs the free Gemini or Groq key — add it under More options on the Search tab.';
  }
}

ui.judgeBrief.addEventListener('input', () => {
  clearTimeout(ui.judgeBrief._t);
  ui.judgeBrief._t = setTimeout(
    () => chrome.storage.local.set({ [JUDGE_BRIEF_KEY]: ui.judgeBrief.value }),
    300
  );
});

ui.judgeRun.addEventListener('click', async () => {
  if (judging) {
    stopJudging = true;
    ui.judgeStatus.textContent = 'Stopping after this batch…';
    return;
  }
  const brief = ui.judgeBrief.value.trim();
  if (!brief) {
    ui.judgeStatus.textContent = 'Say what a good lead looks like first — one or two sentences is enough.';
    ui.judgeBrief.focus();
    return;
  }
  const targets =
    ui.judgeScope.value === 'shown'
      ? visibleRows
      : visibleRows.filter((r) => !(notes.get(r.key) || {}).verdict);
  if (!targets.length) {
    ui.judgeStatus.textContent = 'Every lead shown has been judged already. Pick “Everything shown” to judge again.';
    return;
  }

  // Every mark the user ever made, not only this run's.
  const everyNote = await store.getAllNotes().catch(() => notes);

  judging = true;
  stopJudging = false;
  applyJudgeState();
  const counts = { fit: 0, maybe: 0, no_fit: 0 };
  ui.judgeStatus.textContent = `Judging ${targets.length} leads…`;
  try {
    await judgeLeads({
      records: targets,
      brief,
      notes: everyNote,
      allRecords: library.length ? library : rows,
      ...aiCredentials(),
      shouldStop: () => stopJudging,
      onBatch: async (patches, { done, total }) => {
        await store.putNotes(patches);
        for (const patch of patches) {
          notes.set(patch.key, { ...(notes.get(patch.key) || {}), ...patch });
          counts[patch.verdict] += 1;
        }
        ui.judgeStatus.textContent =
          `${done} of ${total} read — ${counts.fit} fit, ${counts.maybe} maybe, ${counts.no_fit} not a fit.`;
        applyFilter();
      },
    });
    ui.judgeStatus.textContent =
      `${stopJudging ? 'Stopped' : 'Done'} — ${counts.fit} fit, ${counts.maybe} maybe, ${counts.no_fit} not a fit. ` +
      'Disagree with one? Mark it 👍 or 👎 and judge again.';
  } catch (err) {
    ui.judgeStatus.textContent = `${err.message} Verdicts already given are kept.`;
  } finally {
    judging = false;
    applyJudgeState();
  }
});

/* ---------------------------------------------------- the email finder */

let finder = { provider: DEFAULT_FINDER, keys: {}, max: 10, maybe: false };
let finding = false;
let stopFinding = false;
/** Spending money takes two presses: the first says how much. */
let finderArmed = null;

async function restoreFinder() {
  const stored = (await chrome.storage.local.get(FINDER_KEY))[FINDER_KEY] || {};
  finder = { ...finder, ...stored, keys: { ...(stored.keys || {}) } };
  ui.finderProvider.value = FINDERS[finder.provider] ? finder.provider : DEFAULT_FINDER;
  ui.finderKey.value = finder.keys[ui.finderProvider.value] || '';
  ui.finderMax.value = String(finder.max || 10);
  ui.finderMaybe.checked = Boolean(finder.maybe);
  applyFinderHelp();
}

function saveFinder() {
  finder.provider = ui.finderProvider.value;
  finder.keys[finder.provider] = ui.finderKey.value.trim();
  finder.max = Math.max(1, Math.min(500, Number(ui.finderMax.value) || 10));
  finder.maybe = ui.finderMaybe.checked;
  finderArmed = null;
  return chrome.storage.local.set({ [FINDER_KEY]: finder });
}

function applyFinderHelp() {
  const conf = FINDERS[ui.finderProvider.value] || FINDERS[DEFAULT_FINDER];
  ui.finderHelp.textContent =
    `${conf.label}: ${conf.costNote}. Only people judged a fit (or maybe, if ticked) with a LinkedIn ` +
    'profile and no email yet are looked up, and only their profile link is sent. The key stays in this browser.';
}

/** People and posts only: a business already has its website's address. */
function applyFinderBox() {
  const people = rows.some((r) => r.source === 'linkedin' || r.source === 'web' || r.source === 'posts');
  ui.finderBox.hidden = !people;
}

ui.finderProvider.addEventListener('change', () => {
  ui.finderKey.value = finder.keys[ui.finderProvider.value] || '';
  applyFinderHelp();
  saveFinder();
});
for (const field of [ui.finderKey, ui.finderMax, ui.finderMaybe]) field.addEventListener('change', saveFinder);

ui.finderRun.addEventListener('click', async () => {
  if (finding) {
    stopFinding = true;
    ui.finderStatus.textContent = 'Stopping after this one…';
    return;
  }
  await saveFinder();
  const apiKey = ui.finderKey.value.trim();
  if (!apiKey) {
    ui.finderStatus.textContent = 'Add the email finder API key first.';
    ui.finderKey.focus();
    return;
  }
  const targets = lookupTargets(visibleRows, notes, {
    include: finder.maybe ? ['fit', 'maybe'] : ['fit'],
    limit: finder.max,
    isSuppressed,
  });
  if (!targets.length) {
    ui.finderStatus.textContent =
      'Nobody here to look up: judge the leads first, or tick “maybe”. People who already have an email, ' +
      'were looked up before, or are on the do-not-contact list are skipped.';
    return;
  }
  const signature = targets.map((r) => r.key).join('|');
  if (finderArmed !== signature) {
    finderArmed = signature;
    ui.finderRun.textContent = `Yes, look up ${targets.length}`;
    ui.finderStatus.textContent =
      `${targets.length} ${targets.length === 1 ? 'person' : 'people'} — up to ${targets.length} credits. Press again to go ahead.`;
    return;
  }

  finderArmed = null;
  finding = true;
  stopFinding = false;
  ui.finderRun.textContent = 'Stop';
  let found = 0;
  try {
    await findEmails({
      records: targets,
      finder: finder.provider,
      apiKey,
      shouldStop: () => stopFinding,
      onEach: async (patch, { done, total, found: hit }) => {
        await store.putNotes([patch]);
        notes.set(patch.key, { ...(notes.get(patch.key) || {}), ...patch });
        if (hit) found += 1;
        ui.finderStatus.textContent = `${done} of ${total} looked up — ${found} verified ${found === 1 ? 'email' : 'emails'}.`;
        drawWindow();
      },
    });
    ui.finderStatus.textContent = `Done — ${found} verified ${found === 1 ? 'email' : 'emails'} found.`;
  } catch (err) {
    // A bad key or an empty wallet stops every later lookup too.
    ui.finderStatus.textContent = `${err.message} ${found ? `${found} found before that are kept.` : ''}`;
  } finally {
    finding = false;
    ui.finderRun.textContent = 'Find work emails';
    applyFilter();
  }
});

/* --------------------------------------------------- do not contact */

ui.dncSave.addEventListener('click', async () => {
  const { entries, errors } = parseSuppressionText(ui.dncText.value);
  await store.setSuppression(entries);
  await loadSuppression();
  ui.dncStatus.textContent =
    `${entries.length} on the list.` + (errors.length ? ` Not understood: ${errors.slice(0, 2).join('; ')}` : '');
  applyFilter();
});

/* ----------------------------------------------------- automation */

// The schedule and the hand-off to PowPow.
let schedule = { ...DEFAULT_SCHEDULE };
let hook = { ...DEFAULT_HOOK };

async function restoreAutomation() {
  const stored = await chrome.storage.local.get([SCHEDULE_KEY, HOOK_KEY]);
  schedule = { ...DEFAULT_SCHEDULE, ...(stored[SCHEDULE_KEY] || {}) };
  hook = { ...DEFAULT_HOOK, ...(stored[HOOK_KEY] || {}) };
  ui.scheduleOn.checked = Boolean(schedule.enabled);
  ui.scheduleTime.value = schedule.time || DEFAULT_SCHEDULE.time;
  ui.scheduleDays.value = schedule.days === 'daily' ? 'daily' : 'weekdays';
  ui.powpowOn.checked = Boolean(hook.enabled);
  ui.powpowUrl.value = hook.url || DEFAULT_HOOK.url;
  ui.powpowToken.value = hook.token || '';
  ui.powpowChannel.value = hook.channel || 'last';
  ui.powpowTo.value = hook.to || '';
  ui.powpowWhen.value = hook.when === 'always' ? 'always' : 'scheduled';
  applyAutomation();
}

function applyAutomation() {
  ui.scheduleRow.hidden = !ui.scheduleOn.checked;
  ui.powpowBody.hidden = !ui.powpowOn.checked;
  ui.scheduleUpdate.hidden = !schedule.enabled || !schedule.config;
  const described = describeSchedule(schedule);
  const next = schedule.enabled ? nextRunAt(schedule) : null;
  ui.scheduleNote.textContent = described
    ? `${described}. Next: ${new Date(next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. ` +
      'Chrome has to be open; a missed time runs when it next starts.'
    : 'Chrome has to be open at that time; a missed time runs when Chrome next starts.';
}

async function saveSchedule(patch) {
  schedule = { ...schedule, ...patch, time: ui.scheduleTime.value || DEFAULT_SCHEDULE.time, days: ui.scheduleDays.value };
  await chrome.storage.local.set({ [SCHEDULE_KEY]: schedule });
  applyAutomation();
}

ui.scheduleOn.addEventListener('change', async () => {
  if (!ui.scheduleOn.checked) {
    await saveSchedule({ enabled: false });
    return;
  }
  const config = readConfig();
  const why = cannotSchedule(config);
  if (why) {
    ui.scheduleOn.checked = false;
    ui.scheduleNote.textContent = why;
    return;
  }
  // The search as it stands now is what runs.
  await saveSchedule({ enabled: true, config, since: Date.now(), lastRunAt: 0 });
});
for (const field of [ui.scheduleTime, ui.scheduleDays]) {
  field.addEventListener('change', () => {
    if (schedule.enabled) saveSchedule({});
  });
}
ui.scheduleUpdate.addEventListener('click', async () => {
  const config = readConfig();
  const why = cannotSchedule(config);
  if (why) {
    ui.scheduleNote.textContent = why;
    return;
  }
  await saveSchedule({ config });
  flash('Scheduled search updated');
});

function readHook() {
  return {
    ...hook,
    enabled: ui.powpowOn.checked,
    url: ui.powpowUrl.value.trim() || DEFAULT_HOOK.url,
    token: ui.powpowToken.value.trim(),
    channel: ui.powpowChannel.value,
    to: ui.powpowTo.value.trim(),
    when: ui.powpowWhen.value,
  };
}

async function saveHook() {
  hook = readHook();
  await chrome.storage.local.set({ [HOOK_KEY]: hook });
  applyAutomation();
}

for (const field of [ui.powpowOn, ui.powpowUrl, ui.powpowToken, ui.powpowChannel, ui.powpowTo, ui.powpowWhen]) {
  field.addEventListener('change', saveHook);
}

// These boxes sit inside the search form, where Enter means "start the run".
for (const field of [ui.powpowUrl, ui.powpowToken, ui.powpowTo, ui.scheduleTime]) {
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    field.dispatchEvent(new Event('change'));
  });
}

ui.powpowTest.addEventListener('click', async () => {
  await saveHook();
  if (!hook.token) {
    ui.powpowStatus.textContent = 'Add the hooks.token from the gateway config first.';
    return;
  }
  ui.powpowStatus.textContent = 'Sending…';
  const sent = await sendToPowPow(
    hook,
    'LeadMine test message. If this reached you, LeadMine can hand its leads to PowPow. ' +
      'Reply to the user with one short line confirming it works.'
  );
  ui.powpowStatus.textContent = sent.ok ? 'Sent — watch your chat for the reply.' : sent.error;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'JOB_UPDATE') render(msg.job);
});

/** Stamp the running version into the top bar. */
function showVersion() {
  const manifest =
    chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : null;
  ui.version.textContent = manifest ? `v${manifest.version}` : '';
}

(async function init() {
  showVersion();
  // Before the settings, which restore a country by its code.
  await fillCountries();
  await restoreUrns();
  await restoreSettings();
  // And after them: this is what reads the country file the saved code names.
  await applyCountry({ keepRegion: true });
  await restoreAi();
  await restoreFinder();
  await restoreAutomation();
  {
    const stored = await chrome.storage.local.get(JUDGE_BRIEF_KEY);
    // The planner's description is the natural first draft of what a good lead is.
    ui.judgeBrief.value = stored[JUDGE_BRIEF_KEY] || ui.aiBrief.value || '';
  }
  applyJudgeState();
  await loadSuppression().catch(() => {});
  applyFilterNote();
  const res = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
  render((res && res.job) || { status: 'idle', count: 0, tasksTotal: 0 });
  renderSeen((res && res.seen) || 0);
  renderBudget(res && res.budget);

  // The worker can sleep between broadcasts; a slow poll keeps the panel honest.
  setInterval(async () => {
    if (!current || current.status !== 'running') return;
    const latest = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
    if (latest && latest.job) render(latest.job);
    renderBudget(latest && latest.budget);
  }, 2000);
})();
