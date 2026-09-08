/**
 * Behaviours of the run loop that are cheaper to assert against the source
 * than to drive through a whole browser run.
 *
 * Both of these are things a live run got wrong, and both are the kind of
 * regression a refactor reintroduces quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = readFileSync(join(ROOT, 'src/background/service-worker.js'), 'utf8');

test('rows the category filter sets aside are marked, never deleted', () => {
  // A live run found 235 businesses, set every one aside, and deleted them —
  // so the panel showed "0 businesses" and the only way back was to re-run
  // ten searches. The filter narrows the view; it must not destroy the work.
  const block = WORKER.slice(WORKER.indexOf('filterByCategory(records'), WORKER.indexOf('config.skipSeen'));
  assert.ok(block.includes('putRecords'), 'set-aside rows are written back with a marker');
  assert.ok(!block.includes('deleteRecords'), 'and are not deleted');
  assert.ok(block.includes('setAside'), 'the marker is what the panel filters on');
});

test('a filter that keeps nothing says so, and says the rows are still there', () => {
  const block = WORKER.slice(WORKER.indexOf('filterByCategory(records'), WORKER.indexOf('config.skipSeen'));
  assert.match(block, /kept\.length\s*\?/, 'the message differs when nothing survived');
  assert.match(block, /open Results to see them/i);
});

test('a tab-lifecycle failure is retried rather than losing the search', async () => {
  // "The page keeping the extension port is moved into back/forward cache"
  // is Chrome's messaging layer reporting that the tab moved. The scrape was
  // not wrong, and losing one search in ten to it is a bad trade.
  const { isTransient } = await loadTransient();

  assert.equal(isTransient('The page keeping the extension port is moved into back/forward cache, so the message channel is closed.'), true);
  assert.equal(isTransient('Could not establish connection. Receiving end does not exist.'), true);
  assert.equal(isTransient('The message port closed before a response was received.'), true);
  assert.equal(isTransient('No tab with id: 42.'), true);

  // A real scrape failure must still fail, or a broken selector retries forever.
  assert.equal(isTransient('You are signed out of LinkedIn.'), false);
  assert.equal(isTransient('Could not find the results on this LinkedIn page.'), false);
  assert.equal(isTransient(''), false);
});

test('the retry is bounded, so a persistent fault still ends the task', () => {
  assert.match(WORKER, /task\.attempts\s*<\s*3/, 'a retry loop needs a ceiling');
  assert.match(WORKER, /isTransient\(message\)/);
});

/** Pull the helper out of the worker without running the extension APIs. */
async function loadTransient() {
  const start = WORKER.indexOf('function isTransient');
  const end = WORKER.indexOf('\n}', start) + 2;
  const module = await import(
    `data:text/javascript,${encodeURIComponent(`export ${WORKER.slice(start, end)}`)}`
  );
  return module;
}

test('a run that finished before a restart no longer owns the screen', () => {
  // Every extension reload was painting a dead run's error back over the
  // form, which reads as "the reload did nothing" — three reloads in a row.
  const block = WORKER.slice(WORKER.indexOf('async function loadJob'), WORKER.indexOf('const ready'));
  assert.match(block, /\['done', 'error', 'cancelled'\]\.includes\(job\.status\)/);
  assert.match(block, /job\.stale = true/);

  // A paused run is unfinished and Resume lives in the run view, so it keeps
  // the screen. Marking it stale would strand it.
  assert.ok(!/paused/.test(block.slice(block.indexOf('job.stale = true') - 120, block.indexOf('job.stale = true'))),
    'paused must not be in the stale list');
});

test('a new run clears the stale flag rather than inheriting it', () => {
  assert.match(WORKER, /stale: false/, 'DEFAULT_JOB carries it, so every reset clears it');
  const start = WORKER.slice(WORKER.indexOf('async function startJob'), WORKER.indexOf('async function startJob') + 900);
  assert.match(start, /\.\.\.DEFAULT_JOB/, 'a new job starts from the defaults');
});

