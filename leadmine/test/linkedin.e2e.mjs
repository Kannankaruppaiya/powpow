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

/*
 * Three pages, not two.
 *
 * With two, "stopped after page two" and "finished" produce the same rows, so
 * the fixture could not tell them apart — which is exactly the bug the live
 * run had, and exactly what a two-page fixture is blind to.
 */
const PAGE_THREE = [
  {
    slug: 'arun-p', name: 'Arun P',
    headline: 'Site Reliability Engineer at Soylent',
    location: 'Kochi, Kerala, India', degree: '2nd', openToWork: false,
  },
  {
    slug: 'divya-n', name: 'Divya N',
    headline: 'Data Engineer at Cyberdyne',
    location: 'Mysuru, Karnataka, India', degree: '2nd', openToWork: false,
  },
];

const PAGE_TWO = [
  {
    slug: 'vikram-s', name: 'Vikram S',
    headline: 'Backend Engineer at Initech',
    location: 'Hyderabad, Telangana, India', degree: '2nd', openToWork: false,
  },
  {
    slug: 'meera-t', name: 'Meera T',
    headline: 'Platform Engineer at Umbrella',
    location: 'Pune, Maharashtra, India', degree: '3rd+', openToWork: true,
  },
];

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
  {
    // Copied from a real card in the user's export. The headline is full of
    // commas and pipes, so anything matching "a location is comma-separated"
    // naively puts a job title in the Location column.
    slug: 'anubha-goel', name: 'Anubha Goel',
    // The other shape of the duplicate: link text for assistive tech rather
    // than a second copy of the bare name.
    sr: "View Anubha Goel's profile",
    headline: 'Technical Corporate Trainer|C,C++,Java FSD,Python FSD,DSA',
    current: 'Technical Trainer at Oracle',
    location: 'Delhi, India', degree: '2nd', openToWork: false,
  },
];

