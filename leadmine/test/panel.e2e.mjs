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
  const job = total
    ? {
        status: 'done', phase: 'done', jobId: 'job-1',
        message: `${total} businesses from 10 searches.`,
        count: total, phonesFound: total, emailsFound: Math.round(total * 0.4), sendable: 0,
        tasksSettled: 10, tasksTotal: 10,
        health: { ok: true, sample: total, rates: { name: 1, phone: 0.88, website: 0.41 } },
        config: { category: 'dentists', city: 'Chennai' },
      }
    // An untouched panel: the form is the view, nothing has run yet.
    : { status: 'idle', count: 0, tasksTotal: 0, tasksSettled: 0 };

  // What the worker sets when it restarts on a run that had already finished.
  if (window.__stale) {
    Object.assign(job, {
      stale: true,
      message: '0 businesses from 10 searches, 1 of them failed.',
      taskError: 'The page keeping the extension port is moved into back/forward cache.',
    });
  }

  if (window.__running) {
    Object.assign(job, {
      status: 'running', phase: 'listing', jobId: 'job-1',
      count: 143, phonesFound: 130, emailsFound: 51, sendable: 44,
      tasksSettled: 3, tasksTotal: 10,
      task: { term: 'dentists', city: 'Chennai' },
      message: '',
    });
  }

  if (window.__paused) {
    Object.assign(job, {
      status: 'paused',
      canResume: true,
      count: 40,
      tasksSettled: 3,
      tasksTotal: 10,
      message: 'Interrupted — press Resume to carry on where it stopped.',
    });
  }
  // The poll reads this same object every two seconds, so a test can move the
  // run on by writing to it — which is the only way to exercise an edge like
  // running-to-done from outside the worker.
  window.__job = job;

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
    // A people search fills different fields, and the card reads them
    // differently — that path had no coverage at all while it was a table.
    ...(window.__linkedin
      ? {
          source: 'linkedin',
          name: `Priya Sharma ${i}`,
          headline: 'Senior ServiceNow Architect | ITSM',
          company: 'Tata Consultancy Services',
          location: 'Chennai, Tamil Nadu, India',
          degree: '2nd',
          profileUrl: `https://www.linkedin.com/in/priya-sharma-${i}`,
        }
      : {}),
  }));

  // A real in-memory store, not a stub that forgets: the planner's key is
  // read back out of it on load, and that path has to be exercised.
  window.__storage = window.__storage || {};
  window.chrome = {
    storage: {
      local: {
        get: async (key) => (key in window.__storage ? { [key]: window.__storage[key] } : {}),
        set: async (obj) => Object.assign(window.__storage, obj),
      },
    },
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
      // The packaged geo data is served by the test server like any other file.
      getURL: (path) => `/${path}`,
      // Cloned, because a real message is: the panel gets a fresh object every
      // poll and compares it against the last one. Handing back the same
      // reference made "what changed since last time" always answer nothing.
      sendMessage: async (m) => {
        if (m.type === 'GET_JOB') {
          return { ok: true, job: JSON.parse(JSON.stringify(job)), seen: 0 };
        }
        // Standing in for the LinkedIn tab the worker would drive. Tests set
        // window.__resolve to say what LinkedIn answers.
        if (m.type === 'RESOLVE_FACET') {
          window.__resolveAsked = m.want;
          const answer = window.__resolve || { ok: false, reason: 'nothing set up' };
          // The real worker stores what it learned before answering, and the
          // panel reads the table back — so the stub has to as well.
          if (answer.ok) {
            const table = window.__storage['mls.urns'] || {};
            const slot = { ...(table[answer.facet] || {}) };
            slot[answer.label.toLowerCase()] = { id: answer.id, label: answer.label };
            window.__storage['mls.urns'] = { ...table, [answer.facet]: slot };
          }
          return answer;
        }
        return { ok: true };
      },
      onMessage: { addListener: () => {} },
    },
    downloads: { download: async () => {} },
  };

  // Stand in for Gemini/Groq. The test sets window.__aiNext before clicking.
  // The model listing is a GET and answered separately, so a planner test does
  // not have to care that the picker also talks to the provider.
  window.__aiCalls = [];
  window.__aiModelCalls = [];
  window.__aiNext = { status: 200, body: {} };
  window.__aiModels = {
    status: 200,
    body: {
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro',
          supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', displayName: 'Embedding',
          supportedGenerationMethods: ['embedContent'] },
      ],
    },
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    // The "Where?" picker reads packaged JSON, not a provider. Let it through.
    if (String(url).includes('/src/data/geo/')) return realFetch(url, init);
    const listing = (init.method || 'GET') === 'GET';
    const next = listing ? window.__aiModels : window.__aiNext;
    (listing ? window.__aiModelCalls : window.__aiCalls).push({
      url, headers: init.headers, body: init.body ? JSON.parse(init.body) : null,
    });
    return {
      ok: next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  };

  window.__seed = new Promise((resolve) => {
    // The database name did not change with the product — see store.js.
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

async function openPanel(
  t,
  {
    idle = false, paused = false, running = false, linkedin = false,
    aiKey = '', urns = null, noManifest = false, stale = false,
  } = {}
) {
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

  if (paused) await page.addInitScript(() => { window.__paused = true; });
  if (running) await page.addInitScript(() => { window.__running = true; });
  if (linkedin) await page.addInitScript(() => { window.__linkedin = true; });
  // Filter ids the extension has already learned, as a run would have left
  // them. The harness's storage lives in the page, so this has to be seeded
  // before the panel loads rather than written afterwards.
  if (urns) {
    await page.addInitScript((table) => {
      window.__storage = { ...(window.__storage || {}), 'mls.urns': table };
    }, urns);
  }
  if (stale) await page.addInitScript(() => { window.__stale = true; });
  if (aiKey) {
    // Deliberately the shape an older build wrote — one key, no provider — so
    // the migration path is exercised on every planner test.
    await page.addInitScript((key) => {
      window.__storage = { 'mls.ai': { provider: 'gemini', key, model: '' } };
    }, aiKey);
  }
  await page.addInitScript(SETUP, idle ? 0 : TOTAL);
  // After SETUP, which is what defines window.chrome in the first place.
  if (noManifest) await page.addInitScript(() => { delete chrome.runtime.getManifest; });
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

test('the panel opens on Search, and Results loads every record', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    assert.deepEqual(ctx.errors, [], 'the panel must load without exceptions');

    // Search is the entry point: a finished run should not hijack the view.
    assert.equal(await ctx.page.isVisible('#paneSetup'), true);
    assert.equal(await ctx.page.isVisible('#paneResults'), false);
    // The count on the tab is how the results announce themselves.
    assert.equal(await ctx.page.textContent('#tabCount'), '2,400');

    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    assert.match(await ctx.page.textContent('#rowNote'), /2,400 rows/);
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
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    const rendered = await ctx.page.locator('#rowBody .lead').count();
    assert.ok(rendered > 5, `expected some rows, got ${rendered}`);
    assert.ok(rendered < 60, `expected a small window, got ${rendered} of ${TOTAL} in the DOM`);

    // The scroll height must still reflect the whole set. The row height is
    // read from the stylesheet rather than repeated here — the last time it
    // was a literal in two places, the two drifted apart.
    const { spacer, rowHeight } = await ctx.page.evaluate(() => ({
      spacer: document.getElementById('spacer').offsetHeight,
      rowHeight: parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--row-h'),
        10
      ),
    }));
    assert.equal(spacer, TOTAL * rowHeight, 'the spacer should size the scrollbar to every row');
  } finally {
    await ctx.close();
  }
});

