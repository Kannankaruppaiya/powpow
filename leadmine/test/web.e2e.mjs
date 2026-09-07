/**
 * Browser test for the public-web adapter.
 *
 * Runs the real content scripts in Chromium against a synthetic search-engine
 * results page — NOT against a live engine. The fixture is deliberately a
 * blend of the three engines this adapter has to survive, because that is the
 * whole design constraint: there is no one layout to write against.
 *
 *   - DuckDuckGo wraps every result in /l/?uddg=<encoded>
 *   - Bing links straight out and prints a breadcrumb URL above the title
 *   - all three carry the same profile two or three times per result
 *   - all three change their class names whenever they feel like it
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
  'src/content/adapters/web.js',
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

const ddg = (url) => `/l/?uddg=${encodeURIComponent(url)}&rut=b91f0c`;

/** One result block, shaped like Bing's: breadcrumb, title, snippet. */
const block = ({ href, crumb, title, snippet, thumb = false }) => `
  <li class="b_algo">
    ${thumb ? `<a class="k7" href="${href}"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></a>` : ''}
    <div class="tptt"><a href="${href}">${crumb}</a></div>
    <h2><a href="${href}">${title}</a></h2>
    <div class="b_caption"><p>${snippet}</p></div>
  </li>`;

const PAGE_ONE = [
  block({
    // DuckDuckGo's redirect wrapper, and a thumbnail link with no text at all
    // — which must not become the result, and must not become a row of its own.
    href: ddg('https://in.linkedin.com/in/priya-sharma'),
    crumb: 'in.linkedin.com &rsaquo; in &rsaquo; priya-sharma',
    title: 'Priya Sharma - Corporate Trainer at Acme Corp | LinkedIn',
    snippet:
      'Chennai, Tamil Nadu, India &middot; 500+ connections &middot; Kotlin and Java programmes for enterprise teams.',
    thumb: true,
  }),
  block({
    // A snippet with no bullets anywhere: the place has to be picked out of
    // the middle of a sentence.
    href: 'https://www.linkedin.com/in/raj-kumar?trk=public_profile',
    crumb: 'www.linkedin.com/in/raj-kumar',
    title: 'Raj Kumar &ndash; Kotlin Trainer at Globex | LinkedIn',
    snippet:
      'Raj Kumar. Kotlin Trainer at Globex. Coimbatore, Tamil Nadu, India. 300 connections on LinkedIn.',
  }),
  block({
    // No company in the headline and no place in the snippet. Both columns
    // must come back empty rather than borrowing from the neighbours.
    href: 'https://uk.linkedin.com/in/anita-r',
    crumb: 'uk.linkedin.com &rsaquo; in &rsaquo; anita-r',
    title: 'Anita R - Independent Consultant | LinkedIn',
    snippet: 'Consultant. Ask me about training programmes and syllabus design.',
  }),
  block({
    // A hyphen inside the name. Splitting on any dash puts half a name in the
    // Name column; only a spaced dash separates name from headline.
    href: 'https://fr.linkedin.com/in/jean-pierre-duval',
    crumb: 'fr.linkedin.com &rsaquo; in &rsaquo; jean-pierre-duval',
    title: 'Jean-Pierre Duval - Formateur at Orange | LinkedIn',
    snippet: 'Paris, &Icirc;le-de-France, France &middot; 900 connections',
  }),
  // Chrome that is not a result: a company page, a bare /in/, LinkedIn's own
  // marketing slugs, and an ad with no profile link in it at all.
  `<li class="b_ad"><h2><a href="https://www.linkedin.com/company/acme">Acme Corp | LinkedIn</a></h2>
     <p>Hire trainers faster.</p></li>`,
  `<li class="b_algo"><h2><a href="https://www.linkedin.com/in/">LinkedIn</a></h2><p>Sign in.</p></li>`,
  `<li class="b_algo"><h2><a href="https://www.linkedin.com/in/unavailable">Profile unavailable</a></h2>
     <p>This page is not available.</p></li>`,
].join('');