test('every handler the message switch calls actually exists', () => {
  // A live panel answered "Uncaught ReferenceError: resolveFacet is not
  // defined". The route had been added to the switch and the function it calls
  // had not — the edit that was supposed to add it failed silently. Nothing
  // caught it, because the panel's tests stub sendMessage and never reach the
  // worker at all.
  const switchBlock = WORKER.slice(
    WORKER.indexOf('switch (msg.type) {'),
    WORKER.indexOf('/* ------', WORKER.indexOf('switch (msg.type) {'))
  );
  assert.ok(switchBlock.includes('START_JOB'), 'the block being scanned is the right one');

  // Bare calls only: a method on an imported namespace (store.countSeen) is
  // that module's business, not this one's.
  const called = new Set(
    [...switchBlock.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1])
  );
  // Keywords and things the platform provides, not this module.
  const builtin = new Set([
    'async', 'await', 'if', 'for', 'while', 'switch', 'catch', 'return',
    'typeof', 'new', 'do', 'else',
    'sendResponse', 'reply', 'respond', 'then', 'String', 'Number', 'Boolean',
    'Promise', 'slice', 'map', 'filter', 'push', 'join',
  ]);

  for (const name of called) {
    if (builtin.has(name)) continue;
    const declared = new RegExp(
      `(async\\s+)?function\\s+${name}\\b|(const|let|var)\\s+${name}\\s*=|import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`
    );
    assert.ok(declared.test(WORKER), `the switch calls ${name}(), which is never declared`);
  }
});

test('a filter LinkedIn has to apply is applied before anything is scraped', () => {
  // A facet takes LinkedIn's own id, and those are undocumented — so a place
  // nobody has looked up cannot go in a URL. It can go in LinkedIn's filter
  // panel, and the run drives that before it reads a single card.
  const block = WORKER.slice(
    WORKER.indexOf('if (task.applyFilters'),
    WORKER.indexOf('if (cancelRequested) throw', WORKER.indexOf('if (task.applyFilters'))
  );
  assert.ok(block.includes('APPLY_FILTERS'), 'the page is asked to apply them');
  assert.match(block, /throw new Error/, 'and a filter that will not apply fails the task');
  assert.ok(block.includes('rememberUrns'), 'whatever it learned on the way is kept');

  // Order matters: applying rebuilds the results list, so scraping the page
  // before it lands would read the unfiltered one.
  assert.ok(
    WORKER.indexOf('APPLY_FILTERS') < WORKER.indexOf("type: 'RUN_SCRAPE'"),
    'filters are applied before the scrape, not after'
  );
});

test('every page LinkedIn is asked for is counted against the allowance', () => {
  // A month's allowance went in eight days with nothing counting it, and the
  // run read as broken rather than out of budget. Every navigation to a
  // people-search URL has to increment, including the ones a filter causes.
  assert.ok(
    WORKER.indexOf('countSearchPage') !== -1,
    'nothing counts what this extension asks LinkedIn for'
  );
  // The first page of a task.
  const firstNav = WORKER.slice(WORKER.indexOf('await chrome.tabs.update(tabId, { url,'), WORKER.indexOf('applyFilters && task.applyFilters.length'));
  assert.match(firstNav, /countSearchPage/, 'the first page of a task is not counted');
  // Every page after it.
  assert.match(WORKER.slice(WORKER.indexOf('async function pageThrough')), /countSearchPage/, 'later pages are not counted');
  // And "Show results" on a driven filter, which makes LinkedIn search again.
  const filters = WORKER.slice(WORKER.indexOf('rememberUrns(applied.applied)'), WORKER.indexOf('The results list rebuilds'));
  assert.match(filters, /countSearchPage/, 'a filter LinkedIn applies for us runs a search that goes uncounted');
});

test('the allowance resets with the calendar month, the way LinkedIn’s does', () => {
  const block = WORKER.slice(WORKER.indexOf('async function countSearchPage'), WORKER.indexOf('async function readBudget'));
  // Carrying last month's total forward would refuse runs the allowance
  // actually permits — the opposite failure, and just as wrong.
  assert.match(block, /stored\.month === month/, 'a new month must start from zero');
  assert.match(block, /stored\.day === day/, 'and so must a new day');
});

test('LinkedIn pages by URL, and the worker is what turns the page', () => {
  // Proved in LinkedIn's own Network panel: turning a page fires one
  // `document` request for "…&page=N" and no XHR. A navigation destroys the
  // content script, so the harvest loop cannot own paging.
  assert.match(WORKER, /pagesByUrl/, 'nothing marks the sources that page by URL');
  assert.match(WORKER, /pageUrl\(base, page\)/, 'the next page is not built from the URL');
  const paging = WORKER.slice(WORKER.indexOf('async function pageThrough'));
  assert.match(paging, /singlePage: true/, 'each page must be scraped on its own');
  assert.match(paging, /repeated what page/, 'a repeated page is the end, and must say so');
});

test('paging starts from where the tab actually is, not from where it was sent', () => {
  // Applying a filter makes LinkedIn rewrite the URL. Paging the URL we asked
  // for would drop the filters that had just been applied, and hand back the
  // right number of the wrong people with nothing erroring.
  assert.match(WORKER, /task\.currentUrl = live\.url/, 'the live URL is never read');
  const paging = WORKER.slice(WORKER.indexOf('async function pageThrough'));
  assert.match(paging, /task\.currentUrl \|\| task\.url/, 'paging ignores the live URL');
});