test('scrolling swaps in later rows', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    const firstBefore = await ctx.page.textContent('#rowBody .lead:first-child .lead-name');
    assert.equal(firstBefore, 'Clinic 0');

    await ctx.page.evaluate(() => {
      const rowHeight = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--row-h'),
        10
      );
      document.getElementById('viewport').scrollTop = rowHeight * 1000;
    });
    await ctx.page.waitForTimeout(300);

    const firstAfter = await ctx.page.textContent('#rowBody .lead:first-child .lead-name');
    assert.notEqual(firstAfter, firstBefore, 'the window should have moved');
    const index = Number(firstAfter.replace('Clinic ', ''));
    assert.ok(index > 900 && index < 1010, `expected rows near 1000, got ${firstAfter}`);

    // Still a small window after scrolling — no accumulation.
    assert.ok((await ctx.page.locator('#rowBody .lead').count()) < 60);
  } finally {
    await ctx.close();
  }
});

test('the filter narrows the set and the count follows', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    await ctx.page.fill('#filter', 'Adyar');
    await ctx.page.waitForTimeout(300);

    const note = await ctx.page.textContent('#rowNote');
    assert.match(note, /600 of 2,400 rows/, 'one area in four should be 600 rows');

    const areas = await ctx.page.locator('#rowBody .lead .lead-area').allTextContents();
    assert.ok(areas.length > 5, `expected a window of cards, got ${areas.length}`);
    assert.ok(areas.every((a) => a === 'Adyar'), 'every visible card should match the filter');

    await ctx.page.fill('#filter', 'nothing-matches-this');
    await ctx.page.waitForTimeout(200);
    assert.match(await ctx.page.textContent('#rowNote'), /Nothing matches/);
  } finally {
    await ctx.close();
  }
});

test('undeliverable emails are struck through', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    // Every 11th record is no-mx, so at least one is in the first window.
    const bad = await ctx.page.locator('#rowBody .lead-email.bad').count();
    assert.ok(bad > 0, 'a no-mx address should be flagged in the list');
  } finally {
    await ctx.close();
  }
});

test('the two views swap cleanly', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    assert.equal(await ctx.page.isVisible('#paneResults'), true);
    assert.equal(await ctx.page.isVisible('#paneSetup'), false);

    await ctx.page.click('#viewSetup');
    assert.equal(await ctx.page.isVisible('#paneSetup'), true);
    assert.equal(await ctx.page.isVisible('#paneResults'), false);
  } finally {
    await ctx.close();
  }
});

test('switching source shows only the controls that apply', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    // Open the disclosure so the per-source options are on screen at all.
    await ctx.page.evaluate(() => {
      document.querySelector('details.advanced').open = true;
    });

    // Maps: geography and business websites both mean something.
    assert.equal(await ctx.page.isVisible('#coverageRow'), true);
    assert.equal(await ctx.page.isVisible('#optEmails'), true);
    assert.equal(await ctx.page.isVisible('#optDeep'), true);

    await ctx.page.click('label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(200);

    // LinkedIn: no viewport to grid over, no website to read an email from.
    // These are display:flex containers, where [hidden] is easily overridden.
    assert.equal(await ctx.page.isVisible('#coverageRow'), false, 'no grid for a people search');
    assert.equal(await ctx.page.isVisible('#optEmails'), false, 'people have no site to scan');
    assert.equal(await ctx.page.isVisible('#optDeep'), false, 'there is no detail pass');

    // Still useful for both, so it must survive the switch.
    assert.equal(await ctx.page.isVisible('#maxResults'), true);

    // And the account-risk warning has to be visible, not buried in a doc.
    assert.equal(await ctx.page.isVisible('#sourceNote'), true);
    assert.match(await ctx.page.textContent('#sourceNote'), /restricts accounts/i);

    await ctx.page.click('label.seg:has(input[value="maps"])');
    await ctx.page.waitForTimeout(200);
    assert.equal(await ctx.page.isVisible('#coverageRow'), true, 'switching back restores it');
    assert.equal(await ctx.page.isVisible('#sourceNote'), false);
  } finally {
    await ctx.close();
  }
});

test('current-tab mode replaces the typed search with the page’s own', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    // Maps drives the tab itself, so the option does not apply there.
    assert.equal(await ctx.page.isVisible('#optCurrentTab'), false);

    await ctx.page.click('label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(200);
    assert.equal(await ctx.page.isVisible('#optCurrentTab'), true);

    // Off: the keyword and location inputs are how you search.
    assert.equal(await ctx.page.isVisible('#modeSingle'), true);
    assert.equal(await ctx.page.isVisible('#currentTabHint'), false);

    await ctx.page.check('#useCurrentTab');
    await ctx.page.waitForTimeout(200);

    // On: those inputs would be ignored, so they are hidden rather than lying.
    assert.equal(await ctx.page.isVisible('#modeSingle'), false);
    assert.equal(await ctx.page.isVisible('#currentTabHint'), true);
    assert.match(await ctx.page.textContent('#currentTabHint'), /from that page/i);

    await ctx.page.uncheck('#useCurrentTab');
    await ctx.page.waitForTimeout(200);
    assert.equal(await ctx.page.isVisible('#modeSingle'), true, 'unchecking restores the inputs');

    // Switching back to Maps must clear it, not leave a stale flag set.
    await ctx.page.check('#useCurrentTab');
    await ctx.page.click('label.seg:has(input[value="maps"])');
    await ctx.page.waitForTimeout(200);
    assert.equal(await ctx.page.isChecked('#useCurrentTab'), false);
    assert.equal(await ctx.page.isVisible('#modeSingle'), true);
  } finally {
    await ctx.close();
  }
});

