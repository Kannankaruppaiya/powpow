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
