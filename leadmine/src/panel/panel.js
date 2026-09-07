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
import { suggestionsFor, observedCategories } from '../lib/categories.js';
import { planSearches, listModels, planToBatch, providerFor, DEFAULT_PROVIDER } from '../lib/ai.js';
import { loadCountries, loadCountry, citiesFor, regionsFor, CITY_LIMIT } from '../lib/places.js';
import { URN_KEY, withSeed, lookup, labelsFor } from '../lib/urns.js';
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
    'form', 'statusPill', 'version', 'viewSetup', 'viewResults', 'paneSetup', 'paneResults', 'tabCount',
    'modeSingle', 'modeBatch', 'toggleBatch',
    'source', 'sourceGroup', 'sourceNote', 'coverageRow', 'coverage', 'coverageHint',
    'categoryLabel', 'cityLabel', 'limitLabel', 'limitHint', 'limitRow', 'limitSlot', 'advancedBody',
    'optEmails', 'optContact', 'optVerify', 'optDeep',
    'optCurrentTab', 'useCurrentTab', 'currentTabHint',
    'category', 'city', 'batch', 'grid', 'maxResults',
    'country', 'region', 'cityOptions', 'placeRow', 'placeHint', 'cityIgnored',
    'liFilters', 'optSplit', 'splitLocations',
    'geoInput', 'geoAdd', 'geoOptions', 'geoChips', 'geoHelp',
    'svcInput', 'svcAdd', 'svcOptions', 'svcChips',
    'categoryFilter', 'categoryFilterRow', 'categoryOptions', 'filterLabel', 'filterHint',
    'filterChip', 'filterChipText',
    'deep', 'fetchEmails', 'followContactPage', 'verifyEmails', 'skipSeen', 'seenNote',
    'start', 'resume', 'stop', 'again', 'goResults',
    'actionbar', 'barSearch', 'barResults', 'toast',
    'runView', 'spinner', 'runTitle', 'barFill', 'message', 'taskLine', 'recentBox', 'recentList',
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

/**
 * What each level actually costs.
 *
 * These three were three stacked cards, a hundred pixels each, for one setting
 * that has a good default — a third of the panel spent on a question most
 * people never answer. The names are a segmented control now, and the
 * consequence of whichever is chosen is spelled out under it, because "Deep"
 * on its own tells nobody it means an hour.
 */
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
/**
 * A finished job the user has pressed "New search" on.
 *
 * The job stays in the worker so its rows are still downloadable, but the
 * panel polls it every two seconds — so without this, the old run's error and
 * its zeroes were painted straight back over the form.
 */
let dismissedJobId = null;
/**
 * Whether the user has ever opened or closed the planner themselves.
 *
 * Until they have, its default follows the key: the planner cannot do anything
 * without one, and expanded-and-useless was the tallest thing in the panel.
 */
let assistChosen = false;
/**
 * The state the code last asked the planner to be in.
 *
 * `toggle` fires asynchronously and does not say who caused it, so opening or
 * closing the fold from code looked exactly like the user doing it — which
 * counted as a choice and froze the default on the first automatic close.
 */
let assistIntended = null;

function setAssistOpen(open) {
  assistIntended = open;
  ui.assist.open = open;
}

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
    // One LinkedIn search is the whole run, so "per search" read as a
    // per-page cap and made a limit of 100 look like it had been ignored.
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
  ui.limitHint.textContent = conf.limitHint;
  // A people search has no grid, so the slot the grid occupies asks the
  // question that does apply to it. For Maps the limit goes back where it
  // belongs: last in the disclosure, behind a setting that already works.
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
  // The country/state picker names places; LinkedIn's filter takes its own
  // ids. Two location controls on one form is one too many.
  const people = ui.source.value === 'linkedin';
  ui.liFilters.hidden = !people;
  ui.placeRow.hidden = people;
  applyFacets();
  // The detail pass only exists for Maps; a LinkedIn card already carries
  // everything, so offering the option would be a lie about what it does.
  ui.optDeep.hidden = !conf.grid;
  for (const node of [ui.optEmails, ui.optContact, ui.optVerify]) node.hidden = !conf.emails;
  ui.sourceNote.hidden = !conf.note;
  ui.sourceNote.textContent = conf.note;
  applyFilterNote();
}