test('the three coverage levels drive the underlying setting', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    // Five grid presets were three too many to choose between, so the panel
    // offers three named outcomes and maps them onto the real values.
    assert.equal(await ctx.page.inputValue('#grid'), 'balanced');

    await ctx.page.click('#coverage label.seg:has(input[value="off"])');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.inputValue('#grid'), 'off');
    // Naming a level is not telling anyone what it costs, so the consequence
    // of the chosen one is spelled out beside it.
    assert.match(await ctx.page.textContent('#coverageHint'), /few minutes/i);

    await ctx.page.click('#coverage label.seg:has(input[value="exhaustive"])');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.inputValue('#grid'), 'exhaustive');
    assert.match(await ctx.page.textContent('#coverageHint'), /an hour/i);
  } finally {
    await ctx.close();
  }
});

test('advanced options stay out of the way until asked for', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    // The whole point of the disclosure: five checkboxes are not five
    // decisions the user has to make before starting.
    assert.equal(await ctx.page.isVisible('#verifyEmails'), false);
    assert.equal(await ctx.page.isVisible('#skipSeen'), false);
    // What is on screen is the search and one button.
    assert.equal(await ctx.page.isVisible('#category'), true);
    assert.equal(await ctx.page.isVisible('#start'), true);

    await ctx.page.click('details.advanced summary');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.isVisible('#verifyEmails'), true);
  } finally {
    await ctx.close();
  }
});

test('the category field is optional and offers what the run found', async (t) => {
  // A finished job hides the form, so this one starts from the search view.
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    // Load the results so the suggestions can learn from them, then return to
    // the form — "New search" is how a user gets back to it after a run.
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);
    await ctx.page.click('#viewSetup');
    await ctx.page.click('#again');
    await ctx.page.waitForTimeout(200);

    // Optional: blank by default, and blank is a valid way to leave it.
    assert.equal(await ctx.page.isVisible('#categoryFilter'), true);
    assert.equal(await ctx.page.inputValue('#categoryFilter'), '');
    assert.match(await ctx.page.textContent('#categoryFilterRow'), /optional/i);

    // Choose-or-type: a text input backed by a datalist, so a value outside
    // the list is still accepted.
    assert.equal(await ctx.page.getAttribute('#categoryFilter', 'list'), 'categoryOptions');

    // The suggestions are the categories this run produced, not a fixed guess.
    const options = await ctx.page.$$eval('#categoryOptions option', (els) => els.map((e) => e.value));
    assert.ok(options.includes('Dental clinic'), 'the fixture’s own category is offered');
    assert.ok(options.length > 1, 'the standing list is offered too');

    await ctx.page.fill('#categoryFilter', 'anything at all');
    assert.equal(await ctx.page.inputValue('#categoryFilter'), 'anything at all');
  } finally {
    await ctx.close();
  }
});

test('the category field relabels itself for LinkedIn', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.textContent('#filterLabel'), 'Category');

    await ctx.page.click('label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(200);

    // People have no category, so it narrows on the headline instead.
    assert.equal(await ctx.page.textContent('#filterLabel'), 'Headline contains');
    assert.equal(await ctx.page.isVisible('#categoryFilter'), true);

    // "per search" made a limit of 100 look ignored: one LinkedIn search is
    // the whole run, not one page of it.
    assert.equal(await ctx.page.textContent('#limitLabel'), 'How many profiles?');
    assert.match(await ctx.page.textContent('#limitHint'), /every profile LinkedIn will show/i);
  } finally {
    await ctx.close();
  }
});

test('an interrupted run can actually be resumed', async (t) => {
  // Resume used to live on the form, and a paused run hides the form — so the
  // one button that mattered was unreachable exactly when it was needed.
  const ctx = await openPanel(t, { paused: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.isVisible('#form'), false, 'a paused run shows the run view');
    assert.equal(await ctx.page.isVisible('#resume'), true, 'Resume must be on screen');
    assert.equal(await ctx.page.isVisible('#stop'), false, 'nothing is running to stop');

    // And the reason it paused has to be readable, not just the button.
    assert.match(await ctx.page.textContent('#message'), /Interrupted/i);
  } finally {
    await ctx.close();
  }
});

test('the results view has a designed empty state', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(300);

    assert.equal(await ctx.page.isVisible('#emptyResults'), true);
    assert.equal(await ctx.page.isVisible('#scroller'), false, 'no empty table frame');
    assert.match(await ctx.page.textContent('#emptyResults'), /No results yet/i);

    // It offers the way out rather than leaving the user on a dead screen.
    await ctx.page.click('#emptyGoSearch');
    assert.equal(await ctx.page.isVisible('#paneSetup'), true);
  } finally {
    await ctx.close();
  }
});

test('a populated results view shows the table, not the empty state', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);
    assert.equal(await ctx.page.isVisible('#emptyResults'), false);
    assert.equal(await ctx.page.isVisible('#scroller'), true);
  } finally {
    await ctx.close();
  }
});

test('only one action is styled as primary at a time', async (t) => {
  const paused = await openPanel(t, { paused: true });
  if (!paused) return;
  try {
    // Paused: resuming is the question, so it is the only primary.
    assert.ok((await paused.page.getAttribute('#resume', 'class')).includes('btn--primary'));
    assert.ok(!(await paused.page.getAttribute('#goResults', 'class')).includes('btn--primary'));
  } finally {
    await paused.close();
  }

  const done = await openPanel(t);
  if (!done) return;
  try {
    // Finished: reading the results is the question.
    assert.ok((await done.page.getAttribute('#goResults', 'class')).includes('btn--primary'));
  } finally {
    await done.close();
  }
});

/* ------------------------------------------------------- the search planner */

/** What Gemini returns, in the shape the panel's client unwraps. */
const geminiBody = (obj) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
});

const PLAN = {
  status: 'ready',
  understood: 'Bulk buyers for industrial cleaning chemicals around Chennai.',
  searches: [
    { query: 'facility management companies', city: 'Chennai', tier: 1, reason: 'Buy in bulk.' },
    { query: 'janitorial supply wholesalers', city: 'Chennai', tier: 2, reason: 'They resell it.' },
    { query: 'hotel housekeeping suppliers', city: 'Chennai', tier: 3, reason: 'Use it daily.' },
  ],
};

/** The planner's settings live behind More options; open it without a click. */
async function openAdvanced(ctx) {
  await ctx.page.evaluate(() => {
    document.getElementById('aiSettings').closest('details').open = true;
  });
}

async function runPlanner(ctx, { brief, reply, status = 200 }) {
  await ctx.page.evaluate(
    ([body, code]) => {
      window.__aiNext = { status: code, body };
    },
    [reply, status]
  );
  await ctx.page.fill('#aiBrief', brief);
  await ctx.page.click('#aiPlan');
  await ctx.page.waitForTimeout(300);
}

