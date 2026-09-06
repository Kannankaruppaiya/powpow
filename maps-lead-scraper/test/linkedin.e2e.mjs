/**
 * Browser test for the LinkedIn People adapter.
 *
 * Runs the real content scripts in Chromium against a synthetic page shaped
 * like a LinkedIn People search — NOT against linkedin.com. The fixture
 * reproduces the two behaviours that actually make the adapter hard:
 * results hydrate lazily as you scroll (so early rounds see empty skeletons),
 * and the user can change the search underneath a run.
 *
 * Run with: npm run test:dom
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_SCRIPTS = [
  'src/lib/parse.js',
  'src/content/engine.js',
  'src/content/adapters/maps.js',
  'src/content/adapters/linkedin.js',
].map((f) => readFileSync(join(ROOT, f), 'utf8'));

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

const PEOPLE = [
  {
    slug: 'priya-sharma', name: 'Priya Sharma',
    headline: 'Staff Software Engineer at Acme Corp',
    location: 'Chennai, Tamil Nadu, India', degree: '2nd', openToWork: true,
  },
  {
    slug: 'raj-kumar', name: 'Raj Kumar',
    headline: 'Java Developer at Globex',
    location: 'Coimbatore, Tamil Nadu, India', degree: '1st', openToWork: false,
  },
  {
    // No "at Company" in the headline — company must come back empty, not wrong.
    slug: 'anita-r', name: 'Anita R',
    headline: 'Independent Consultant',
    location: 'Bengaluru, Karnataka, India', degree: '3rd+', openToWork: false,
  },
];

/**
 * A page that hydrates its list in pages of two, the way LinkedIn does.
 *
 * Deliberately shaped like the live site rather than like the adapter:
 *   - no `reusable-search__entity-result-list` or other nameable hooks, since
 *     those are build output that changed under us on the real site;
 *   - a second profile link per card ("X is a mutual connection"), which must
 *     not be mistaken for the person the card is about;
 *   - a promo card injected mid-list, which has no profile link at all;
 *   - a profile link in the top navigation, outside the results.
 */
function fixture() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { height: 3000px; margin: 0; }
  </style></head><body>
  <nav>
    <a href="https://www.linkedin.com/in/kannan-the-viewer/">Me</a>
  </nav>
  <main>
    <div>
      <button aria-pressed="true"
              aria-label="Locations filter. Clicking this button displays all Locations options.">Locations</button>
      <button aria-pressed="false" aria-label="Current company filter.">Current company</button>
    </div>
    <div class="AbC123">
      <ul role="list"></ul>
    </div>
  </main>
  <script>
    const DATA = ${JSON.stringify(PEOPLE)};
    const list = document.querySelector('ul[role="list"]');
    let hydrated = 0;

    // Skeletons exist up front; content arrives later, as on the real site.
    for (let i = 0; i < DATA.length; i += 1) list.appendChild(document.createElement('li'));

    // A promo card LinkedIn injects between results.
    const promo = document.createElement('li');
    promo.innerHTML = '<div><h2>Easily find people who are actively hiring</h2>' +
      '<a href="/premium">Get Premium now</a></div>';
    list.insertBefore(promo, list.children[2] || null);

    function hydrate(n) {
      const cards = [...list.children].filter((li) => !li.querySelector('a[href="/premium"]'));
      for (let i = hydrated; i < Math.min(hydrated + n, DATA.length); i += 1) {
        const p = DATA[i];
        cards[i].innerHTML = \`
          <div class="XyZ789">
            <img src="https://media.licdn.com/photo\${i}.jpg"
                 alt="\${p.openToWork ? p.name + ', #OPEN_TO_WORK' : p.name}">
            <span>
              <a href="https://www.linkedin.com/in/\${p.slug}?miniProfileUrn=xyz">
                <span aria-hidden="true">\${p.name}</span>
                <span class="visually-hidden">View \${p.name}'s profile</span>
              </a>
            </span>
            <span class="entity-result__badge-text">· \${p.degree}</span>
            <div class="entity-result__primary-subtitle">\${p.headline}</div>
            <div class="entity-result__secondary-subtitle">\${p.location}</div>
            <p class="entity-result__summary">Current: \${p.headline}</p>
            <div>
              <a href="https://www.linkedin.com/in/mutual-friend-\${i}/">Deepa Maurya</a>
              is a mutual connection
            </div>
          </div>\`;
      }
      hydrated = Math.min(hydrated + n, DATA.length);
    }

    hydrate(2);                       // first page renders immediately
    window.addEventListener('scroll', () => hydrate(1), { passive: true });
  </script>
  </body></html>`;
}

const CHROME_STUB = `
  window.__progress = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__listener = fn; } },
      sendMessage: (msg) => { window.__progress.push(msg); },
    },
  };
`;

async function run(t, { url, config = {}, mutate } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    t.skip('playwright-core is not installed (npm i -D playwright-core)');
    return null;
  }

  const bin = findChromium();
  const browser = await chromium.launch({ headless: true, ...(bin ? { executablePath: bin } : {}) });
  const page = await browser.newPage();

  await page.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixture() })
  );
  await page.goto(
    url || 'https://www.linkedin.com/search/results/people/?keywords=java%20developer&geoUrn=%5B%22102713980%22%5D'
  );
  await page.addScriptTag({ content: CHROME_STUB });
  for (const src of CONTENT_SCRIPTS) await page.addScriptTag({ content: src });

  if (mutate) await mutate(page);

  const result = await page.evaluate(
    (cfg) =>
      new Promise((resolve) => {
        window.__listener({ type: 'RUN_SCRAPE', config: cfg }, {}, resolve);
      }),
    { scrollDelay: 150, deep: false, ...config }
  );

  await browser.close();
  return result;
}