const PAGE_TWO = [
  block({
    // A generic ?url= wrapper, the other redirect shape in the wild.
    href: `/redirect?url=${encodeURIComponent('https://www.linkedin.com/in/meera-t')}`,
    crumb: 'www.linkedin.com &rsaquo; in &rsaquo; meera-t',
    title: 'Meera T - Corporate Trainer at Umbrella | LinkedIn',
    snippet: 'Pune, Maharashtra, India &middot; 700 connections',
  }),
  block({
    href: 'https://www.linkedin.com/in/vikram-s',
    crumb: 'www.linkedin.com &rsaquo; in &rsaquo; vikram-s',
    title: 'Vikram S - Java Trainer at Initech | LinkedIn',
    snippet: 'Hyderabad, Telangana, India &middot; 400 connections',
  }),
].join('');

/**
 * A results page with a working Next control.
 *
 * Class names are hashed the way a real engine's are, the header carries its
 * own LinkedIn link, and the second page replaces the list in place — so an
 * adapter that held on to the old container sees nothing after paging.
 */
function fixture() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <header class="h9v"><a href="https://www.linkedin.com/in/site-editor">LinkedIn</a></header>
    <main>
      <ol id="b_results" class="x4k">${PAGE_ONE}</ol>
      <nav class="p2q"><a class="sb_pagN" href="#" aria-label="Next page">Next</a></nav>
    </main>
    <script>
      document.querySelector('.sb_pagN').addEventListener('click', (e) => {
        e.preventDefault();
        const list = document.getElementById('b_results');
        setTimeout(() => {
          list.innerHTML = ${JSON.stringify(PAGE_TWO)};
          document.querySelector('.p2q').innerHTML = '<span class="sb_pagN">Next</span>';
        }, 120);
      });
    </script>
  </body></html>`;
}

const CAPTCHA = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <h1>Before you continue</h1>
  <p>Our systems have detected unusual traffic from your computer network.</p>
  </body></html>`;

const CHROME_STUB = `
  window.__progress = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__listener = fn; } },
      sendMessage: (msg) => { window.__progress.push(msg); },
    },
  };
`;

async function run(t, { url, body, config = {}, instead } = {}) {
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

  await page.route('https://www.bing.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: body || fixture() })
  );
  await page.goto(url || 'https://www.bing.com/search?q=site%3Alinkedin.com%2Fin%20%22corporate%20trainer%22%20Chennai');
  await page.addScriptTag({ content: CHROME_STUB });
  for (const src of CONTENT_SCRIPTS) await page.addScriptTag({ content: src });

  const result = instead
    ? await instead(page)
    : await page.evaluate(
        (cfg) =>
          new Promise((resolve) => {
            window.__listener({ type: 'RUN_SCRAPE', config: cfg }, {}, resolve);
          }),
        { scrollDelay: 60, deep: false, ...config }
      );

  await browser.close();
  return result;
}

const by = (records, name) => records.find((r) => r.name === name);

test('the web adapter is chosen for a search-engine results page', async (t) => {
  const picks = await run(t, {
    instead: (page) =>
      page.evaluate(() => {
        const web = globalThis.MLSAdapters.web;
        return {
          bing: web.matchesUrl('https://www.bing.com/search?q=x'),
          ddg: web.matchesUrl('https://html.duckduckgo.com/html/?q=x'),
          ddgRoot: web.matchesUrl('https://duckduckgo.com/?q=x&t=h_'),
          // The content script is registered for the whole of duckduckgo.com,
          // so the adapter is what keeps it off the site's other pages.
          ddgHome: web.matchesUrl('https://duckduckgo.com/'),
          google: web.matchesUrl('https://www.google.com/search?q=x'),
          maps: web.matchesUrl('https://www.google.com/maps/search/cafes'),
          linkedin: web.matchesUrl('https://www.linkedin.com/search/results/people/?keywords=x'),
        };
      }),
  });
  if (!picks) return;
  assert.equal(picks.bing, true);
  assert.equal(picks.ddg, true);
  assert.equal(picks.ddgRoot, true, 'DuckDuckGo puts its results at the site root');
  assert.equal(picks.ddgHome, false, 'the home page is not a results page');
  assert.equal(picks.google, true);
  // Maps and LinkedIn have their own adapters and must keep them.
  assert.equal(picks.maps, false);
  assert.equal(picks.linkedin, false);
});

test('a profile behind a redirect wrapper is still found', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  const priya = by(result.records, 'Priya Sharma');
  assert.ok(priya, `Priya was not found: ${result.records.map((r) => r.name).join(' | ')}`);
  assert.equal(priya.profileUrl, 'https://www.linkedin.com/in/priya-sharma');
});