test('the planner is offered but locked until a key is added', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    // Without a key nothing in here can run, so it starts folded — the offer
    // is the summary, not three hundred pixels of dead form.
    assert.equal(await ctx.page.isVisible('#assist'), true, 'the offer has to be visible to be used');
    assert.equal(await ctx.page.isVisible('#aiBrief'), false, 'folded until it can do something');

    await ctx.page.click('.assist-summary');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.isDisabled('#aiPlan'), true);
    assert.equal(await ctx.page.isVisible('#aiKeyHint'), true, 'say what is missing');

    // The hint's link is the way in, and it opens the box it points at.
    await ctx.page.click('#aiOpenSettings');
    assert.equal(await ctx.page.isVisible('#aiKey'), true);

    await ctx.page.fill('#aiKey', 'AIza-test');
    assert.equal(await ctx.page.isDisabled('#aiPlan'), false, 'typing a key unlocks it immediately');
  } finally {
    await ctx.close();
  }
});

test('a saved key comes back on the next open', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-saved' });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.inputValue('#aiKey'), 'AIza-saved');
    assert.equal(await ctx.page.isDisabled('#aiPlan'), false);
    // A password field, so a shared screen does not leak it.
    assert.equal(await ctx.page.getAttribute('#aiKey', 'type'), 'password');
  } finally {
    await ctx.close();
  }
});

test('a brief becomes a plan the user can edit before running it', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-test' });
  if (!ctx) return;
  try {
    await runPlanner(ctx, {
      brief: 'I make industrial floor cleaning chemicals and want bulk buyers in Chennai',
      reply: geminiBody(PLAN),
    });

    assert.equal(await ctx.page.isVisible('#aiResult'), true);
    assert.equal(await ctx.page.locator('#aiList .assist-item').count(), 3);
    // The reasoning is shown, because the user is the one deciding.
    assert.match(await ctx.page.textContent('#aiList'), /They resell it/);
    assert.match(await ctx.page.textContent('#aiUnderstood'), /Bulk buyers/);

    // Untick one, then apply: the batch box is left editable by hand.
    await ctx.page.uncheck('#aiList .assist-item:nth-child(3) input');
    await ctx.page.click('#aiApply');
    await ctx.page.waitForTimeout(150);

    assert.equal(
      await ctx.page.inputValue('#batch'),
      'facility management companies, Chennai\njanitorial supply wholesalers, Chennai'
    );
    assert.equal(await ctx.page.isVisible('#modeBatch'), true, 'the form switches to the list it filled');
  } finally {
    await ctx.close();
  }
});

test('the API key never reaches the run config', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-secret' });
  if (!ctx) return;
  try {
    await runPlanner(ctx, { brief: 'dentists in Chennai', reply: geminiBody(PLAN) });
    await ctx.page.click('#aiApply');
    await ctx.page.waitForTimeout(200);

    // The form's saved settings are what the worker and the export path see.
    const settings = await ctx.page.evaluate(() =>
      JSON.stringify(window.__storage['mls.settings'] || {})
    );
    assert.ok(!settings.includes('AIza-secret'), 'a key in the job config would reach an export');
  } finally {
    await ctx.close();
  }
});

test('a question from the planner is asked, not answered with guesses', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-test' });
  if (!ctx) return;
  try {
    await runPlanner(ctx, {
      brief: 'I need suppliers',
      reply: geminiBody({ status: 'needs_clarification', question: 'Suppliers of what?' }),
    });

    assert.match(await ctx.page.textContent('#aiStatus'), /Suppliers of what\?/);
    assert.equal(await ctx.page.isVisible('#aiResult'), false, 'no plan should be offered yet');
  } finally {
    await ctx.close();
  }
});

test('a rejected key is reported next to the button, not as a run failure', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-wrong' });
  if (!ctx) return;
  try {
    await runPlanner(ctx, { brief: 'dentists', reply: {}, status: 401 });

    assert.match(await ctx.page.textContent('#aiStatus'), /key was rejected/i);
    assert.equal(await ctx.page.isVisible('#error'), false, 'the form has not failed — the planner has');
    assert.equal(await ctx.page.isDisabled('#aiPlan'), false, 'still usable after a fix');
  } finally {
    await ctx.close();
  }
});

test('the planner asks for people when the source is LinkedIn', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-test' });
  if (!ctx) return;
  try {
    await ctx.page.click('label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(150);
    assert.match(await ctx.page.textContent('#assistSub'), /person you need/i);

    await runPlanner(ctx, { brief: 'ServiceNow trainers', reply: geminiBody(PLAN) });
    const sent = await ctx.page.evaluate(
      () => window.__aiCalls[0].body.contents[0].parts[0].text
    );
    assert.match(sent, /linkedin \(people\)/);
  } finally {
    await ctx.close();
  }
});

test('reading the user’s own tab hides the planner, which has nothing to fill', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-test' });
  if (!ctx) return;
  try {
    await ctx.page.click('label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(150);
    await ctx.page.check('#useCurrentTab');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.isVisible('#assist'), false);
  } finally {
    await ctx.close();
  }
});

test('each provider keeps its own key and model', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-gemini' });
  if (!ctx) return;
  try {
    await openAdvanced(ctx);
    assert.equal(await ctx.page.inputValue('#aiKey'), 'AIza-gemini');

    await ctx.page.click('label.seg:has(input[value="groq"])');
    await ctx.page.waitForTimeout(150);
    // Switching must not hand Gemini's key — or its model — to Groq.
    assert.equal(await ctx.page.inputValue('#aiKey'), '');
    assert.equal(await ctx.page.isDisabled('#aiPlan'), true);

    await ctx.page.fill('#aiKey', 'gsk_groq');
    await ctx.page.click('label.seg:has(input[value="gemini"])');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.inputValue('#aiKey'), 'AIza-gemini', 'the first key survives');

    await ctx.page.click('label.seg:has(input[value="groq"])');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.inputValue('#aiKey'), 'gsk_groq', 'and so does the second');
  } finally {
    await ctx.close();
  }
});

test('the model picker is out of the way, and lists what the key can use', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-test' });
  if (!ctx) return;
  try {
    await openAdvanced(ctx);
    // An unlabelled box under the key box is a box people paste keys into.
    assert.equal(await ctx.page.isVisible('#aiModel'), false);
    assert.equal(await ctx.page.isVisible('#aiModelToggle'), true);
    assert.equal(await ctx.page.evaluate(() => window.__aiModelCalls.length), 0,
      'an ordinary run must not spend a request on a list nobody opened');

    await ctx.page.click('#aiModelToggle');
    await ctx.page.waitForTimeout(300);
    assert.equal(await ctx.page.isVisible('#aiModel'), true);

    // Names are never typed or remembered — they come from the provider.
    const options = await ctx.page.evaluate(() =>
      [...document.getElementById('aiModel').options].map((o) => o.value)
    );
    assert.equal(options[0], '', 'the recommended model is the empty choice');
    assert.deepEqual(options.slice(1), ['gemini-2.5-flash', 'gemini-2.5-pro']);
    assert.ok(!options.includes('text-embedding-004'), 'a model that cannot answer is not offered');
    assert.match(await ctx.page.textContent('#aiModelHelp'), /2 models/);
  } finally {
    await ctx.close();
  }
});

