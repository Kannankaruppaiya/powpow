import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBatch,
  searchesFromConfig,
  buildTaskList,
  expandGridTasks,
  insertAfter,
  nextPending,
  taskProgress,
  facetSearches,
} from '../src/lib/tasks.js';

test('parseBatch reads both separators people type', () => {
  assert.deepEqual(parseBatch('dentists, Chennai\ngyms in Coimbatore'), [
    { category: 'dentists', city: 'Chennai', term: 'dentists in Chennai' },
    { category: 'gyms', city: 'Coimbatore', term: 'gyms in Coimbatore' },
  ]);
});

test('parseBatch keeps a multi-part city intact', () => {
  assert.deepEqual(parseBatch('cafes, Austin, TX'), [
    { category: 'cafes', city: 'Austin, TX', term: 'cafes in Austin, TX' },
  ]);
});

test('parseBatch skips blanks and comments', () => {
  assert.equal(parseBatch('\n# a note\n\ndentists, Chennai\n   \n').length, 1);
});

test('parseBatch accepts a line with no city', () => {
  assert.deepEqual(parseBatch('dental labs'), [
    { category: 'dental labs', city: '', term: 'dental labs' },
  ]);
});

test('parseBatch handles empty input', () => {
  assert.deepEqual(parseBatch(''), []);
  assert.deepEqual(parseBatch(null), []);
});

test('searchesFromConfig prefers the batch box over the single pair', () => {
  const out = searchesFromConfig({ category: 'ignored', city: 'Nowhere', batch: 'gyms, Madurai' });
  assert.deepEqual(out, [{ category: 'gyms', city: 'Madurai', term: 'gyms in Madurai' }]);
});

test('searchesFromConfig falls back to the single pair', () => {
  assert.deepEqual(searchesFromConfig({ category: 'dentists', city: 'Chennai', batch: '  ' }), [
    { category: 'dentists', city: 'Chennai', term: 'dentists in Chennai' },
  ]);
});

test('searchesFromConfig returns nothing when there is nothing to search', () => {
  assert.deepEqual(searchesFromConfig({}), []);
});

test('buildTaskList makes one locate task per search', () => {
  const tasks = buildTaskList({ batch: 'dentists, Chennai\ngyms, Chennai', grid: 'balanced' });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].point, null, 'a locate task has no map point yet');
  assert.equal(tasks[0].expandsToGrid, true);
  assert.equal(tasks[0].status, 'pending');
});

test('buildTaskList marks tasks as terminal when gridding is off', () => {
  const [task] = buildTaskList({ category: 'dentists', city: 'Chennai', grid: 'off' });
  assert.equal(task.expandsToGrid, false);
});

test('expandGridTasks turns a located search into steps² tasks', () => {
  const [task] = buildTaskList({ category: 'dentists', city: 'Chennai', grid: 'balanced' });
  const grid = expandGridTasks(task, { lat: 13.0827, lng: 80.2707, zoom: 12 }, { grid: 'balanced' });

  assert.equal(grid.length, 9);
  assert.ok(grid.every((t) => t.point && t.status === 'pending'));
  assert.ok(grid.every((t) => t.term === 'dentists in Chennai'));
  assert.equal(new Set(grid.map((t) => t.id)).size, 9, 'ids must be unique');
  assert.ok(grid.every((t) => !t.expandsToGrid), 'grid tasks must not expand again');
});

test('expandGridTasks does nothing without a centre or with gridding off', () => {
  const [task] = buildTaskList({ category: 'a', city: 'b', grid: 'balanced' });
  assert.deepEqual(expandGridTasks(task, null, { grid: 'balanced' }), []);
  assert.deepEqual(expandGridTasks(task, { lat: 1, lng: 2, zoom: 12 }, { grid: 'off' }), []);
});

test('insertAfter keeps each search’s grid next to its own locate task', () => {
  const tasks = [{ id: 'a' }, { id: 'b' }];
  const out = insertAfter(tasks, 'a', [{ id: 'a0' }, { id: 'a1' }]);
  assert.deepEqual(out.map((t) => t.id), ['a', 'a0', 'a1', 'b']);
});

test('insertAfter appends when the anchor is gone, and no-ops on nothing', () => {
  assert.deepEqual(insertAfter([{ id: 'a' }], 'missing', [{ id: 'x' }]).map((t) => t.id), ['a', 'x']);
  assert.deepEqual(insertAfter([{ id: 'a' }], 'a', []).map((t) => t.id), ['a']);
});

test('nextPending finds the resume point and reports exhaustion', () => {
  const tasks = [{ id: 'a', status: 'done' }, { id: 'b', status: 'failed' }, { id: 'c', status: 'pending' }];
  assert.equal(nextPending(tasks).id, 'c');
  assert.equal(nextPending([{ status: 'done' }]), null);
  assert.equal(nextPending([]), null);
});

