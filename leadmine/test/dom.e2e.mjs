/**
 * Browser-level check of the content script's DOM wiring.
 *
 * The unit tests cover the text parsing; this one covers what they cannot —
 * that the selectors, the scroll loop, the detail-panel click/back cycle and
 * the final record shape all hold together in a real Chromium.
 *
 * It runs against a synthetic page that mimics the structure of Google Maps
 * search results (an obfuscated-class feed of cards, plus a detail panel that
 * swaps in on click), not against Google itself.
 *
 * Run with: npm run test:dom
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The content script is now three files: shared parsing, the generic engine,
// and the source adapter. Load them in the same order the manifest does.
const CONTENT_SCRIPTS = [
  'src/lib/parse.js',
  'src/content/engine.js',
  'src/content/adapters/maps.js',
].map((f) => readFileSync(join(ROOT, f), 'utf8'));

const BUSINESSES = [
  {
    name: 'Bright Smile Dental',
    category: 'Dental clinic',
    cardAddress: '12, 2nd Ave, Anna Nagar',
    fullAddress: '12, 2nd Ave, Anna Nagar, Chennai, Tamil Nadu 600040, India',
    phone: '+914423456789',
    cardPhone: '044 2345 6789',
    website: 'https://brightsmile.test/',
    rating: '4.6',
    reviews: '284',
    hours: 'Monday, 9 AM to 9 PM; Tuesday, 9 AM to 9 PM; Wednesday, Closed',
    price: '₹₹',
    claimed: true,
  },
  {
    name: 'City Dental Care',
    category: 'Dentist',
    cardAddress: '5 Poonamallee High Rd, Kilpauk',
    fullAddress: '5 Poonamallee High Rd, Kilpauk, Chennai, Tamil Nadu 600010, India',
    phone: '+914428888888',
    cardPhone: '044 2888 8888',
    website: 'https://citydental.test/',
    rating: '4.2',
    reviews: '97',
    hours: 'Monday, 10 AM to 8 PM; Tuesday, 10 AM to 8 PM',
    price: '',
    claimed: true,
  },
  {
    // No phone or website on the card, and none in the panel either: the
    // record must still come through with the fields it does have.
    name: 'Smile Studio',
    category: 'Dental clinic',
    cardAddress: 'Shop 3, T Nagar',
    fullAddress: 'Shop 3, Usman Rd, T Nagar, Chennai, Tamil Nadu 600017, India',
    phone: '',
    cardPhone: '',
    website: '',
    rating: '5.0',
    reviews: '12',
    hours: '',
    price: '',
    claimed: false,
  },
];

function fixture() {
  const cards = BUSINESSES.map(
    (b, i) => `
    <div jsaction="mouseover:pane.card" class="Nv2PK">
      <a class="hfpxzc" href="https://www.google.com/maps/place/${encodeURIComponent(b.name)}/data=!3m1!${i}"
         aria-label="${b.name}"></a>
      <div class="fontBodyMedium">
        <div class="qBF1Pd">${b.name}</div>
        <span role="img" aria-label="${b.rating} stars ${b.reviews} Reviews"></span>
        <div class="W4Efsd">${b.category} · ${b.cardAddress}</div>
        <div class="W4Efsd">Open ⋅ Closes 9 pm${b.cardPhone ? ` · ${b.cardPhone}` : ''}</div>
      </div>
    </div>`
  ).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    #main { height: 400px; }
    div[role="feed"] { height: 400px; overflow-y: auto; }
    .Nv2PK { height: 150px; }
  </style></head><body>
    <div role="main" id="main">
      <div role="feed">
        ${cards}
        <div class="HlvSq"><span>You've reached the end of the list.</span></div>
      </div>
    </div>
    <script>
      // Minimal stand-in for the Maps SPA: clicking a card swaps the feed for
      // a detail panel, and the back button swaps it back.
      const DATA = ${JSON.stringify(BUSINESSES)};
      const main = document.getElementById('main');
      const listHtml = main.innerHTML;

      main.addEventListener('click', (e) => {
        const link = e.target.closest('a.hfpxzc');
        if (link) {
          e.preventDefault();
          const b = DATA.find((d) => d.name === link.getAttribute('aria-label'));
          // Panels render a beat after the click, like the real thing.
          setTimeout(() => { main.innerHTML = detailHtml(b); }, 80);
          return;
        }
        if (e.target.closest('button[jsaction*="back"]')) {
          setTimeout(() => { main.innerHTML = listHtml; }, 60);
        }
      });

      function detailHtml(b) {
        return \`
          <button jsaction="pane.back" aria-label="Back"></button>
          <h1 class="DUwDvf">\${b.name}</h1>
          <div class="F7nice"><span aria-hidden="true">\${b.rating}</span>
            <span aria-label="\${b.reviews} reviews"></span></div>
          <button jsaction="pane.rating.category">\${b.category}</button>
          <button data-item-id="address" aria-label="Address: \${b.fullAddress}">
            <div class="Io6YTe">\${b.fullAddress}</div></button>
          \${b.phone ? \`<button data-item-id="phone:tel:\${b.phone}" aria-label="Phone: \${b.cardPhone}"></button>\` : ''}
          \${b.website ? \`<a data-item-id="authority" href="\${b.website}">\${b.website}</a>\` : ''}
          <button data-item-id="oloc" aria-label="Plus code: 7J4V+2X Chennai"></button>
          \${b.hours ? \`<div class="t39EBf" aria-label="\${b.hours}"></div>\` : ''}
          \${b.price ? \`<span aria-label="Price: \${b.price}"></span>\` : ''}
          \${b.claimed ? '' : '<a href="/business/">Claim this business</a>'}\`;
      }
    </script>
  </body></html>`;
}

/** Stands in for the extension APIs the content script touches. */
const CHROME_STUB = `
  window.__progress = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__listener = fn; } },
      sendMessage: (msg) => { window.__progress.push(msg); },
    },
  };
`;