test('the model listing failure is shown where the picker is', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-test' });
  if (!ctx) return;
  try {
    await openAdvanced(ctx);
    await ctx.page.evaluate(() => {
      window.__aiModels = { status: 401, body: {} };
    });
    await ctx.page.click('#aiModelToggle');
    await ctx.page.waitForTimeout(300);

    assert.match(await ctx.page.textContent('#aiModelHelp'), /key was rejected/i);
    // The recommended model is still selectable, so the planner still works.
    assert.equal(await ctx.page.inputValue('#aiModel'), '');
  } finally {
    await ctx.close();
  }
});

test('a key pasted under the wrong provider says which one it is', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    await openAdvanced(ctx);
    await ctx.page.fill('#aiKey', 'gsk_a_groq_key');
    await runPlanner(ctx, { brief: 'dentists in Chennai', reply: {} });

    assert.match(await ctx.page.textContent('#aiStatus'), /looks like a Groq key/i);
    // Nothing was spent finding that out.
    assert.equal(await ctx.page.evaluate(() => window.__aiCalls.length), 0);
  } finally {
    await ctx.close();
  }
});

/** Every element that can actually be scrolled, by id/class. */
const SCROLLERS = () => {
  const found = [];
  const walk = (el) => {
    const style = getComputedStyle(el);
    const scrolls =
      el === document.documentElement
        ? el.scrollHeight - el.clientHeight > 1
        : ['auto', 'scroll'].includes(style.overflowY) && el.scrollHeight - el.clientHeight > 1;
    if (scrolls) {
      found.push(el.tagName + (el.id ? `#${el.id}` : ''));
    }
    for (const child of el.children) walk(child);
  };
  walk(document.documentElement);
  return found;
};

test('the panel has one scrollbar, not two', async (t) => {
  // Two appeared because the visually-hidden radio inputs are absolutely
  // positioned: with no positioned ancestor they resolved against the initial
  // containing block, sat outside the pane's scroller at their static position,
  // and stretched the page behind it to the height of the whole form.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    await openAdvanced(ctx);
    await ctx.page.waitForTimeout(200);

    const scrollers = await ctx.page.evaluate(SCROLLERS);
    assert.deepEqual(scrollers, ['SECTION#paneSetup'], 'only the pane may scroll');

    const page = await ctx.page.evaluate(() => ({
      client: document.documentElement.clientHeight,
      scroll: document.documentElement.scrollHeight,
    }));
    assert.equal(page.scroll, page.client, 'the page behind the pane must not extend');
  } finally {
    await ctx.close();
  }
});

test('the results view scrolls in the table, not the page', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    const scrollers = await ctx.page.evaluate(SCROLLERS);
    assert.deepEqual(scrollers, ['DIV#viewport'], 'the virtualised table is the only scroller');
  } finally {
    await ctx.close();
  }
});

/* --------------------------------------------------- rows the filter set aside */

/** Seed a finished job whose category filter set every row aside. */
const SET_ASIDE = (kept) => {
  const job = {
    status: 'done', phase: 'done', jobId: 'job-1',
    message: 'All 235 were set aside by the category filter “housekeeping”.',
    count: kept, filteredOut: 235, tasksSettled: 10, tasksTotal: 10,
    config: { source: 'maps', category: 'Departmental store', city: 'Chennai',
              categoryFilter: 'housekeeping' },
  };
  const CATS = ['Department store', 'Supermarket', 'Grocery store'];
  const records = [
    ...Array.from({ length: kept }, (_, i) => ({
      key: `keep:${i}`, name: `Kept ${i}`, category: 'Housekeeping service', area: 'Adyar',
    })),
    ...Array.from({ length: 235 }, (_, i) => ({
      key: `aside:${i}`, name: `Store ${i}`, category: CATS[i % CATS.length],
      area: 'Adyar', setAside: 'housekeeping',
    })),
  ];

  window.__storage = window.__storage || {};
  window.chrome = {
    storage: {
      local: {
        get: async (k) => (k in window.__storage ? { [k]: window.__storage[k] } : {}),
        set: async (o) => Object.assign(window.__storage, o),
      },
    },
    runtime: {
      getManifest: () => ({ version: '9.9.9' }),
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
      for (const r of records) os.put({ ...r, jobId: 'job-1' });
      tx.oncomplete = resolve;
    };
    req.onerror = resolve;
  });
};

async function openSetAside(t, kept) {
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
  await page.addInitScript(SET_ASIDE, kept);
  await page.goto(`http://localhost:${port}/src/panel/panel.html`);
  await page.evaluate(() => window.__seed);
  await page.waitForTimeout(700);
  return { page, close: async () => { await browser.close(); server.close(); } };
}

test('a filter that keeps nothing shows the rows, not an empty table', async (t) => {
  // The live run: 235 found, every one set aside, and the panel said
  // "0 businesses" — which reads as the scraper having failed.
  const ctx = await openSetAside(t, 0);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    assert.equal(await ctx.page.isVisible('#emptyResults'), false, 'the rows exist — show them');
    assert.match(await ctx.page.textContent('#rowNote'), /235 rows/);

    // The notice names the filter and what it could have matched instead.
    const note = await ctx.page.textContent('#asideNote');
    assert.match(note, /235 set aside by category “housekeeping”/);
    assert.match(note, /Department store/, 'what was actually found is the fix');
  } finally {
    await ctx.close();
  }
});

test('set-aside rows are hidden by default when something was kept', async (t) => {
  const ctx = await openSetAside(t, 12);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);
    assert.match(await ctx.page.textContent('#rowNote'), /12 rows/);

    await ctx.page.click('#asideToggle');
    await ctx.page.waitForTimeout(200);
    assert.match(await ctx.page.textContent('#rowNote'), /247 rows/, '12 kept plus 235 set aside');

    await ctx.page.click('#asideToggle');
    await ctx.page.waitForTimeout(200);
    assert.match(await ctx.page.textContent('#rowNote'), /12 rows/);
  } finally {
    await ctx.close();
  }
});