/**
 * A page that hydrates its list in pages of two, the way LinkedIn does.
 *
 * Deliberately shaped like the live site rather than like the adapter:
 *   - no `reusable-search__entity-result-list` or other nameable hooks, since
 *     those are build output that changed under us on the real site;
 *   - the whole card wrapped inside the /in/ profile link, and the name
 *     printed twice inside it (visible, then for screen readers) — this is
 *     what the user's export caught, and it is why reading the anchor's text
 *     put the entire card, name doubled, into the Name column;
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
    <div class="artdeco-pagination">
      <button id="prev" aria-label="Previous" disabled>Previous</button>
      <button id="next" aria-label="Next">Next</button>
    </div>
  </main>
  <script>
    const PAGES = [${JSON.stringify(PEOPLE)}, ${JSON.stringify(PAGE_TWO)}, ${JSON.stringify(PAGE_THREE)}];
    let page = 0;
    let DATA = PAGES[0];
    let list = document.querySelector('ul[role="list"]');
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
        // The anchor wraps the entire card, and carries no class the scraper
        // could name — exactly the markup the live export revealed.
        cards[i].innerHTML = \`
          <div class="XyZ789">
            <a href="https://www.linkedin.com/in/\${p.slug}?miniProfileUrn=xyz">
              <div><img src="https://media.licdn.com/photo\${i}.jpg"
                        alt="\${p.openToWork ? p.name + ', #OPEN_TO_WORK' : p.name}"></div>
              <div><span aria-hidden="true">\${p.name}</span><span>\${
                p.sr || p.name}</span><span> • \${p.degree}</span></div>
              <div>\${p.headline}</div>
              <div>\${p.location}</div>
              <div>Current: \${p.current || p.headline}</div>
            </a>
            <div>
              <a href="https://www.linkedin.com/in/mutual-friend-\${i}/">Deepa Maurya</a>
              is a mutual connection
            </div>
            <button>Connect</button>
          </div>\`;
      }
      hydrated = Math.min(hydrated + n, DATA.length);
    }

    hydrate(2);                       // first page renders immediately
    // Scrolling to the foot of the page brings a screenful into view, not one
    // card. Hydrating a single card per event would mean the run only ever
    // completes if it scrolls once per remaining result.
    window.addEventListener('scroll', () => hydrate(2), { passive: true });

    // Paging replaces the results wholesale, exactly as LinkedIn does — which
    // detaches whatever node the scraper was holding.
    document.getElementById('next').addEventListener('click', () => {
      if (page >= PAGES.length - 1) return;
      page += 1;
      // Paging rewrites the URL, and not only with "page": LinkedIn appends
      // its own tracking and session parameters. This is what used to change
      // the search fingerprint and end every run at page two.
      history.replaceState(null, '', location.pathname + location.search +
        '&page=' + (page + 1) + '&searchId=' + Date.now() + '&heroEntityKey=urn%3Ali%3Afsd_profile%3AABC');
      DATA = PAGES[page];
      hydrated = 0;
      const fresh = document.createElement('ul');
      fresh.setAttribute('role', 'list');
      for (let i = 0; i < DATA.length; i += 1) fresh.appendChild(document.createElement('li'));
      list.replaceWith(fresh);
      list = fresh;
      hydrate(DATA.length);
      if (page >= PAGES.length - 1) document.getElementById('next').remove();
    });
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

async function run(t, { url, config = {}, mutate, instead } = {}) {
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

  // Some tests drive something other than a scrape — resolving a filter, for
  // instance, which is a lookup rather than a run.
  const result = instead
    ? await instead(page)
    : await page.evaluate(
        (cfg) =>
          new Promise((resolve) => {
            window.__listener({ type: 'RUN_SCRAPE', config: cfg }, {}, resolve);
          }),
        { scrollDelay: 150, deep: false, ...config }
      );

  await browser.close();
  return result;
}

/**
 * A stand-in for LinkedIn's Locations filter, hostile in the ways the real one
 * is: hashed class names, a panel rendered as a portal at the end of the
 * document rather than inside the pill, and options that arrive ~300ms after
 * typing because the typeahead is network-backed.
 */
const FILTER_PANEL = (catalog) => {
  // The page already has a Locations pill — the one readPills was written
  // against. Adding a second would mean the adapter picks the inert first
  // one, which is exactly what it should do.
  const pill = [...document.querySelectorAll('button')].find((b) =>
    /^locations\b/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())
  );
  if (!pill) throw new Error('the fixture has no Locations pill to drive');

  let open = null;
  pill.addEventListener('click', () => {
    if (open) {
      open.remove();
      open = null;
      return;
    }
    const panel = document.createElement('div');
    panel.className = 'q2b8';
    panel.innerHTML =
      '<input type="text" placeholder="Add a location">' +
      '<div class="opts"></div>' +
      '<button class="zz">Show results</button>';
    // A portal: anything scoped to the pill's subtree finds nothing.
    document.body.appendChild(panel);
    open = panel;

    // Show results does what LinkedIn's does: writes the chosen ids into the
    // URL. That is the whole reason no id has to be known in advance.
    panel.querySelector('.zz').addEventListener('click', () => {
      const picked = [...opts.querySelectorAll('input:checked')].map((i) => i.value);
      const next = new URL(location.href);
      const existing = JSON.parse(next.searchParams.get('geoUrn') || '[]');
      const merged = [...new Set([...existing, ...picked])];
      if (merged.length) next.searchParams.set('geoUrn', JSON.stringify(merged));
      history.pushState({}, '', next);
      panel.remove();
      open = null;
    });

    const box = panel.querySelector('input[type=text]');
    const opts = panel.querySelector('.opts');
    let timer = null;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      opts.replaceChildren();
      const q = box.value.trim().toLowerCase();
      if (q.length < 2) return;
      timer = setTimeout(() => {
        for (const [id, label] of catalog.filter(([, l]) => l.toLowerCase().includes(q))) {
          opts.insertAdjacentHTML(
            'beforeend',
            `<input type="checkbox" id="c_${id}" value="${id}">` +
              `<label for="c_${id}">${label}</label>`
          );
        }
      }, 300);
    });
  });
};

