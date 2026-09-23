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
  // The first page of a task, between the navigation and the filter step.
  const navigate = WORKER.indexOf('await chrome.tabs.update(tabId, { url,');
  const firstNav = WORKER.slice(navigate, WORKER.indexOf('if (task.applyFilters && task.applyFilters.length)'));
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

test('a run stops at the budget rather than discovering the wall', () => {
  // Paging by URL made reaching all 100 pages reliable for the first time,
  // which is exactly the danger: at 100 pages a run, three runs spend a
  // month. The previous version only avoided that by failing to find its own
  // Next button.
  const paging = WORKER.slice(WORKER.indexOf('async function pageThrough'));
  assert.match(paging, /config\.maxPages \|\| 10\b/, 'the default depth is not bounded to something sane');
  assert.match(paging, /budgetLeft/, 'paging never checks what is left');

  // And before the first page, where it can stop the whole run.
  const first = WORKER.slice(WORKER.indexOf('const url = task.url || buildUrl'), WORKER.indexOf('waitForTabComplete(tabId, source.urlPart)'));
  assert.match(first, /budgetLeft/, 'a run can start with nothing left to spend');
  assert.match(first, /throw new Error/, 'and it starts anyway rather than saying why');
});

test('the budget ceiling is a default to stop at, not a fact', () => {
  // LinkedIn does not publish the number and does not hold it fixed — it is
  // decided from behaviour. Hard-coding it with no way out would refuse runs
  // an account actually permits.
  const block = WORKER.slice(WORKER.indexOf('const MONTHLY_ALLOWANCE'), WORKER.indexOf('async function countSearchPage'));
  assert.match(block, /config\.searchBudget/, 'the ceiling cannot be raised by the user');
  assert.match(block, /cap - inMonth/, 'what is left is not computed from what was spent');
});

test('the wait between pages is a range, not a number', () => {
  // Everything else about a run already looks like a person: the user's own
  // Chrome, their own address, their own session. The clock was the one thing
  // that did not — ten pages at a fixed 1200ms is twenty seconds of perfectly
  // even spacing, and evenness is the signal.
  const block = WORKER.slice(WORKER.indexOf('function pageDelay'), WORKER.indexOf('const wait ='));
  assert.match(block, /Math\.random\(\)/, 'the delay is still a constant');
  assert.match(block, /pagesSoFar/, 'the delay does not change as the run goes on');

  const paging = WORKER.slice(WORKER.indexOf('async function pageThrough'));
  assert.match(paging, /wait\(pageDelay\(/, 'paging does not use it');
  assert.ok(!/setTimeout\(r, 1200\)/.test(paging), 'the fixed wait is still there');
});

test('the cache is consulted before the tab moves, not after', () => {
  // Consulted inside the paging loop, the first navigation and its count had
  // already happened — so a "free" repeat still spent a search while the
  // panel said none were spent. Order is the whole of this fix, and order is
  // what a source assertion can actually check.
  const check = WORKER.indexOf('const hit = await servedFromCache(');
  const navigate = WORKER.indexOf('await chrome.tabs.update(tabId, { url,');
  assert.ok(check > 0, 'nothing consults the cache in runTask');
  assert.ok(check < navigate, 'the cache is read after the tab has already been sent somewhere');
});

test('a page is recorded only once it has been read', () => {
  // Recorded at navigation time, a failed scrape or a cancel would mark a
  // page whose people were never collected, and the next run would skip it
  // for good. The semantics live in search-cache.js and are tested there;
  // what this checks is that the worker calls it in the right place.
  const paging = WORKER.slice(WORKER.indexOf('async function pageThrough'));
  const guard = paging.indexOf('if (!next || !next.ok)');
  const record = paging.indexOf('entry = absorb(entry, page,');
  assert.ok(guard > 0 && record > 0, 'the page is never recorded');
  assert.ok(record > guard, 'a page is recorded before the scrape is known to have worked');
});

test('the cache is only rewritten when a page was actually fetched', () => {
  // Rewriting the timestamp every time it is asked for would make a week-old
  // answer immortal, which is the failure mode of every cache written in a
  // hurry. Comparing depths could not tell: `reused` is clamped to the
  // requested depth and the stored depth is not, so asking for fewer pages
  // than are held looked like a fetch.
  const paging = WORKER.slice(WORKER.indexOf('async function pageThrough'));
  assert.match(paging, /if \(key && fetchedAny\)/, 'the entry is rewritten even when nothing was fetched');
  assert.match(paging, /fetchedAny = true;/, 'nothing ever records that a page was paid for');
});

test('everything used in the paging loop is declared before it is used', () => {
  // `absorb(entry, …)` sat ten lines above `let entry`, so every multi-page
  // run threw a ReferenceError after paying for page one — and the source
  // assertions above all still passed. Order is checkable; this checks it.
  const paging = WORKER.slice(WORKER.indexOf('async function pageThrough'));
  for (const name of ['entry', 'key', 'plan', 'fetchedAny']) {
    const declared = paging.search(new RegExp(`(?:const|let) ${name}\\b`));
    const used = paging.search(new RegExp(`[^.\\w$]${name}\\b(?! *=[^=])`));
    assert.ok(declared > 0, `${name} is never declared`);
    assert.ok(declared < used || used === -1, `${name} is used before it is declared`);
  }
});

test('a cached answer is deduplicated the way a live one is', () => {
  // LinkedIn repeats people across pages and a live run merges them. Handing
  // back the raw concatenation gave a cached answer fewer unique people than
  // the search that produced it, and reported the inflated number.
  const cached = WORKER.slice(WORKER.indexOf('async function servedFromCache'), WORKER.indexOf('async function pageThrough'));
  assert.match(cached, /recordKey\(record\)/, 'a cache hit hands back duplicates');
  assert.ok(!/task\.stoppedBecause/.test(cached), 'a run answered in full from disk reads as one that stopped early');
});
