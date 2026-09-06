/**
 * Browser test for the side panel's virtualised results table.
 *
 * The point of the table is that a 20,000-row result set stays responsive, and
 * the only way to know that holds is to count the rows actually in the DOM.
 *
 * Run with: npm run test:dom
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOTAL = 2400;

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

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' };

/** Serve the extension over http — ES modules will not load from file://. */
function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(req.url.split('?')[0]);
        const body = await readFile(join(ROOT, path));
        res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

/** Stub the extension APIs and seed the database the panel reads. */
const SETUP = (total) => {
  const job = {
    status: 'done', phase: 'done', jobId: 'job-1', message: `Finished — ${total} businesses.`,
    count: total, phonesFound: total, emailsFound: Math.round(total * 0.4), sendable: 0,
    tasksSettled: 10, tasksTotal: 10,
    health: { ok: true, sample: total, rates: { name: 1, phone: 0.88, website: 0.41 } },
    config: { category: 'dentists', city: 'Chennai' },
  };
  const AREAS = ['Anna Nagar', 'Adyar', 'T Nagar', 'Velachery'];
  const RECORDS = Array.from({ length: total }, (_, i) => ({
    key: `fid:${String(i).padStart(5, '0')}`,
    name: `Clinic ${i}`,
    phone: `+91 44 2${String(i).padStart(3, '0')} 1122`,
    email: i % 4 ? `c${i}@x.test` : '',
    emailStatus: i % 11 === 0 ? 'no-mx' : 'valid',
    area: AREAS[i % AREAS.length],
    category: 'Dental clinic',
    rating: '4.5',
  }));

  window.chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      sendMessage: async (m) => (m.type === 'GET_JOB' ? { ok: true, job, seen: 0 } : { ok: true }),
      onMessage: { addListener: () => {} },
    },
    downloads: { download: async () => {} },
  };

  window.__seed = new Promise((resolve) => {
    const req = indexedDB.open('maps-lead-scraper', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('meta');
      db.createObjectStore('records', { keyPath: 'key' }).createIndex('jobId', 'jobId');
      db.createObjectStore('seen', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const tx = req.result.transaction('records', 'readwrite');
      const os = tx.objectStore('records');
      for (const r of RECORDS) os.put({ ...r, jobId: 'job-1' });
      tx.oncomplete = resolve;
    };
    req.onerror = resolve;
  });
};

async function openPanel(t) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    t.skip('playwright-core is not installed (npm i -D playwright-core)');
    return null;
  }

  const bin = findChromium();
  const browser = await chromium.launch({ headless: true, ...(bin ? { executablePath: bin } : {}) });
  const { server, port } = await serve();
  const page = await browser.newPage({ viewport: { width: 400, height: 720 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.addInitScript(SETUP, TOTAL);
  await page.goto(`http://localhost:${port}/src/panel/panel.html`);
  await page.evaluate(() => window.__seed);
  await page.waitForTimeout(700);

  return {
    page,
    errors,
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}

test('the panel opens on the results view and loads every record', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    assert.deepEqual(ctx.errors, [], 'the panel must load without exceptions');

    const note = await ctx.page.textContent('#rowNote');
    assert.match(note, /2,400 rows/);

    // Exactly one pane visible — a class selector can silently beat [hidden].
    assert.equal(await ctx.page.isVisible('#paneResults'), true);
    assert.equal(await ctx.page.isVisible('#paneSetup'), false);
  } finally {
    await ctx.close();
  }
});

test('only a window of rows is in the DOM, not all 2,400', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    const rendered = await ctx.page.locator('#rowBody tr').count();
    assert.ok(rendered > 5, `expected some rows, got ${rendered}`);
    assert.ok(rendered < 60, `expected a small window, got ${rendered} of ${TOTAL} in the DOM`);

    // The scroll height must still reflect the whole set.
    const spacer = await ctx.page.evaluate(() => document.getElementById('spacer').offsetHeight);
    assert.equal(spacer, TOTAL * 30, 'the spacer should size the scrollbar to every row');
  } finally {
    await ctx.close();
  }
});