const CATALOG = [
  ['102713980', 'India'],
  ['102784390', 'Chennai, Tamil Nadu, India'],
  ['101138777', 'Theni, Tamil Nadu, India'],
  ['106164952', 'Tamil Nadu, India'],
];

async function resolve(t, want, catalog = CATALOG) {
  return run(t, {
    mutate: async (page) => {
      await page.evaluate(
        ([source, list]) => {
          // eslint-disable-next-line no-new-func
          new Function('catalog', `(${source})(catalog)`)(list);
        },
        [FILTER_PANEL.toString(), catalog]
      );
    },
    // The resolve happens instead of a scrape.
    instead: async (page) => {
      const built = await page.evaluate(() => ({
        pill: Boolean(document.querySelector('button[aria-label^="Locations filter"]')),
        panels: document.querySelectorAll('.q2b8').length,
      }));
      if (!built.pill) throw new Error('fixture pill was never built');
      return page.evaluate(
        (w) =>
          new Promise((done) => {
            window.__listener({ type: 'RESOLVE_FACET', want: w }, {}, done);
          }),
        want
      );
    },
  });
}

test('a filter with no known id is applied by driving LinkedIn’s own panel', async (t) => {
  // This is what makes an unknown place usable at all. `geoUrn` takes
  // LinkedIn's internal number, which is undocumented — so rather than
  // building a URL out of one, the run types the name into LinkedIn's filter,
  // ticks what comes back and presses Show results. LinkedIn writes the URL.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(
        ([source, list]) => {
          // eslint-disable-next-line no-new-func
          new Function('catalog', `(${source})(catalog)`)(list);
        },
        [FILTER_PANEL.toString(), CATALOG]
      );
    },
    instead: (page) =>
      page.evaluate(
        () =>
          new Promise((done) => {
            window.__listener(
              { type: 'APPLY_FILTERS', wants: [{ facet: 'geoUrn', label: 'chennai' }] },
              {},
              done
            );
          })
      ),
  });
  if (!result) return;

  assert.equal(result.ok, true, result.reason);
  // The URL LinkedIn wrote, carrying the id nobody had to know. It merges
  // with what the page already had, exactly as the real one does.
  assert.match(result.url, /102784390/);
  assert.match(result.url, /geoUrn=/);
  // And the pairing is handed back, so the same search is a plain URL next
  // time and drives nothing.
  assert.deepEqual(result.applied, [
    { facet: 'geoUrn', id: '102784390', label: 'Chennai, Tamil Nadu, India' },
  ]);
});

test('a filter that cannot be applied fails loudly rather than running unfiltered', async (t) => {
  // Scraping on regardless would hand back a spreadsheet of the wrong people
  // that looks entirely right — the failure this whole design exists to avoid.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(
        ([source, list]) => {
          // eslint-disable-next-line no-new-func
          new Function('catalog', `(${source})(catalog)`)(list);
        },
        [FILTER_PANEL.toString(), CATALOG]
      );
    },
    instead: (page) =>
      page.evaluate(
        () =>
          new Promise((done) => {
            window.__listener(
              { type: 'APPLY_FILTERS', wants: [{ facet: 'geoUrn', label: 'Atlantis' }] },
              {},
              done
            );
          })
      ),
  });
  if (!result) return;
  assert.equal(result.ok, false);
  assert.deepEqual(result.applied, [], 'and nothing half-applied is reported as applied');
});