/**
 * Prefer a Chromium already on the machine (CI images often pre-seed one under
 * PLAYWRIGHT_BROWSERS_PATH) over asking Playwright to download its own.
 */
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

/** Loads the fixture, injects the real content script, and runs one scrape. */
async function scrape(browser, config) {
  const page = await browser.newPage();
  // Serve the fixture from a real Maps URL: the adapter is chosen by
  // matchesUrl, and the search term is read out of the path.
  await page.route('https://www.google.com/maps/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: fixture() })
  );
  await page.goto('https://www.google.com/maps/search/dentists+in+Chennai/@13.0827,80.2707,12z?hl=en');
  await page.addScriptTag({ content: CHROME_STUB });
  for (const src of CONTENT_SCRIPTS) await page.addScriptTag({ content: src });

  const result = await page.evaluate(
    (cfg) =>
      new Promise((resolve) => {
        window.__listener({ type: 'RUN_SCRAPE', config: cfg }, {}, resolve);
      }),
    { city: 'Chennai', category: 'dentists', scrollDelay: 120, detailDelay: 40, ...config }
  );
  const progress = await page.evaluate(() => window.__progress);
  await page.close();
  return { result, progress };
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

test('content script scrapes a Maps-shaped page end to end', async (t) => {
  const browser = await launch(t);
  if (!browser) return;

  try {
    const { result, progress } = await scrape(browser, { deep: true });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.context.query, 'dentists in Chennai', 'context comes from the URL');

    const records = result.records;
    assert.equal(records.length, 3, 'every card in the feed should be collected');
    assert.ok(records.every((r) => r.source === 'maps'), 'each record is tagged with its source');

    const bright = records.find((r) => r.name === 'Bright Smile Dental');
    assert.ok(bright, 'named record missing');
    assert.equal(bright.phone, '+914423456789', 'phone should come from the detail panel');
    assert.equal(bright.website, 'https://brightsmile.test/');
    assert.equal(bright.address, '12, 2nd Ave, Anna Nagar, Chennai, Tamil Nadu 600040, India');
    assert.equal(bright.area, 'Anna Nagar', 'area is derived from the full address');
    assert.equal(bright.city, 'Chennai');
    assert.equal(bright.rating, '4.6');
    assert.equal(bright.reviews, '284');
    assert.equal(bright.category, 'Dental clinic');
    assert.equal(bright.plusCode, '7J4V+2X Chennai');
    assert.equal(bright.detailScraped, true);
    assert.equal(
      bright.hours,
      'Monday, 9 AM to 9 PM; Tuesday, 9 AM to 9 PM; Wednesday, Closed',
      'the full week, not the collapsed "Open ⋅ Closes 9 pm" summary'
    );
    assert.equal(bright.priceLevel, '₹₹');
    assert.equal(bright.claimed, 'Yes');

    const noPhone = records.find((r) => r.name === 'Smile Studio');
    assert.equal(noPhone.phone, '', 'a business without a phone stays blank, not undefined');
    assert.equal(noPhone.website, '');
    assert.equal(noPhone.area, 'T Nagar');
    assert.equal(noPhone.claimed, 'No', 'a "Claim this business" link means unclaimed');
    assert.equal(noPhone.hours, '', 'a listing without hours stays blank');

    const phases = new Set(progress.map((m) => m.phase));
    assert.ok(phases.has('listing'), 'listing progress should be reported');
    assert.ok(phases.has('details'), 'detail progress should be reported');
    assert.ok(phases.has('done'), 'completion should be reported');
  } finally {
    await browser.close();
  }
});

test('list-only mode reads category, address and phone off the cards', async (t) => {
  const browser = await launch(t);
  if (!browser) return;

  try {
    // With deep mode off nothing overwrites the card-level fields, so this is
    // what catches a card parser that swallows the business name or the
    // opening hours into the category.
    const { result } = await scrape(browser, { deep: false });
    assert.equal(result.ok, true, result.error);

    const bright = result.records.find((r) => r.name === 'Bright Smile Dental');
    assert.equal(bright.category, 'Dental clinic', 'category must not absorb the name');
    assert.equal(bright.address, '12, 2nd Ave, Anna Nagar');
    assert.equal(bright.phone, '044 2345 6789', 'phone comes from the card here');
    assert.equal(bright.rating, '4.6');
    assert.equal(bright.area, 'Anna Nagar');
    assert.equal(bright.detailScraped, false);

    const noPhone = result.records.find((r) => r.name === 'Smile Studio');
    assert.equal(noPhone.phone, '');
    assert.equal(noPhone.category, 'Dental clinic');
  } finally {
    await browser.close();
  }
});
