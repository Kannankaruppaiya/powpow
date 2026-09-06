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
      sendMessage: async (m) => (m.type === 'GET_JOB' ? { ok: true, job, seen: 0 } : { ok: true }),
      onMessage: { addListener: () => {} },
    },
    downloads: { download: async () => {} },
  };

  // Stand in for Gemini/Groq. The test sets window.__aiNext before clicking.
  window.__aiCalls = [];
  window.__aiNext = { status: 200, body: {} };
  window.fetch = async (url, init) => {
    window.__aiCalls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = window.__aiNext;
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

async function openPanel(t, { idle = false, paused = false, aiKey = '' } = {}) {
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
  if (aiKey) {
    // Deliberately the shape an older build wrote — one key, no provider — so
    // the migration path is exercised on every planner test.
    await page.addInitScript((key) => {
      window.__storage = { 'mls.ai': { provider: 'gemini', key, model: '' } };
    }, aiKey);
  }
  await page.addInitScript(SETUP, idle ? 0 : TOTAL);
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

    const rendered = await ctx.page.locator('#rowBody tr').count();
    assert.ok(rendered > 5, `expected some rows, got ${rendered}`);
    assert.ok(rendered < 60, `expected a small window, got ${rendered} of ${TOTAL} in the DOM`);

    // The scroll height must still reflect the whole set.
    const spacer = await ctx.page.evaluate(() => document.getElementById('spacer').offsetHeight);
    assert.equal(spacer, TOTAL * 32, 'the spacer should size the scrollbar to every row');
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

    const firstBefore = await ctx.page.textContent('#rowBody tr:first-child .c-name');
    assert.equal(firstBefore, 'Clinic 0');

    await ctx.page.evaluate(() => {
      document.getElementById('viewport').scrollTop = 32 * 1000;
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
    await ctx.page.click('#viewResults');
    await ctx.page.waitForTimeout(400);

    await ctx.page.fill('#filter', 'Adyar');
    await ctx.page.waitForTimeout(300);

    const note = await ctx.page.textContent('#rowNote');
    assert.match(note, /600 of 2,400 rows/, 'one area in four should be 600 rows');

    const names = await ctx.page.locator('#rowBody tr .c-area').allTextContents();
    assert.ok(names.every((a) => a === 'Adyar'), 'every visible row should match the filter');

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
    const bad = await ctx.page.locator('#rowBody td.c-email.bad').count();
    assert.ok(bad > 0, 'a no-mx address should be flagged in the table');
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

    await ctx.page.click('label.choice:has(input[value="off"])');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.inputValue('#grid'), 'off');

    await ctx.page.click('label.choice:has(input[value="exhaustive"])');
    await ctx.page.waitForTimeout(150);
    assert.equal(await ctx.page.inputValue('#grid'), 'exhaustive');
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
    assert.equal(
      await ctx.page.textContent('#limitLabel'),
      'Stop after this many profiles'
    );
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
    assert.equal(await paused.page.getAttribute('#resume', 'class'), 'btn btn--primary');
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
    assert.equal(await ctx.page.isVisible('#assist'), true, 'the offer has to be visible to be used');
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

test('the model box is out of the way until it is asked for', async (t) => {
  const ctx = await openPanel(t, { idle: true, aiKey: 'AIza-test' });
  if (!ctx) return;
  try {
    await openAdvanced(ctx);
    // An unlabelled box under the key box is a box people paste keys into.
    assert.equal(await ctx.page.isVisible('#aiModel'), false);
    assert.equal(await ctx.page.isVisible('#aiModelToggle'), true);

    await ctx.page.click('#aiModelToggle');
    assert.equal(await ctx.page.isVisible('#aiModel'), true);
    assert.equal(await ctx.page.getAttribute('#aiModel', 'placeholder'), 'gemini-2.5-flash');
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