test('a place name is resolved to LinkedIn’s own id by asking LinkedIn', async (t) => {
  // `geoUrn` wants 102784390, not "Chennai", and that number is LinkedIn's
  // own. The filter panel's typeahead is the only thing that knows it, so the
  // adapter drives that box rather than shipping a table nobody publishes.
  const result = await resolve(t, { facet: 'geoUrn', label: 'chennai' });
  if (!result) return;
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.id, '102784390');
  // LinkedIn's own wording comes back, not what was typed.
  assert.equal(result.label, 'Chennai, Tamil Nadu, India');
});

test('a broad name resolves to itself, never to a town inside it', async (t) => {
  // "India" must not become "Theni, Tamil Nadu, India" just because the words
  // appear in it. A prefix is allowed; a substring is not.
  const result = await resolve(t, { facet: 'geoUrn', label: 'India' });
  if (!result) return;
  assert.equal(result.id, '102713980');
  assert.equal(result.label, 'India');
});

test('a name LinkedIn does not have is refused, with what it does have', async (t) => {
  const result = await resolve(t, { facet: 'geoUrn', label: 'Munnar' });
  if (!result) return;
  assert.equal(result.ok, false);
  assert.match(result.reason, /offered nothing|does not offer/i);
});

test('resolving survives every class name being rewritten', async (t) => {
  // LinkedIn's classes are build output. Everything above is found by shape.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(
        ([source, list]) => {
          // eslint-disable-next-line no-new-func
          new Function('catalog', `(${source})(catalog)`)(list);
          for (const el of document.querySelectorAll('[class]')) {
            el.className = `r${Math.random()}`;
          }
        },
        [FILTER_PANEL.toString(), CATALOG]
      );
    },
    instead: (page) =>
      page.evaluate(
        () =>
          new Promise((done) => {
            window.__listener(
              { type: 'RESOLVE_FACET', want: { facet: 'geoUrn', label: 'Theni' } },
              {},
              done
            );
          })
      ),
  });
  if (!result) return;
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.id, '101138777');
});

test('the name LinkedIn gives a filter is learned alongside its id', async (t) => {
  // LinkedIn's facets take ids, not names: geoUrn wants 102713980, not
  // "India". Those ids are internal and not derivable, so the only place both
  // halves appear together is the filter panel — the checkbox carries the id,
  // its label carries the name. This is the pairing the whole facet feature
  // rests on, and nothing else in the extension can produce it.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        const panel = document.createElement('div');
        panel.innerHTML =
          '<input type="checkbox" id="opt_102713980" value="102713980">' +
          '<label for="opt_102713980">India</label>';
        document.body.appendChild(panel);
      });
    },
  });
  if (!result) return;

  // The fixture's URL carries geoUrn=["102713980"], so the id in the URL and
  // the label on the option are now paired.
  assert.deepEqual(result.context.learned, [
    { facet: 'geoUrn', id: '102713980', label: 'India' },
  ]);
});

test('one applied filter teaches the whole list it was chosen from', async (t) => {
  // Typing "usa" into LinkedIn's own location box renders ten places at once,
  // every one of them carrying its id. Learning only the one that gets ticked
  // throws the other nine away, and then LeadMine's own list stays almost
  // empty however much the user browses. Options rendered together belong to
  // one facet, so the moment any of them turns up in the URL the whole batch
  // is attributable — which is an observation, not a guess: they were on
  // screen together.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        const panel = document.createElement('div');
        for (const [id, label] of [
          ['102713980', 'India'],
          ['103644278', 'United States'],
          ['104035573', 'US Virgin Islands'],
          ['105015875', 'Uşak, Türkiye'],
        ]) {
          panel.insertAdjacentHTML(
            'beforeend',
            `<input type="checkbox" id="o_${id}" value="${id}">` +
              `<label for="o_${id}">${label}</label>`
          );
        }
        document.body.appendChild(panel);
      });
      // The observer is debounced, as a network-backed typeahead needs.
      await page.waitForTimeout(400);
    },
  });
  if (!result) return;

  // The URL applies only India, and all four come back.
  const labels = result.context.learned.map((p) => p.label).sort();
  assert.deepEqual(labels, ['India', 'US Virgin Islands', 'United States', 'Uşak, Türkiye']);
  assert.ok(result.context.learned.every((p) => p.facet === 'geoUrn'));
});