test('the download writes exactly what the table is showing', async (t) => {
  const ctx = await openSetAside(t, 12);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);
    await ctx.page.evaluate(() => {
      window.__rowsWritten = null;
      chrome.downloads.download = async () => {};
      const blob = window.Blob;
      window.Blob = class extends blob {
        constructor(parts, opts) {
          super(parts, opts);
          // Non-empty lines minus the header; the file ends with a newline.
          window.__rowsWritten = String(parts[0]).split('\n').filter(Boolean).length - 1;
        }
      };
    });

    await ctx.page.selectOption('#format', 'csv');
    await ctx.page.click('#download');
    await ctx.page.waitForTimeout(600);
    assert.equal(await ctx.page.evaluate(() => window.__rowsWritten), 12);

    await ctx.page.click('#asideToggle');
    await ctx.page.click('#download');
    await ctx.page.waitForTimeout(600);
    assert.equal(await ctx.page.evaluate(() => window.__rowsWritten), 247);
  } finally {
    await ctx.close();
  }
});

test('the button the panel exists for is on screen the moment it opens', async (t) => {
  // This is the defect the layout was rebuilt around. The form was 1,050px of
  // controls in a 760px panel, so opening LeadMine showed no way to start
  // anything: Start was three hundred pixels below the fold, and nothing in
  // the suite would have noticed.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    const box = await ctx.page.locator('#start').boundingBox();
    const view = ctx.page.viewportSize();
    assert.ok(box, 'Start has to be rendered');
    assert.ok(
      box.y >= 0 && box.y + box.height <= view.height,
      `Start must be within the panel without scrolling, was at y=${box.y}`
    );

    // And it stays there: the bar is pinned, not merely short enough today.
    await ctx.page.evaluate(() => {
      document.getElementById('paneSetup').scrollTop = 9999;
    });
    await ctx.page.waitForTimeout(150);
    const after = await ctx.page.locator('#start').boundingBox();
    assert.equal(Math.round(after.y), Math.round(box.y), 'the bar must not scroll with the form');
  } finally {
    await ctx.close();
  }
});

test('the bar carries the action of whichever view is above it', async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.isVisible('#barSearch'), true);
    assert.equal(await ctx.page.isVisible('#download'), false, 'nothing to download from the form');

    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);
    assert.equal(await ctx.page.isVisible('#download'), true);
    assert.equal(await ctx.page.isVisible('#barSearch'), false, 'one action per view, one place');
  } finally {
    await ctx.close();
  }
});

test('a finished run hands the user over to its results', async (t) => {
  // A run exists for the rows it produces, and reaching them used to mean
  // noticing a tab and clicking it.
  const ctx = await openPanel(t, { running: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.isVisible('#paneSetup'), true, 'a run keeps the screen while it runs');
    assert.match(await ctx.page.textContent('#taskLine'), /dentists, Chennai/, 'say which search');

    // The panel polls the worker; move the job on and let it notice.
    await ctx.page.evaluate(() => {
      Object.assign(window.__job, { status: 'done', phase: 'done', count: 2400 });
    });
    await ctx.page.waitForTimeout(2600);

    assert.equal(await ctx.page.isVisible('#paneResults'), true, 'the rows are the point');
    assert.equal(await ctx.page.isVisible('#download'), true);
  } finally {
    await ctx.close();
  }
});

test('a phone number is one click away from the clipboard', async (t) => {
  // Reading a number off the screen and typing it back in somewhere else was
  // the slowest thing this tool asked of anyone.
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    // Headless Chromium has no clipboard permission; the button's job is to
    // hand the right value over, which is what this checks.
    await ctx.page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.__copied = text; } },
      });
    });

    const first = await ctx.page.textContent('#rowBody .lead:first-child .lead-phone');
    await ctx.page.click('#rowBody .lead:first-child .lead-phone');
    await ctx.page.waitForTimeout(200);

    assert.equal(await ctx.page.evaluate(() => window.__copied), first);
    // A copy with no confirmation reads as a click that did nothing.
    assert.equal(await ctx.page.isVisible('#toast'), true);
  } finally {
    await ctx.close();
  }
});

test('a person reads as a person, and the name copies their profile link', async (t) => {
  const ctx = await openPanel(t, { linkedin: true });
  if (!ctx) return;
  try {
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    const first = ctx.page.locator('#rowBody .lead:first-child');
    assert.equal(await first.locator('.lead-name').textContent(), 'Priya Sharma 0');
    assert.match(await first.locator('.lead-headline').textContent(), /ServiceNow Architect/);
    assert.match(await first.locator('.lead-area').textContent(), /Tata Consultancy Services · Chennai/);

    await ctx.page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.__copied = text; } },
      });
    });
    await first.locator('.lead-name').click();
    await ctx.page.waitForTimeout(200);
    assert.equal(
      await ctx.page.evaluate(() => window.__copied),
      'https://www.linkedin.com/in/priya-sharma-0'
    );
  } finally {
    await ctx.close();
  }
});

test('a people search asks how many profiles, where you can see it', async (t) => {
  // A people search has no grid, so this number is the only thing that decides
  // how much it collects — and it was under "More options", which is where you
  // put a setting nobody needs to touch.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    // Maps: the grid decides, so the limit stays in the disclosure.
    assert.equal(await ctx.page.isVisible('#coverageRow'), true);
    assert.equal(await ctx.page.isVisible('#maxResults'), false);

    await ctx.page.click('#sourceGroup label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(200);

    assert.equal(await ctx.page.isVisible('#coverageRow'), false, 'no grid for a people search');
    assert.equal(await ctx.page.isVisible('#maxResults'), true, 'so ask the question that applies');
    assert.match(await ctx.page.textContent('#limitLabel'), /how many profiles/i);

    // It is the same setting, wherever it is standing.
    await ctx.page.fill('#maxResults', '250');
    await ctx.page.waitForTimeout(500);
    assert.equal(
      await ctx.page.evaluate(() => window.__storage['mls.settings'].maxResults),
      250
    );

    // Back to Maps and it goes back where it came from, still holding 250.
    await ctx.page.click('#sourceGroup label.seg:has(input[value="maps"])');
    await ctx.page.waitForTimeout(200);
    assert.equal(await ctx.page.isVisible('#maxResults'), false);
    assert.equal(await ctx.page.inputValue('#maxResults'), '250');
  } finally {
    await ctx.close();
  }
});