/**
 * Say when a narrowing filter is active.
 *
 * It is saved between runs, so a term typed weeks ago silently narrows a
 * search planned today — a live run found 235 businesses and set aside every
 * one of them against a filter the user had forgotten was there. The form
 * never showed it, because an input holding a value looks like an input.
 *
 * A warning inside the form was the first fix, and it scrolled away with the
 * form. This rides in the action bar instead, beside the button it changes the
 * meaning of, and clicking it is how you get rid of it.
 */
function applyFilterNote() {
  const term = ui.categoryFilter.value.trim();
  const conf = SOURCE_UI[ui.source.value] || SOURCE_UI.maps;
  // The results view has its own bar, and the filter says nothing about rows
  // that were already collected.
  ui.filterChip.hidden = !term || !ui.paneResults.hidden;
  if (!term) return;
  ui.filterChipText.textContent = `Only ${conf.filterLabel.toLowerCase()} matches “${term}”`;
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

/*
 * Country → state → town, as an aid to filling one box.
 *
 * "Where?" was a text field, which is fine when you know the town and useless
 * when you are working a region you do not — you cannot browse a text field,
 * and a misremembered spelling is a run that finds nothing. So the two selects
 * narrow what the box offers, and the box itself is unchanged: whatever ends
 * up in it is what gets searched, and it can still be typed straight into.
 */

/** The country file for whatever is selected, or null for "Any country". */
let country = null;

async function fillCountries() {
  let list = [];
  try {
    list = await loadCountries();
  } catch {
    // The picker is an aid. Losing it leaves a text box, which is what this
    // was before it existed — so say nothing and let people type.
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

/**
 * The towns the box offers.
 *
 * Offered as the exact string that will be searched, because a list showing
 * one thing and filling in another is a list nobody can trust.
 */
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

/*
 * LinkedIn's own filters, which take ids rather than names.
 *
 * `geoUrn` wants 102713980, not "India". Those ids are LinkedIn's internal
 * numbers — undocumented and not derivable — so the only ones offered here are
 * the ones actually seen on a live page, either seeded or learned when the
 * user applied that filter by hand. Asked for a label nobody has ever applied,
 * this says so rather than guessing: a wrong id searches somewhere else and
 * hands back a spreadsheet of the wrong people that looks entirely correct.
 */

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

  // Say where the list comes from. Two entries on a fresh install looks like a
  // broken feature unless it is clear that browsing LinkedIn is what fills it.
  ui[ui_.help].textContent = labels.length
    ? `${labels.length} known. LeadMine learns these from LinkedIn — open its ` +
      'Locations filter, type a place, and every option it offers is remembered.'
    : 'None known yet. Open LinkedIn’s Locations filter, type a place and apply ' +
      'one — every option it showed you is remembered.';
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
        chosen[facet] = chosen[facet].filter((v) => v.id !== value.id);
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

/**
 * Add a value — asking LinkedIn for its id if we do not have one.
 *
 * A name is not enough: `geoUrn` wants 102784390, not "Chennai". Making the
 * user go and apply every filter by hand first is a chore, and it is one the
 * page can do itself — the filter panel's typeahead *is* LinkedIn's resolver,
 * so this drives it once and remembers the answer forever.
 *
 * What it will not do is guess. When LinkedIn does not offer the name, what it
 * does offer is shown and the choice stays with the user: a wrong id searches
 * somewhere else and hands back a spreadsheet that looks entirely right.
 */
async function addFacet(facet) {
  const ui_ = FACET_UI[facet];
  const typed = ui[ui_.input].value.trim();
  if (!typed) return;

  let id = lookup(urns, facet, typed);
  let label = typed;

  if (!id) {
    const button = ui[facet === 'geoUrn' ? 'geoAdd' : 'svcAdd'];
    button.disabled = true;
    setFacetHelp(facet, `Asking LinkedIn for “${typed}”…`);
    let answer = null;
    try {
      answer = await chrome.runtime.sendMessage({
        type: 'RESOLVE_FACET',
        want: { facet, label: typed },
      });
    } catch (err) {
      answer = { ok: false, reason: String((err && err.message) || err) };
    }
    button.disabled = false;

    if (!answer || !answer.ok) {
      const offered = (answer && answer.offered) || [];
      setFacetHelp(
        facet,
        `${(answer && answer.reason) || 'LinkedIn did not answer'}${
          offered.length ? `. It offers: ${offered.join(' · ')}` : ''
        }`
      );
      return;
    }

    // The worker stored it; take the table back with it in.
    const stored = await chrome.storage.local.get(URN_KEY);
    urns = withSeed(stored[URN_KEY]);
    id = answer.id;
    // LinkedIn's own wording, not what was typed: "chennai" comes back as
    // "Chennai, Tamil Nadu, India", and that is the thing being filtered on.
    label = answer.label || typed;
  }

  if (!chosen[facet].some((v) => v.id === id)) chosen[facet].push({ id, label });
  ui[ui_.input].value = '';
  fillFacetOptions(facet);
  renderChips(facet);
  applyFacets();
  saveSettings();
}

/** Show the split option only when there is something to split. */
function applyFacets() {
  // These are LinkedIn's filters. Left over from a people search, they must
  // not reach across and disable the Maps form.
  const people = ui.source.value === 'linkedin';
  const places = people ? chosen.geoUrn.length : 0;
  ui.optSplit.hidden = places < 2;
  // A real location filter makes the free-text place meaningless, and a box
  // that is silently ignored is a box people fill in and then distrust.
  ui.city.disabled = places > 0;
  ui.cityIgnored.hidden = !places;
}

for (const [facet, ui_] of Object.entries(FACET_UI)) {
  ui[`${facet === 'geoUrn' ? 'geo' : 'svc'}Add`].addEventListener('click', () => addFacet(facet));
  ui[ui_.input].addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // The form would otherwise take this as "start the run".
    event.preventDefault();
    addFacet(facet);
  });
}

/* ------------------------------------------------------------------- tabs */

function setView(showResults) {
  ui.paneSetup.hidden = showResults;
  ui.paneResults.hidden = !showResults;
  ui.viewSetup.classList.toggle('is-active', !showResults);
  ui.viewResults.classList.toggle('is-active', showResults);
  // The bar always carries the action of the view above it: Start on the
  // search side, Download on the results side, in the same place either way.
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
  // A first-ever open has nothing stored and still needs the source applied:
  // the labels, the hints and the coverage line are all derived, never markup.
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
  // Blank and zero mean the same thing to `readConfig`, and blank is the one
  // that reads as "no limit" rather than "a limit of nothing".
  ui.maxResults.value = s.maxResults || '';
  ui.deep.checked = s.deep !== false;
  ui.fetchEmails.checked = s.fetchEmails !== false;
  ui.followContactPage.checked = s.followContactPage !== false;
  ui.verifyEmails.checked = s.verifyEmails !== false;
  ui.skipSeen.checked = Boolean(s.skipSeen);
  ui.useCurrentTab.checked = Boolean(s.useCurrentTab);
  ui.categoryFilter.value = s.categoryFilter ?? '';
  // Someone who knows their own searches closes the planner once and should
  // never have to close it again.
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
    // Kept so the picker comes back where it was left. The run itself only
    // ever reads `city`, which is the box these two helped fill in.
    country: ui.country.value,
    region: ui.region.value,
    // LinkedIn's real filters: ids for the run, labels for the records and
    // for putting the form back the way it was.
    facets: Object.fromEntries(
      Object.entries(chosen).map(([facet, values]) => [facet, values.map((v) => v.id)])
    ),
    facetLabels: Object.fromEntries(
      Object.entries(chosen).map(([facet, values]) => [facet, values.map((v) => v.label)])
    ),
    splitLocations: ui.splitLocations.checked,
    // Only send the batch text when the batch tab is active, so a leftover
    // draft cannot hijack a single search.
    batch: batchMode ? ui.batch.value : '',
    batchMode,
    grid: ui.grid.value,
    assistOpen: ui.assist.open,
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

/*
 * Keys and models are kept per provider. One shared slot meant switching from
 * Gemini to Groq carried Gemini's model across with it, and the request failed
 * on a model the user had never chosen for that provider.
 */
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
  // An earlier build stored one key and one model, with no provider attached;
  // they belonged to whichever provider was selected at the time.
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

  // The picker starts as just the recommended model. The provider's real list
  // is fetched only when someone opens it, so an ordinary run costs one
  // request rather than two.
  const chosen = ai.models[conf.id] || '';
  setModelOptions(chosen ? [{ id: chosen, label: chosen }] : [], chosen);
  const open = Boolean(chosen);
  ui.aiModelRow.hidden = !open;
  ui.aiModelToggle.hidden = open;
  if (open) loadModels();
  applyKeyState();
}

/**
 * Fill the picker.
 *
 * The first option is always the provider's recommendation with an empty
 * value, so "I have not chosen" stays distinct from "I chose the one that
 * happens to be recommended today".
 */
function setModelOptions(models, selected) {
  const conf = providerFor(ui.aiProvider.value);
  const options = [{ id: '', label: `Recommended — ${conf.defaultModel}` }, ...models];
  // A model chosen earlier must stay selectable even if the list has not
  // arrived yet, or opening the picker would silently change the setting.
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
    // A slow answer for a provider the user has since switched away from must
    // not overwrite the picker.
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
  // No key means nothing here can run, so it starts folded — until the user
  // says otherwise, at which point their choice is the one that counts.
  if (!assistChosen) setAssistOpen(has);
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
  // Save the boxes as they stand before repainting them for the new provider,
  // or switching away would discard the key just typed.
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

/** Load this job's records from IndexedDB and redraw the table. */
async function refreshRows() {
  const jobId = current && current.jobId;
  const all = jobId ? await store.getRecords(jobId) : [];
  rows = all.filter((r) => !r.setAside);
  asideRows = all.filter((r) => r.setAside);
  // Nothing kept and something set aside is the filter being wrong, not the
  // scraper finding nothing — so show the rows rather than an empty table.
  if (!rows.length && asideRows.length) showAside = true;
  refreshCategoryOptions();
  applyFilter();
}

/**
 * What the filter set aside, and what it could have matched.
 *
 * "0 businesses" reads as "the scraper found nothing", which sends people to
 * debug the wrong thing. Naming the filter and listing the categories that
 * were actually there turns it into a one-click fix.
 */
function renderAside() {
  ui.asideNote.hidden = !asideRows.length;
  if (!asideRows.length) return;

  const conf = SOURCE_UI[(current && current.config && current.config.source)] || SOURCE_UI.maps;
  const term = asideRows[0].setAside;
  const found = observedCategories(asideRows, conf.filterField).slice(0, 4);

  ui.asideText.textContent =
    `${asideRows.length.toLocaleString()} set aside by ${conf.filterLabel.toLowerCase()} “${term}”` +
    (rows.length ? '. ' : ` — nothing else matched. What was found: ${found.join(', ')}. `);
  ui.asideToggle.textContent = showAside ? 'Hide them' : 'Show them';
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

function applyFilter() {
  const needle = ui.filter.value.trim().toLowerCase();
  // What is on screen is what Download writes — no hidden discrepancy.
  const source = showAside ? [...rows, ...asideRows] : rows;
  visibleRows = !needle
    ? source
    : source.filter((r) =>
        [r.name, r.area, r.category, r.city, r.email, r.phone]
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

/**
 * One lead, three lines.
 *
 * This was a six-column table. In a 400px panel that is about 55px a column,
 * so every name, phone, email and area on screen ended after three characters
 * and an ellipsis — a table you had to download before you could read it.
 * Reading down instead of across fits all of it.
 */
function leadCard(record) {
  const card = document.createElement('div');
  card.className = 'lead';
  const lines =
    record.source === 'linkedin'
      ? [
          [
            'lead-1',
            [
              // A person's profile link is the thing you actually go and do
              // something with, the way a phone number is for a business.
              record.profileUrl
                ? copyable(record.profileUrl, 'lead-name', record.name)
                : text('lead-name', record.name),
              text('lead-mark', record.degree),
            ],
          ],
          ['lead-2', [text('lead-sub lead-headline', record.headline)]],
          [
            'lead-3',
            [
              text('lead-sub lead-area', [record.company, record.location].filter(Boolean).join(' · ')),
              text('lead-tag', record.openToWork ? 'open to work' : ''),
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
            ],
          ],
          ['lead-3', [emailCell(record), text('lead-tag', record.category)]],
        ];

  for (const [cls, kids] of lines) {
    const row = document.createElement('div');
    row.className = `lead-line ${cls}`;
    row.append(...kids.filter(Boolean));
    card.appendChild(row);
  }
  return card;
}

function text(cls, value) {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = value || '';
  if (value) span.title = value;
  return span;
}

/**
 * A value you are going to paste somewhere else, rendered as the button that
 * puts it there. Reading a phone number off the screen and typing it back in
 * is the slowest thing this tool used to ask of anyone.
 */
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
  // Verification says this one will bounce. Struck through rather than hidden:
  // a wrong address is still a lead someone may want to fix by hand.
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

/**
 * Render only the cards on screen.
 *
 * A 20,000-lead list with every one of them in the DOM makes the panel
 * unusable; this keeps roughly a screenful alive and shifts the block as the
 * user scrolls.
 */
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

ui.rowBody.addEventListener('click', async (event) => {
  const target = event.target.closest('.copy');
  if (!target) return;
  try {
    await navigator.clipboard.writeText(target.dataset.copy);
    flash('Copied');
  } catch {
    flash('Could not copy');
  }
});

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
  const previousStatus = current ? current.status : null;
  current = job;

  const running = job.status === 'running';
  const settled = ['done', 'error', 'cancelled', 'paused'].includes(job.status);

  // The form and the run never share the screen: while a scrape is going,
  // the settings that started it are not what the user needs to look at.
  // "Done with this run": either the user said so, or the extension restarted
  // and the run finished before that.
  const dismissed = !running && job.jobId && (job.stale || job.jobId === dismissedJobId);
  const showRun = !dismissed && (running || (settled && job.status !== 'idle' && job.tasksTotal > 0));

  // The chip reports the run on screen, so a run that is no longer on screen
  // has no status to report. A restart left "Done" in the header of a panel
  // showing an empty form, which reads as this search having finished.
  ui.statusPill.hidden = dismissed || job.status === 'idle';
  ui.statusPill.textContent = PILL[job.status] || job.status;
  ui.statusPill.dataset.state = job.status;
  ui.form.hidden = showRun;
  ui.runView.hidden = !showRun;

  // The bar answers one question — what do I do now? — so only the answers
  // that apply are in it. Start belongs to the form; the rest belong to a run.
  ui.start.hidden = showRun || job.canResume;
  ui.resume.hidden = !job.canResume;
  ui.stop.hidden = !running;
  ui.again.hidden = !showRun || running;
  ui.goResults.hidden = !showRun || running || !job.count;
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
    const term = job.task && [job.task.term, job.task.city].filter(Boolean).join(', ');
    ui.taskLine.textContent =
      `Search ${Math.min(job.tasksSettled + (running ? 1 : 0), job.tasksTotal)} of ${job.tasksTotal}` +
      (running && term ? ` · ${term}` : '') +
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
  if (job.count !== previousCount || job.status !== previousStatus) void refreshRecent(job);
  // A run can finish with nothing to show; the reason is the useful part —
  // until the user has moved on from it.
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

  // A finished run exists for the rows it produced, and reaching them meant
  // noticing a tab and clicking it. Hand the user over once, on the edge.
  if (job.status === 'done' && previousStatus === 'running' && job.count) setView(true);
}

/**
 * The last few names to arrive.
 *
 * Twenty-five minutes of a spinner and four numbers is indistinguishable from
 * a hang. A name you recognise landing every few seconds is the proof, and it
 * fills the screen this run had left empty.
 */
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

  // Only what is actually new animates; re-fading the whole list on every
  // poll would read as a redraw rather than as an arrival.
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

/*
 * Keep whatever is in the form.
 *
 * Only the source, the filter and the format were being saved as they were
 * edited; everything else — the search, the city, how many profiles, the
 * checkboxes — was written only when Start was pressed. The panel closes
 * whenever the user clicks into the tab a run is driving, and a form that
 * forgets what you typed the moment you look away is its own bug.
 *
 * Delegated, so a field added later is covered without being wired up, and on
 * `input` rather than `change` so it does not wait for a blur that may never
 * come. Debounced, because otherwise this writes on every keystroke.
 *
 * The planner's key and brief are inside this form and are deliberately not in
 * `readConfig()`, so they cannot reach these settings.
 */
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
    // Set-aside rows are included only when they are on screen, so the file
    // is always what the table showed.
    const stored = current && current.jobId ? await store.getRecords(current.jobId) : [];
    const all = showAside ? stored : stored.filter((r) => !r.setAside);
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

/**
 * Stamp the running version into the masthead.
 *
 * Reloading an unpacked extension gives no feedback inside the panel, so
 * "did the reload land?" meant opening chrome://extensions to check. Reading
 * it from the manifest means it cannot drift from what is actually loaded.
 */
function showVersion() {
  const manifest =
    chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : null;
  ui.version.textContent = manifest ? `v${manifest.version}` : '';
}

(async function init() {
  showVersion();
  // Before the settings, which restore a country by its code — an <option>
  // that does not exist yet cannot be selected.
  await fillCountries();
  await restoreUrns();
  await restoreSettings();
  // And after them: this is what reads the country file the saved code names.
  await applyCountry({ keepRegion: true });
  await restoreAi();
  applyFilterNote();
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