test('an id with no name attached is not learned', async (t) => {
  // Half an observation is a guess, and a guessed geoUrn does not fail — it
  // searches somewhere else and hands back a plausible spreadsheet.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        const panel = document.createElement('div');
        // A checkbox whose only text is the id echoed back is not a name.
        panel.innerHTML =
          '<input type="checkbox" id="opt_102713980" value="102713980">' +
          '<label for="opt_102713980">102713980</label>';
        document.body.appendChild(panel);
      });
    },
  });
  if (!result) return;
  assert.deepEqual(result.context.learned, []);
});

test('the URL a run was told to use is reported back with the results', async (t) => {
  // A facet-driven task navigates to a URL the panel built; the context is
  // what proves the page it actually landed on is that one.
  const result = await run(t);
  if (!result) return;
  assert.match(result.context.url, /geoUrn=%5B%22102713980%22%5D/);
});

test('the LinkedIn adapter is chosen for a People search URL', async (t) => {
  const result = await run(t);
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  assert.ok(result.records.every((r) => r.source === 'linkedin'));
});

test('lazily hydrated results are all collected', async (t) => {
  const result = await run(t);
  if (!result) return;
  // Two of four render at load, the rest arrive on scroll, and two more
  // pages bring two each.
  assert.equal(result.records.length, 8, 'the scroll loop must pick up late arrivals');
});

test('each person’s fields are read off the card', async (t) => {
  const result = await run(t);
  if (!result) return;

  const priya = result.records.find((r) => r.name === 'Priya Sharma');
  assert.ok(priya, 'the name must not carry the screen-reader copy of itself');
  assert.equal(priya.headline, 'Staff Software Engineer at Acme Corp');
  assert.equal(priya.company, 'Acme Corp', 'company is split off the headline');
  assert.equal(priya.location, 'Chennai, Tamil Nadu, India');
  assert.equal(priya.degree, '2nd');
  assert.equal(priya.openToWork, 'Yes');
  assert.equal(priya.profileUrl, 'https://www.linkedin.com/in/priya-sharma', 'tracking params stripped');
});

test('the whole card being inside the profile link does not swallow every field', async (t) => {
  // This is the export the user sent back: Name held the entire card with the
  // person's name printed twice, and Headline/Company/Location/Connection were
  // all empty. LinkedIn now wraps the card in the /in/ anchor, so reading the
  // anchor's text returns the card. Fields come off the rendered lines instead.
  const result = await run(t);
  if (!result) return;

  const anubha = result.records.find((r) => r.name === 'Anubha Goel');
  assert.ok(anubha, 'the doubled name must be collapsed, not exported twice');
  assert.equal(anubha.headline, 'Technical Corporate Trainer|C,C++,Java FSD,Python FSD,DSA');
  assert.equal(anubha.location, 'Delhi, India', 'the comma-heavy headline is not a location');
  assert.equal(anubha.company, 'Oracle', 'read off "Current:", which the headline does not carry');
  assert.equal(anubha.degree, '2nd');
  assert.equal(anubha.profileUrl, 'https://www.linkedin.com/in/anubha-goel');

  for (const r of result.records) {
    assert.ok(r.name.length < 60, `Name column holds a whole card: ${r.name}`);
    assert.ok(!/mutual connection|Connect$/i.test(r.name), `chrome leaked into Name: ${r.name}`);
    assert.ok(r.headline, `Headline is empty for ${r.name}`);
    assert.ok(r.location, `Location is empty for ${r.name}`);
    assert.ok(r.degree, `Connection degree is empty for ${r.name}`);
  }
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
  assert.equal(result.records.length, 8);
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

test('when detection fails it reports what it actually saw', async (t) => {
  // A page with no results at all. "No results found" is useless to whoever
  // has to fix it; the counts are what make the next fix a one-shot.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        document.querySelector('ul[role="list"]').remove();
      });
    },
  });
  if (!result) return;

  assert.equal(result.ok, false);
  assert.match(result.error, /Could not find the results/i);
  assert.match(result.error, /links=\d+/, 'how many profile links were on the page');
  assert.match(result.error, /usable=\d+/, 'how many survived filtering');
  assert.match(result.error, /biggest=\d+/, 'the largest group of sibling cards');
  assert.match(result.error, /main=(yes|no)/);
});