test('scrolling swaps in later rows', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    const firstBefore = await ctx.page.textContent('#rowBody tr:first-child .c-name');
    assert.equal(firstBefore, 'Clinic 0');

    await ctx.page.evaluate(() => {
      document.getElementById('viewport').scrollTop = 30 * 1000;
    });
    await ctx.page.waitForTimeout(300);

    const firstAfter = await ctx.page.textContent('#rowBody tr:first-child .c-name');
    assert.notEqual(firstAfter, firstBefore, 'the window should have moved');
    const index = Number(firstAfter.replace('Clinic ', ''));
    assert.ok(index > 900 && index < 1010, `expected rows near 1000, got ${firstAfter}`);

    // Still a small window after scrolling — no accumulation.
    assert.ok((await ctx.page.locator('#rowBody tr').count()) < 60);
  } finally {
    await ctx.close();
  }
});

test('the filter narrows the set and the count follows', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.fill('#filter', 'Adyar');
    await ctx.page.waitForTimeout(300);

    const note = await ctx.page.textContent('#rowNote');
    assert.match(note, /600 of 2,400 rows/, 'one area in four should be 600 rows');

    const names = await ctx.page.locator('#rowBody tr .c-area').allTextContents();
    assert.ok(names.every((a) => a === 'Adyar'), 'every visible row should match the filter');

    await ctx.page.fill('#filter', 'nothing-matches-this');
    await ctx.page.waitForTimeout(200);
    assert.match(await ctx.page.textContent('#rowNote'), /No rows match/);
  } finally {
    await ctx.close();
  }
});

test('undeliverable emails are struck through', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    // Every 11th record is no-mx, so at least one is in the first window.
    const bad = await ctx.page.locator('#rowBody td.c-email.bad').count();
    assert.ok(bad > 0, 'a no-mx address should be flagged in the table');
  } finally {
    await ctx.close();
  }
});

test('switching to Setup hides the results and back again', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewSetup');
    assert.equal(await ctx.page.isVisible('#paneSetup'), true);
    assert.equal(await ctx.page.isVisible('#paneResults'), false);
    // The setup form should be populated and usable.
    assert.equal(await ctx.page.isVisible('#category'), true);

    await ctx.page.click('#viewResults');
    assert.equal(await ctx.page.isVisible('#paneResults'), true);
  } finally {
    await ctx.close();
  }
});

test('switching source shows only the controls that apply', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewSetup');

    // Maps: geography and business websites both mean something.
    assert.equal(await ctx.page.isVisible('#coverageRow'), true);
    assert.equal(await ctx.page.isVisible('#optEmails'), true);
    assert.equal(await ctx.page.isVisible('#optDeep'), true);
    assert.equal(await ctx.page.textContent('#categoryLabel'), 'Category');

    await ctx.page.selectOption('#source', 'linkedin');
    await ctx.page.waitForTimeout(150);

    // LinkedIn: no viewport to grid over, no website to read an email from.
    // These are display:flex containers, where [hidden] is easily overridden.
    assert.equal(await ctx.page.isVisible('#coverageRow'), false, 'no grid for a people search');
    assert.equal(await ctx.page.isVisible('#optEmails'), false, 'people have no site to scan');
    assert.equal(await ctx.page.isVisible('#optDeep'), false, 'there is no detail pass');
    assert.equal(await ctx.page.textContent('#categoryLabel'), 'Keywords');
    assert.equal(await ctx.page.textContent('#cityLabel'), 'Location');

    // Still useful for both, so it must survive the switch.
    assert.equal(await ctx.page.isVisible('#maxResults'), true);

    // And the account-risk warning has to be visible, not buried in a doc.
    assert.equal(await ctx.page.isVisible('#sourceNote'), true);
    assert.match(await ctx.page.textContent('#sourceNote'), /restricts accounts/i);

    await ctx.page.selectOption('#source', 'maps');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.isVisible('#coverageRow'), true, 'switching back restores it');
    assert.equal(await ctx.page.isVisible('#sourceNote'), false);
  } finally {
    await ctx.close();
  }
});