test('taskProgress counts failures as settled so a run can finish', () => {
  const tasks = [{ status: 'done' }, { status: 'failed' }, { status: 'pending' }];
  assert.deepEqual(taskProgress(tasks), { settled: 2, total: 3 });
});

test('a LinkedIn search is never gridded, whatever the coverage setting', async () => {
  // A people search has no viewport to divide; laying a grid over it would
  // just repeat the same query with coordinates the site ignores.
  const [task] = buildTaskList({ category: 'java', city: 'London', grid: 'exhaustive', source: 'linkedin' });
  assert.equal(task.expandsToGrid, false);
  assert.deepEqual(
    expandGridTasks(task, { lat: 51.5, lng: -0.12, zoom: 12 }, { grid: 'exhaustive', source: 'linkedin' }),
    []
  );
});

test('a Maps search still grids as before', async () => {
  const [task] = buildTaskList({ category: 'dentists', city: 'Chennai', grid: 'balanced', source: 'maps' });
  assert.equal(task.expandsToGrid, true);
  assert.equal(
    expandGridTasks(task, { lat: 13, lng: 80, zoom: 12 }, { grid: 'balanced', source: 'maps' }).length,
    9
  );
});

test('the batch box phrases each line for its source', async () => {
  assert.equal(parseBatch('java developer, London', 'linkedin')[0].term, 'java developer London');
  assert.equal(parseBatch('dentists, Chennai', 'maps')[0].term, 'dentists in Chennai');
});

test('current-tab mode is one task with nothing to navigate to', () => {
  // Navigating is exactly what would discard the filters the user set by hand,
  // so the task must carry no URL and no grid.
  const tasks = buildTaskList({ source: 'linkedin', useCurrentTab: true, grid: 'exhaustive' });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].useCurrentTab, true);
  assert.equal(tasks[0].term, '', 'the search comes from the page, not from here');
  assert.equal(tasks[0].point, null);
  assert.equal(tasks[0].expandsToGrid, false);
});

test('current-tab mode ignores a batch list rather than half-honouring it', () => {
  const tasks = buildTaskList({
    source: 'linkedin',
    useCurrentTab: true,
    batch: 'java, London\npython, Berlin',
  });
  assert.equal(tasks.length, 1, 'there is only one tab to scrape');
});

test('a normal run is unaffected by the current-tab branch', () => {
  const tasks = buildTaskList({ source: 'maps', category: 'dentists', city: 'Chennai', grid: 'balanced' });
  assert.equal(tasks[0].useCurrentTab, undefined);
  assert.equal(tasks[0].term, 'dentists in Chennai');
});

test('LinkedIn facets never reach a Maps run', () => {
  // The panel keeps a chosen location between runs, so a people search left a
  // geoUrn behind and the next Maps search would have been sent to a LinkedIn
  // URL with a Maps search term in it.
  const leftover = {
    source: 'maps',
    category: 'dentists',
    city: 'Chennai',
    facets: { geoUrn: ['102713980'] },
    facetLabels: { geoUrn: ['India'] },
  };
  assert.deepEqual(facetSearches(leftover), []);

  const [task] = buildTaskList(leftover);
  assert.equal(task.url, undefined, 'a Maps task builds its own URL from the term');
  assert.equal(task.term, 'dentists in Chennai');
});

test('a LinkedIn run with facets carries the URL, not a keyword place', () => {
  const [task] = buildTaskList({
    source: 'linkedin',
    category: 'kotlin',
    facets: { geoUrn: ['102713980'], serviceCategory: ['20016'] },
    facetLabels: { geoUrn: ['India'] },
  });
  assert.match(task.url, /keywords=kotlin/);
  assert.match(task.url, /geoUrn=%5B%22102713980%22%5D/);
  assert.match(task.url, /serviceCategory=%5B%2220016%22%5D/);
  // The label, not the id, is what lands on the records and in the filename.
  assert.equal(task.city, 'India');
});

test('two places become two searches only when asked', () => {
  const config = {
    source: 'linkedin',
    category: 'kotlin',
    facets: { geoUrn: ['101138777', '106888327'] },
    facetLabels: { geoUrn: ['Theni', 'Chennai'] },
  };
  assert.equal(buildTaskList(config).length, 1, 'both places in one search by default');

  const split = buildTaskList({ ...config, splitLocations: true });
  assert.equal(split.length, 2);
  assert.deepEqual(split.map((t) => t.city), ['Theni', 'Chennai']);
  assert.match(split[0].url, /geoUrn=%5B%22101138777%22%5D/);
  assert.match(split[1].url, /geoUrn=%5B%22106888327%22%5D/);
});