test('the town list narrows from a country to a state', async (t) => {
  // "Where?" was a text field. You cannot browse a text field, and a town you
  // half remember the spelling of is a run that finds nothing.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    const state = () =>
      ctx.page.evaluate(() => ({
        regionHidden: document.getElementById('region').hidden,
        regions: document.getElementById('region').options.length,
        towns: document.getElementById('cityOptions').options.length,
        first: (document.getElementById('cityOptions').options[0] || {}).value,
      }));

    // Nothing chosen is the behaviour this replaced: a box you type into.
    const fresh = await state();
    assert.ok(await ctx.page.locator('#country option').count() > 200, 'the world is offered');
    assert.equal(fresh.regionHidden, true, 'no country, no states');
    assert.equal(fresh.towns, 0, 'and nothing to suggest');

    await ctx.page.selectOption('#country', 'IN');
    await ctx.page.waitForTimeout(700);
    const india = await state();
    assert.equal(india.regionHidden, false);
    assert.ok(india.regions > 25, `expected India's states, got ${india.regions - 1}`);
    assert.ok(india.towns > 100, 'a country on its own still suggests towns');

    await ctx.page.selectOption('#region', 'Tamil Nadu');
    await ctx.page.waitForTimeout(300);
    const tn = await state();
    assert.ok(tn.towns < india.towns, 'a state narrows the list');
    assert.match(tn.first, /, Tamil Nadu$/, 'and every town in it is in that state');
  } finally {
    await ctx.close();
  }
});

test('a town is offered as the exact text that will be searched', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    await ctx.page.selectOption('#country', 'IN');
    await ctx.page.waitForTimeout(700);
    await ctx.page.selectOption('#region', 'Tamil Nadu');
    await ctx.page.waitForTimeout(300);

    const towns = () =>
      ctx.page.evaluate(() =>
        [...document.getElementById('cityOptions').options].map((o) => o.value)
      );

    // Maps: "dentists in Chennai, Tamil Nadu" is one place. "Springfield" is
    // twenty.
    assert.ok((await towns()).includes('Chennai, Tamil Nadu'));

    await ctx.page.click('#sourceGroup label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(400);
    // LinkedIn matches keywords literally: no profile contains "Tamil Nadu"
    // just because the person is in Chennai.
    const people = await towns();
    assert.ok(people.includes('Chennai'));
    assert.ok(!people.some((name) => name.includes(',')));
  } finally {
    await ctx.close();
  }
});

test('the picker only fills the box — typing a town still runs it', async (t) => {
  // The whole design rests on this: nothing downstream knows a picker exists,
  // so a place you type and a place you browse to are the same run.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    await ctx.page.evaluate(() => {
      window.__started = null;
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async (m) => {
        if (m.type === 'START_JOB') window.__started = m.config;
        return send(m);
      };
    });

    await ctx.page.fill('#category', 'dentists');
    await ctx.page.fill('#city', 'Kumbakonam');
    await ctx.page.click('#start');
    await ctx.page.waitForTimeout(400);

    const config = await ctx.page.evaluate(() => window.__started);
    assert.equal(config.city, 'Kumbakonam', 'what is in the box is what runs');
    assert.equal(config.country, '', 'and no country was needed to get there');
  } finally {
    await ctx.close();
  }
});

test('LinkedIn’s own filters are offered — and only the ones ever observed', async (t) => {
  // A place in `keywords` is not a location filter: it is a word LinkedIn
  // hunts for anywhere in a profile, which is why searching Theni returned
  // people in Coimbatore. These are the real ones, and they take LinkedIn's
  // internal ids — so the list holds only what has actually been seen.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.isVisible('#liFilters'), false, 'Maps has no such thing');

    await ctx.page.click('#sourceGroup label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(250);
    assert.equal(await ctx.page.isVisible('#liFilters'), true);
    assert.equal(await ctx.page.isVisible('#placeRow'), false, 'one location control, not two');

    await ctx.page.fill('#geoInput', 'India');
    await ctx.page.click('#geoAdd');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.textContent('#geoChips'), 'India✕');

    // The important half: a name LinkedIn does not offer is refused, and what
    // it *does* offer is shown so the choice stays with the user. Guessing an
    // id would search somewhere else and hand back a spreadsheet that looks
    // perfectly right.
    await ctx.page.evaluate(() => {
      window.__resolve = {
        ok: false,
        reason: 'LinkedIn does not offer “Munnar”',
        offered: ['Idukki, Kerala, India', 'Kerala, India'],
      };
    });
    await ctx.page.fill('#geoInput', 'Munnar');
    await ctx.page.click('#geoAdd');
    await ctx.page.waitForTimeout(300);
    assert.match(await ctx.page.textContent('#geoHelp'), /does not offer/i);
    assert.match(await ctx.page.textContent('#geoHelp'), /Idukki, Kerala, India/);
    assert.equal(await ctx.page.textContent('#geoChips'), 'India✕', 'and nothing was added');

    // And pressing Start says the actual reason, not "see the message under
    // it" — that field had scrolled out of the panel when this was written.
    await ctx.page.fill('#category', 'kotlin');
    await ctx.page.click('#start');
    await ctx.page.waitForTimeout(400);
    assert.match(await ctx.page.textContent('#error'), /does not offer/i);

    // And the resting state says where the list comes from. A list of one
    // reads as a broken feature unless it is clear what fills it.
    await ctx.page.fill('#geoInput', 'India');
    await ctx.page.click('#geoAdd');
    await ctx.page.waitForTimeout(200);
    assert.match(await ctx.page.textContent('#geoHelp'), /learns these from LinkedIn/i);
  } finally {
    await ctx.close();
  }
});

test('a name LeadMine does not know is asked of LinkedIn, once', async (t) => {
  // Making the user go and apply every filter by hand first is a chore, and
  // it is one the page can do itself: the filter panel's typeahead is
  // LinkedIn's own resolver.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    await ctx.page.click('#sourceGroup label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(250);

    await ctx.page.evaluate(() => {
      window.__resolve = {
        ok: true,
        facet: 'geoUrn',
        id: '102784390',
        label: 'Chennai, Tamil Nadu, India',
      };
    });
    await ctx.page.fill('#geoInput', 'chennai');
    await ctx.page.click('#geoAdd');
    await ctx.page.waitForTimeout(300);

    assert.deepEqual(await ctx.page.evaluate(() => window.__resolveAsked), {
      facet: 'geoUrn',
      label: 'chennai',
    });
    // LinkedIn's own wording, not what was typed — that is the thing being
    // filtered on, and showing anything else would be a lie about the run.
    assert.equal(await ctx.page.textContent('#geoChips'), 'Chennai, Tamil Nadu, India✕');

    // And it was learned, so the next time costs nothing.
    const known = await ctx.page.evaluate(() => window.__storage['mls.urns']);
    assert.equal(known.geoUrn['chennai, tamil nadu, india'].id, '102784390');
  } finally {
    await ctx.close();
  }
});