test('the title is split into a name and a headline', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  const priya = by(result.records, 'Priya Sharma');
  assert.equal(priya.headline, 'Corporate Trainer at Acme Corp');
  assert.equal(priya.company, 'Acme Corp');
  // "| LinkedIn" is the site's own name, not part of anybody's job.
  assert.ok(!/LinkedIn/i.test(priya.headline));
});

test('a hyphenated name is not split down the middle', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  const jp = by(result.records, 'Jean-Pierre Duval');
  assert.ok(jp, `the name was split: ${result.records.map((r) => r.name).join(' | ')}`);
  assert.equal(jp.headline, 'Formateur at Orange');
});

test('the breadcrumb URL above a result is not read as its location', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  const priya = by(result.records, 'Priya Sharma');
  assert.equal(priya.location, 'Chennai, Tamil Nadu, India');
});

test('a location is found in a snippet with no bullets in it', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  const raj = by(result.records, 'Raj Kumar');
  assert.equal(raj.location, 'Coimbatore, Tamil Nadu, India');
  // An en dash separates the title just as a hyphen does.
  assert.equal(raj.headline, 'Kotlin Trainer at Globex');
});

test('a result with no company and no place leaves both columns empty', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  const anita = by(result.records, 'Anita R');
  assert.equal(anita.company, '');
  // The next result along has a place. Borrowing it is the bug this guards.
  assert.equal(anita.location, '');
});

test('chrome and non-profile links are not scraped as people', async (t) => {
  const result = await run(t, { config: { maxResults: 20 } });
  if (!result) return;
  const names = result.records.map((r) => r.name).join(' | ');
  assert.ok(!/Acme Corp \|/.test(names), `a company page became a person: ${names}`);
  assert.ok(!result.records.some((r) => /unavailable/i.test(r.profileUrl)), names);
  assert.ok(!result.records.some((r) => /site-editor/.test(r.profileUrl)), names);
  assert.ok(!result.records.some((r) => r.name === 'LinkedIn'), names);
});

test('one person listed twice on a page is one row, named by the title', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  const priyas = result.records.filter((r) => /priya-sharma/.test(r.profileUrl));
  assert.equal(priyas.length, 1);
  // The breadcrumb link comes first in the DOM; taking it would name the row
  // "in.linkedin.com › in › priya-sharma".
  assert.equal(priyas[0].name, 'Priya Sharma');
});

test('it pages on to the next set of results', async (t) => {
  const result = await run(t, { config: { maxResults: 20 } });
  if (!result) return;
  const names = result.records.map((r) => r.name);
  assert.ok(names.includes('Priya Sharma'), names.join(' | '));
  assert.ok(names.includes('Meera T'), names.join(' | '));
  assert.ok(names.includes('Vikram S'), names.join(' | '));
});

test('paging stops with a reason once the engine offers no next page', async (t) => {
  const result = await run(t, { config: { maxResults: 20 } });
  if (!result) return;
  assert.match(result.stoppedBecause, /no next page/i);
});

test('maxResults is honoured', async (t) => {
  const result = await run(t, { config: { maxResults: 2 } });
  if (!result) return;
  assert.equal(result.records.length, 2);
});

test('profiles are never opened for detail', async (t) => {
  const result = await run(t, { config: { maxResults: 4, deep: true } });
  if (!result) return;
  assert.ok(result.records.every((r) => r.detailScraped === false));
});

test('the run is tagged with the source it came from', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  assert.ok(result.records.every((r) => r.source === 'web'));
});

test('the location doubles as the city so the area filter has something to read', async (t) => {
  const result = await run(t, { config: { maxResults: 4, city: 'Chennai' } });
  if (!result) return;
  const priya = by(result.records, 'Priya Sharma');
  assert.equal(priya.city, 'Chennai, Tamil Nadu, India');
  // With no location of its own, a record falls back to what was searched for.
  assert.equal(by(result.records, 'Anita R').city, 'Chennai');
});

test('a CAPTCHA page stops the run rather than scraping the challenge', async (t) => {
  const result = await run(t, { body: CAPTCHA, config: { maxResults: 4 } });
  if (!result) return;
  assert.equal(result.ok, false);
  assert.match(result.error || '', /CAPTCHA/i);
});