test('the LinkedIn adapter is chosen for a People search URL', async (t) => {
  const result = await run(t);
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  assert.ok(result.records.every((r) => r.source === 'linkedin'));
});

test('lazily hydrated results are all collected', async (t) => {
  const result = await run(t);
  if (!result) return;
  // Only two of three are rendered at load; the third arrives on scroll.
  assert.equal(result.records.length, 3, 'the scroll loop must pick up late arrivals');
});

test('each person’s fields are read off the card', async (t) => {
  const result = await run(t);
  if (!result) return;

  const priya = result.records.find((r) => r.name === 'Priya Sharma');
  assert.ok(priya, 'name should come from the aria-hidden span, not the screen-reader copy');
  assert.equal(priya.headline, 'Staff Software Engineer at Acme Corp');
  assert.equal(priya.company, 'Acme Corp', 'company is split off the headline');
  assert.equal(priya.location, 'Chennai, Tamil Nadu, India');
  assert.equal(priya.degree, '2nd');
  assert.equal(priya.openToWork, 'Yes');
  assert.equal(priya.profileUrl, 'https://www.linkedin.com/in/priya-sharma', 'tracking params stripped');
});

test('a headline with no company leaves the column empty rather than guessing', async (t) => {
  const result = await run(t);
  if (!result) return;
  const anita = result.records.find((r) => r.name === 'Anita R');
  assert.equal(anita.headline, 'Independent Consultant');
  assert.equal(anita.company, '');
  assert.equal(anita.degree, '3rd+');
  assert.equal(anita.openToWork, '', 'only a real badge should set this');
});

test('the active filters and query are read off the page', async (t) => {
  const result = await run(t);
  if (!result) return;
  assert.equal(result.context.query, 'java developer');
  // The applied pill and the URL facet, not a hardcoded list.
  assert.ok(result.context.filters.Locations, 'an applied pill should be reported');
  assert.equal(result.context.filters['Current company'], undefined, 'an unapplied pill should not');
  assert.ok(result.context.filters.geoUrn, 'a URL facet should be reported');
});

test('a signed-out page stops the run with a clear reason', async (t) => {
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        const form = document.createElement('form');
        form.className = 'login__form';
        document.body.appendChild(form);
      });
    },
  });
  if (!result) return;
  assert.equal(result.ok, false);
  assert.match(result.error, /signed out of LinkedIn/i);
});

test('a security check stops the run rather than scraping a captcha page', async (t) => {
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        const el = document.createElement('div');
        el.id = 'captcha-internal';
        document.body.appendChild(el);
      });
    },
  });
  if (!result) return;
  assert.equal(result.ok, false);
  assert.match(result.error, /security check/i);
});

test('maxResults is honoured', async (t) => {
  const result = await run(t, { config: { maxResults: 2 } });
  if (!result) return;
  assert.equal(result.records.length, 2);
});

test('a Maps URL does not select the LinkedIn adapter', async (t) => {
  const result = await run(t, { url: 'https://www.linkedin.com/feed/' });
  if (!result) return;
  assert.equal(result.ok, false);
  assert.match(result.error, /not a supported search results page/i);
});

test('the results list is found by shape, without relying on class names', async (t) => {
  // The fixture carries none of the class hooks the adapter used to name; if
  // this passes, a LinkedIn rename cannot silently return zero results again.
  const result = await run(t);
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.records.length, 3);
});

test('a mutual-connection link is not mistaken for the result', async (t) => {
  const result = await run(t);
  if (!result) return;
  const urls = result.records.map((r) => r.profileUrl);
  assert.ok(!urls.some((u) => u.includes('mutual-friend')), 'mutual connections must not become rows');
  assert.ok(urls.includes('https://www.linkedin.com/in/priya-sharma'));
});

test('a promo card in the middle of the list is skipped', async (t) => {
  const result = await run(t);
  if (!result) return;
  assert.ok(!result.records.some((r) => /Premium|actively hiring/i.test(r.name)));
});

test('a profile link in the navigation is not scraped as a result', async (t) => {
  const result = await run(t);
  if (!result) return;
  assert.ok(!result.records.some((r) => r.profileUrl.includes('kannan-the-viewer')));
});