test('a chosen filter reaches the run as an id, not as a word', async (t) => {
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    await ctx.page.evaluate(() => {
      window.__started = null;
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async (m) => {
        if (m.type === 'START_JOB') window.__started = m.config;
        return send(m);
      };
    });

    await ctx.page.click('#sourceGroup label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(250);
    await ctx.page.fill('#category', 'kotlin');
    await ctx.page.fill('#geoInput', 'India');
    await ctx.page.click('#geoAdd');
    await ctx.page.fill('#svcInput', 'Corporate Training');
    await ctx.page.click('#svcAdd');
    await ctx.page.waitForTimeout(200);

    // A real location filter makes the free-text place meaningless, and a box
    // that is silently ignored is a box people fill in and then distrust.
    assert.equal(await ctx.page.isDisabled('#city'), true);
    assert.equal(await ctx.page.isVisible('#cityIgnored'), true);

    await ctx.page.click('#start');
    await ctx.page.waitForTimeout(400);

    const config = await ctx.page.evaluate(() => window.__started);
    assert.deepEqual(config.facets.geoUrn, ['102713980'], 'the id, seen on a live page');
    assert.deepEqual(config.facets.serviceCategory, ['20016']);
    assert.deepEqual(config.facetLabels.geoUrn, ['India'], 'the label, for the records');
  } finally {
    await ctx.close();
  }
});

test('splitting is offered only when there is something to split', async (t) => {
  // A second place, learned the way a real run would have learned it.
  const ctx = await openPanel(t, {
    idle: true,
    urns: { geoUrn: { theni: { id: '101138777', label: 'Theni' } } },
  });
  if (!ctx) return;
  try {
    await ctx.page.click('#sourceGroup label.seg:has(input[value="linkedin"])');
    await ctx.page.waitForTimeout(250);
    assert.equal(await ctx.page.isVisible('#optSplit'), false, 'nothing chosen, nothing to split');

    for (const place of ['India', 'Theni']) {
      await ctx.page.fill('#geoInput', place);
      await ctx.page.click('#geoAdd');
      await ctx.page.waitForTimeout(150);
    }
    assert.equal(await ctx.page.isVisible('#optSplit'), true, 'two places, one search each');
  } finally {
    await ctx.close();
  }
});

test('an active narrowing filter rides beside the button that acts on it', async (t) => {
  // The filter is saved between runs. A term typed weeks ago silently set
  // aside all 235 results of a search planned today, and the form gave no
  // sign it was there — an input holding a value just looks like an input.
  //
  // The first fix was a warning inside the form, which scrolled away with the
  // form. This one is a chip in the action bar, which does not.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.isVisible('#filterChip'), false, 'no filter, no noise');

    await ctx.page.fill('#categoryFilter', 'housekeeping');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.isVisible('#filterChip'), true);
    assert.match(await ctx.page.textContent('#filterChip'), /category matches “housekeeping”/);

    // The way out is the chip itself.
    await ctx.page.click('#filterChip');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.inputValue('#categoryFilter'), '');
    assert.equal(await ctx.page.isVisible('#filterChip'), false);
  } finally {
    await ctx.close();
  }
});

test('New search leaves the finished run behind instead of repainting it', async (t) => {
  // The panel polls the worker every two seconds, so a finished job's error
  // and its zeroes were painted straight back over the form.
  const ctx = await openPanel(t);
  if (!ctx) return;
  try {
    await ctx.page.evaluate(() => {
      const job = {
        status: 'done', phase: 'done', jobId: 'job-1', count: 0,
        tasksSettled: 10, tasksTotal: 10,
        message: '0 businesses from 10 searches, 1 of them failed.',
        taskError: 'The page keeping the extension port is moved into back/forward cache.',
      };
      chrome.runtime.sendMessage = async (m) =>
        m.type === 'GET_JOB' ? { ok: true, job, seen: 0 } : { ok: true };
    });
    await ctx.page.waitForTimeout(100);

    assert.equal(await ctx.page.isVisible('#runView'), true);
    await ctx.page.click('#again');
    await ctx.page.waitForTimeout(150);

    assert.equal(await ctx.page.isVisible('#form'), true);
    assert.equal(await ctx.page.isVisible('#error'), false);

    // The next poll must not undo it.
    await ctx.page.waitForTimeout(2500);
    assert.equal(await ctx.page.isVisible('#form'), true, 'the poll repainted the old run');
    assert.equal(await ctx.page.isVisible('#error'), false);
  } finally {
    await ctx.close();
  }
});

test('the panel shows which version is loaded', async (t) => {
  // Reloading an unpacked extension gives no feedback inside the panel, so
  // "did my reload land?" meant opening chrome://extensions to find out.
  const ctx = await openPanel(t, { idle: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.textContent('#version'), 'v9.9.9');
    assert.equal(await ctx.page.isVisible('#version'), true);
  } finally {
    await ctx.close();
  }
});

test('a panel with no manifest to read still loads', async (t) => {
  // The version is a convenience; it must never be what breaks the panel.
  const ctx = await openPanel(t, { idle: true, noManifest: true });
  if (!ctx) return;
  try {
    assert.deepEqual(ctx.errors, [], 'a missing manifest must not throw');
    assert.equal(await ctx.page.textContent('#version'), '');
    assert.equal(await ctx.page.isVisible('#form'), true, 'and the form still works');
  } finally {
    await ctx.close();
  }
});

test('a finished run does not reclaim the screen after a restart', async (t) => {
  // The live symptom: pull, reload, reopen — and the same dead run's error is
  // still there, so the reload looks like it did nothing.
  const ctx = await openPanel(t, { stale: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.isVisible('#form'), true, 'the form is what you need on a reload');
    assert.equal(await ctx.page.isVisible('#runView'), false);
    assert.equal(await ctx.page.isVisible('#error'), false, 'a dead run’s error is not news');
    // The chip reports the run on screen. With the form on screen it reported
    // "Done" over a search nobody had run, which reads as this one finishing.
    assert.equal(await ctx.page.isVisible('#statusPill'), false, 'no status for a run you left');
    assert.equal(await ctx.page.isVisible('#start'), true, 'Start is the action again');

    // The results are still there, and the tab count is the way back to them.
    assert.equal(await ctx.page.textContent('#tabCount'), '2,400');
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);
    assert.match(await ctx.page.textContent('#rowNote'), /2,400 rows/);
  } finally {
    await ctx.close();
  }
});

test('a paused run still keeps the screen, because Resume lives there', async (t) => {
  const ctx = await openPanel(t, { paused: true });
  if (!ctx) return;
  try {
    assert.equal(await ctx.page.isVisible('#runView'), true);
    assert.equal(await ctx.page.isVisible('#resume'), true, 'stranding a resumable run would be worse');
  } finally {
    await ctx.close();
  }
});