test('results are found even when they sit outside <main>', async (t) => {
  // Scoping the search to <main> was a guess about LinkedIn's layout, and a
  // wrong guess looked exactly like "no results".
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        const main = document.querySelector('main');
        const holder = document.createElement('div');
        while (main.firstChild) holder.appendChild(main.firstChild);
        main.replaceWith(holder);
      });
    },
  });
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.records.length, 8);
});

test('cards that are not list items are still grouped correctly', async (t) => {
  // If LinkedIn drops <li>, the walk-up has to find the card by its siblings.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        let list = document.querySelector('ul[role="list"]');
        const div = document.createElement('div');
        for (const li of [...list.children]) {
          const card = document.createElement('div');
          card.innerHTML = li.innerHTML;
          div.appendChild(card);
        }
        list.replaceWith(div);
      });
    },
  });
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.records.length, 2, 'the two hydrated cards are found without <li>');
  assert.ok(!result.records.some((r) => r.profileUrl.includes('mutual-friend')));
});

test('paging is not stopped by LinkedIn rewriting its own URL', async (t) => {
  // The live symptom: exactly 20 profiles, every time — two pages, then stop.
  //
  // The search fingerprint was built from *every* URL parameter bar a
  // four-item denylist, and LinkedIn appends its own tracking and session
  // parameters as you page. So the fingerprint changed on its own, the adapter
  // concluded the user had changed the search underneath it, and the run ended
  // at page two reporting "the source said there are no more".
  const result = await run(t);
  if (!result) return;

  assert.equal(result.ok, true, result.error);
  const names = result.records.map((r) => r.name);
  assert.ok(names.includes('Arun P'), 'page three must be reached');
  assert.ok(names.includes('Divya N'), 'page three must be reached');
  assert.equal(result.records.length, 8);
  assert.match(result.stoppedBecause, /no next page/i, 'it ran out of pages, not out of nerve');
});

test('a search the user really does change mid-run stops, and says so', async (t) => {
  // The fingerprint still has to do its job: two different searches must not
  // be blended into one export.
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => {
        const next = document.getElementById('next');
        next.addEventListener('click', () => {
          // A real change: the keywords the search is for.
          history.replaceState(null, '', '?keywords=python%20developer');
        });
      });
    },
  });
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  assert.match(result.stoppedBecause, /search on the page changed/i);
  assert.ok(result.records.length < 8, 'it stopped rather than mixing two searches');
});

test('it pages past the first ten instead of stopping there', async (t) => {
  // The live run stopped at exactly one page. Two faults did it: the engine
  // held the list node from page one, which paging detaches, and the Next
  // button was matched by an exact aria-label that did not exist.
  const result = await run(t);
  if (!result) return;

  assert.equal(result.ok, true, result.error);
  const names = result.records.map((r) => r.name);
  assert.ok(names.includes('Priya Sharma'), 'page one');
  assert.ok(names.includes('Vikram S'), 'page two');
  assert.ok(names.includes('Meera T'), 'page two');
  assert.equal(result.records.length, 8, 'all three pages, deduplicated');
});

test('paging stops when there is no next page', async (t) => {
  const result = await run(t, {
    mutate: async (page) => {
      await page.evaluate(() => document.getElementById('next').remove());
    },
  });
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.records.length, 4, 'page one only, and no error');
});

test('maxResults still stops a paging run early', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  assert.equal(result.records.length, 4);
});
