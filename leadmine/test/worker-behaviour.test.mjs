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
  assert.ok(switchBlock.includes('RESOLVE_FACET'), 'the block being scanned is the right one');

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

test('asking LinkedIn for an id uses any open search tab, not just the active one', () => {
  // Insisting on the active tab told a user with two LinkedIn tabs open to go
  // and open one: the side panel sits beside whatever they are looking at,
  // which was a Google new tab at the time.
  const finder = WORKER.slice(
    WORKER.indexOf('async function findSearchTab'),
    WORKER.indexOf('async function resolveFacet')
  );
  assert.match(finder, /linkedin\.com\/search\/results/, 'it queries for search tabs by URL');
  assert.match(finder, /tab\.active/, 'though it prefers the active one when there is a choice');
  assert.ok(finder.includes('all[0]'), 'and settles for any of them rather than refusing');
  // WINDOW_ID_CURRENT is a sentinel (-2), never a real windowId, so comparing
  // a tab's against it never matches. The current window has to be asked for.
  assert.ok(!finder.includes('WINDOW_ID_CURRENT'), 'the current window is looked up, not assumed');

  const block = WORKER.slice(
    WORKER.indexOf('async function resolveFacet'),
    WORKER.indexOf('async function rememberUrns')
  );
  assert.match(block, /No LinkedIn people search is open/i, 'and says what to do when there is none');
  // Whatever it learns is kept, or the next run asks all over again.
  assert.ok(block.includes('rememberUrns'), 'a resolved id is stored');
});
