/**
 * Browser test for the IndexedDB layer.
 *
 * Node has no IndexedDB, so this drives the real module inside Chromium
 * against a real database — which is the only way to catch the mistakes that
 * matter here (transaction lifetimes, index queries, cursor paging).
 *
 * Run with: npm run test:dom
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const storeSrc = readFileSync(join(ROOT, 'src/lib/store.js'), 'utf8');

function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium-') && dir !== 'chromium') continue;
      const bin = join(root, dir, 'chrome-linux', 'chrome');
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const CHROMIUM = findChromium();

/** Run `fn` in a page with the store module imported as `S`. */
async function inPage(browser, fn, arg) {
  const page = await browser.newPage();
  // A real http origin: IndexedDB is unavailable on about:blank / opaque origins.
  await page.route('**/store-test', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>store</title>' })
  );
  await page.goto('https://store.test/store-test');
  await page.addScriptTag({ content: storeSrc, type: 'module' });
  // Re-import as a blob module so the exports are reachable from evaluate().
  await page.evaluate(async (src) => {
    const blob = new Blob([src], { type: 'text/javascript' });
    window.S = await import(URL.createObjectURL(blob));
  }, storeSrc);

  const result = await page.evaluate(fn, arg);
  await page.close();
  return result;
}

async function launch(t) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    t.skip('playwright-core is not installed (npm i -D playwright-core)');
    return null;
  }
  return chromium.launch({ headless: true, ...(CHROMIUM ? { executablePath: CHROMIUM } : {}) });
}

test('records round-trip, scoped by job', async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const out = await inPage(browser, async () => {
      await window.S.putRecords('jobA', [
        { key: 'fid:1', name: 'Alpha' },
        { key: 'fid:2', name: 'Beta' },
      ]);
      await window.S.putRecords('jobB', [{ key: 'fid:3', name: 'Gamma' }]);

      return {
        a: (await window.S.getRecords('jobA')).map((r) => r.name).sort(),
        b: (await window.S.getRecords('jobB')).map((r) => r.name),
        countA: await window.S.countRecords('jobA'),
        missing: await window.S.getRecords('nope'),
      };
    });

    assert.deepEqual(out.a, ['Alpha', 'Beta']);
    assert.deepEqual(out.b, ['Gamma'], 'jobs must not leak into each other');
    assert.equal(out.countA, 2);
    assert.deepEqual(out.missing, [], 'an unknown job returns nothing, not an error');
  } finally {
    await browser.close();
  }
});

test('re-writing a record updates it in place instead of duplicating', async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const out = await inPage(browser, async () => {
      await window.S.putRecords('j', [{ key: 'fid:1', name: 'Alpha', phone: '' }]);
      // The same business, seen again by an overlapping grid cell.
      await window.S.putRecords('j', [{ key: 'fid:1', name: 'Alpha', phone: '044 1111 1111' }]);
      const all = await window.S.getRecords('j');
      return { count: all.length, phone: all[0].phone };
    });

    assert.equal(out.count, 1, 'the key path must dedupe on write');
    assert.equal(out.phone, '044 1111 1111');
  } finally {
    await browser.close();
  }
});

test('pageRecords windows a large set for the virtualised table', async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const out = await inPage(browser, async () => {
      const many = Array.from({ length: 250 }, (_, i) => ({
        key: `fid:${String(i).padStart(4, '0')}`,
        name: `Business ${i}`,
      }));
      await window.S.putRecords('big', many);

      const first = await window.S.pageRecords('big', 0, 10);
      const later = await window.S.pageRecords('big', 100, 10);
      const tail = await window.S.pageRecords('big', 245, 50);
      return {
        firstNames: first.map((r) => r.name),
        laterFirst: later[0].name,
        laterLen: later.length,
        tailLen: tail.length,
        total: await window.S.countRecords('big'),
      };
    });

    assert.equal(out.total, 250);
    assert.equal(out.firstNames.length, 10);
    assert.equal(out.firstNames[0], 'Business 0');
    assert.equal(out.laterFirst, 'Business 100', 'offset must skip exactly 100');
    assert.equal(out.laterLen, 10);
    assert.equal(out.tailLen, 5, 'a window past the end returns what is left');
  } finally {
    await browser.close();
  }
});

test('clearRecords removes one job and leaves the others alone', async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const out = await inPage(browser, async () => {
      await window.S.putRecords('keep', [{ key: 'k1', name: 'Keep' }]);
      await window.S.putRecords('drop', [{ key: 'd1', name: 'Drop' }, { key: 'd2', name: 'Drop2' }]);
      const removed = await window.S.clearRecords('drop');
      return {
        removed,
        keep: await window.S.countRecords('keep'),
        drop: await window.S.countRecords('drop'),
      };
    });

    assert.equal(out.removed, 2);
    assert.equal(out.keep, 1);
    assert.equal(out.drop, 0);
  } finally {
    await browser.close();
  }
});

test('the seen index remembers keys across runs and can be cleared', async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const out = await inPage(browser, async () => {
      await window.S.addSeen(['fid:1', 'fid:2']);
      await window.S.addSeen(['fid:2', 'fid:3']); // overlap must not double-count
      const hits = await window.S.filterSeen(['fid:1', 'fid:3', 'fid:99']);
      const count = await window.S.countSeen();
      await window.S.clearSeen();
      return { hits: [...hits].sort(), count, after: await window.S.countSeen() };
    });

    assert.deepEqual(out.hits, ['fid:1', 'fid:3']);
    assert.equal(out.count, 3, 'a repeated key is stored once');
    assert.equal(out.after, 0);
  } finally {
    await browser.close();
  }
});

test('meta survives a round trip and reports nothing for unknown keys', async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const out = await inPage(browser, async () => {
      await window.S.putMeta('job', { status: 'running', tasks: [{ id: 's0' }] });
      return {
        job: await window.S.getMeta('job'),
        missing: await window.S.getMeta('nothing-here'),
      };
    });

    assert.equal(out.job.status, 'running');
    assert.equal(out.job.tasks.length, 1);
    assert.equal(out.missing, undefined);
  } finally {
    await browser.close();
  }
});
