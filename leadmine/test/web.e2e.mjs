/**
 * Browser test for the public-web adapter.
 *
 * Runs the real content scripts in Chromium against a synthetic search-engine
 * results page — NOT against a live engine. The fixture is deliberately a
 * blend of the two engines this adapter has to survive, because that is the
 * whole design constraint: there is no one layout to write against.
 *
 *   - Google wraps the site line AND the title heading in one anchor
 *   - DuckDuckGo wraps every result in /l/?uddg=<encoded>
 *   - both carry the same profile two or three times per result
 *   - both change their class names whenever they feel like it
 *   - and Next is a full navigation on both, which is why paging fetches the
 *     next page instead of clicking it
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

/**
 * One result, DuckDuckGo-shaped: the anchor sits inside the heading, and the
 * breadcrumb URL is a second link to the same person above it.
 */
const ddgBlock = ({ href, crumb, title, snippet, thumb = false }) => `
  <li class="b_algo">
    ${thumb ? `<a class="k7" href="${href}"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></a>` : ''}
    <div class="tptt"><a href="${href}">${crumb}</a></div>
    <h2><a href="${href}">${title}</a></h2>
    <div class="b_caption"><p>${snippet}</p></div>
  </li>`;

/**
 * One result, Google-shaped: ONE anchor wrapping the site line and the title
 * heading together. Reading the anchor's text puts "LinkedIn · Name 4.8K+
 * followers" in front of every name.
 */
const googleBlock = ({ href, site, title, snippet }) => `
  <li class="MjjYud">
    <div class="yuRUbf">
      <a href="${href}">
        <div class="q0vns"><span class="VuuXrf">LinkedIn</span> &middot; ${site}</div>
        <h3 class="LC20lb">${title}</h3>
      </a>
    </div>
    <div class="VwiC3b"><span>${snippet}</span></div>
  </li>`;

const PAGE_ONE = [
  googleBlock({
    // Copied from the live SERP: the title truncates with an ellipsis, and the
    // followers count sits inside the same link as the name.
    href: 'https://in.linkedin.com/in/priya-sharma',
    site: 'Priya Sharma<br>500+ followers',
    title: 'Priya Sharma - Corporate Trainer at Acme Corp | LinkedIn',
    snippet:
      'Chennai, Tamil Nadu, India &middot; 500+ connections &middot; Kotlin and Java programmes for enterprise teams.',
  }),
  ddgBlock({
    // DuckDuckGo's redirect wrapper, and a thumbnail link with no text at all
    // — which must not become the result, and must not become a row of its own.
    href: ddg('https://in.linkedin.com/in/raj-kumar'),
    crumb: 'in.linkedin.com &rsaquo; in &rsaquo; raj-kumar',
    title: 'Raj Kumar &ndash; Kotlin Trainer at Globex | LinkedIn',
    // A snippet with no bullets anywhere: the place has to be picked out of
    // the middle of a sentence.
    snippet:
      'Raj Kumar. Kotlin Trainer at Globex. Coimbatore, Tamil Nadu, India. 300 connections on LinkedIn.',
    thumb: true,
  }),
  googleBlock({
    // No company in the headline and no place in the snippet. Both columns
    // must come back empty rather than borrowing from the neighbours.
    href: 'https://uk.linkedin.com/in/anita-r',
    site: 'Anita R',
    title: 'Anita R - Independent Consultant | LinkedIn',
    snippet: 'Consultant. Ask me about training programmes and syllabus design.',
  }),
  googleBlock({
    // A hyphen inside the name. Splitting on any dash puts half a name in the
    // Name column; only a spaced dash separates name from headline.
    href: 'https://fr.linkedin.com/in/jean-pierre-duval',
    site: 'Jean-Pierre Duval',
    title: 'Jean-Pierre Duval - Formateur at Orange | LinkedIn',
    snippet: 'Paris, &Icirc;le-de-France, France &middot; 900 connections',
  }),
  // Chrome that is not a result: a company page, a bare /in/, LinkedIn's own
  // marketing slugs, and an ad with no profile link in it at all.
  `<li class="ads"><h3><a href="https://www.linkedin.com/company/acme">Acme Corp | LinkedIn</a></h3>
     <p>Hire trainers faster.</p></li>`,
  `<li class="MjjYud"><h3><a href="https://www.linkedin.com/in/">LinkedIn</a></h3><p>Sign in.</p></li>`,
  `<li class="MjjYud"><h3><a href="https://www.linkedin.com/in/unavailable">Profile unavailable</a></h3>
     <p>This page is not available.</p></li>`,
].join('');

const PAGE_TWO = [
  googleBlock({
    // A generic ?url= wrapper, the other redirect shape in the wild.
    href: `/redirect?url=${encodeURIComponent('https://www.linkedin.com/in/meera-t')}`,
    site: 'Meera T',
    title: 'Meera T - Corporate Trainer at Umbrella | LinkedIn',
    snippet: 'Pune, Maharashtra, India &middot; 700 connections',
  }),
  googleBlock({
    href: 'https://www.linkedin.com/in/vikram-s',
    site: 'Vikram S',
    title: 'Vikram S - Java Trainer at Initech | LinkedIn',
    snippet: 'Hyderabad, Telangana, India &middot; 400 connections',
  }),
].join('');

/**
 * A results page whose Next is a real link to the next page.
 *
 * Class names are hashed the way a real engine's are, and the header carries
 * its own LinkedIn link. Nothing here responds to a click: on both engines
 * Next is a full navigation, so the adapter fetches that URL instead — which
 * is what this fixture serves.
 */
const NEXT = '/search?q=site%3Alinkedin.com%2Fin+corporate+trainer&start=10';

function fixture(results, { next = NEXT } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
    <header class="h9v"><a href="https://www.linkedin.com/in/site-editor">LinkedIn</a></header>
    <div id="main">
      <ol id="rso" class="x4k">${results}</ol>
      ${next ? `<nav class="p2q"><a id="pnnext" href="${next}" aria-label="Next page">Next</a></nav>` : ''}
    </div>
  </body></html>`;
}

// Bing's challenge, which the first version of the CAPTCHA check missed
// entirely: it looked for Google's words, so a live run read this page as an
// empty result set and blamed the query.
const CAPTCHA = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <h1>One last step</h1>
  <p>Please solve the challenge below to continue</p>
  <div>Verifying...</div>
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

async function run(t, { url, body, nextBody, config = {}, instead } = {}) {
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

  // Page two is served over the network, not by a click, because that is how
  // the adapter asks for it — Next is a full navigation on a real engine and
  // a navigation would destroy the content script mid-run.
  const served = [];
  await page.route('https://www.google.com/**', (route) => {
    const asked = route.request().url();
    served.push(asked);
    const html = body || (asked.includes('start=10')
      ? (nextBody === undefined ? fixture(PAGE_TWO, { next: '' }) : nextBody)
      : fixture(PAGE_ONE));
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.goto(
    url || 'https://www.google.com/search?q=site%3Alinkedin.com%2Fin+corporate+trainer+Chennai'
  );
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

  const pwned = instead ? undefined : await page.evaluate(() => window.__pwned);
  await browser.close();
  return instead ? result : { ...result, served, pwned };
}

const by = (records, name) => records.find((r) => r.name === name);

test('the web adapter is chosen for a search-engine results page', async (t) => {
  const picks = await run(t, {
    instead: (page) =>
      page.evaluate(() => {
        const web = globalThis.MLSAdapters.web;
        return {
          google: web.matchesUrl('https://www.google.com/search?q=x'),
          googleIn: web.matchesUrl('https://www.google.co.in/search?q=x'),
          ddg: web.matchesUrl('https://html.duckduckgo.com/html/?q=x'),
          ddgRoot: web.matchesUrl('https://duckduckgo.com/?q=x&t=h_'),
          // The content script is registered for the whole of duckduckgo.com,
          // so the adapter is what keeps it off the site's other pages.
          ddgHome: web.matchesUrl('https://duckduckgo.com/'),
          maps: web.matchesUrl('https://www.google.com/maps/search/cafes'),
          linkedin: web.matchesUrl('https://www.linkedin.com/search/results/people/?keywords=x'),
        };
      }),
  });
  if (!picks) return;
  assert.equal(picks.google, true);
  assert.equal(picks.googleIn, true, 'a country domain is the same engine');
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

test('a title heading inside the link beats the link’s own text', async (t) => {
  const result = await run(t, { config: { maxResults: 4 } });
  if (!result) return;
  // Google wraps the site line and the heading in ONE anchor, so the link's
  // text is "LinkedIn · Priya Sharma 500+ followers Priya Sharma - Corporate
  // Trainer…". Reading it put all of that in the Name column.
  const priya = by(result.records, 'Priya Sharma');
  assert.ok(priya, `the name came back as: ${result.records.map((r) => r.name).join(' | ')}`);
  assert.ok(!/followers|LinkedIn ·/.test(priya.name), priya.name);
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

test('the next page is fetched, never clicked', async (t) => {
  const result = await run(t, { config: { maxResults: 20 } });
  if (!result) return;
  // Clicking Next on a real engine is a full navigation, and a navigation
  // destroys the content script mid-run: the scrape would be abandoned with
  // page one and no error anywhere. The run must ask for page two by URL.
  assert.ok(
    result.served.some((u) => u.includes('start=10')),
    `page two was never requested: ${result.served.join(' | ')}`
  );
  assert.ok(result.records.some((r) => r.name === 'Vikram S'));
});

test('a challenge on the next page stops the run and says so', async (t) => {
  const result = await run(t, { nextBody: CAPTCHA, config: { maxResults: 20 } });
  if (!result) return;
  // Page one's results are real and are kept; only the reason changes.
  assert.ok(result.records.length >= 4);
  assert.match(result.stoppedBecause, /CAPTCHA/i);
});

test('an engine that answered nothing does not get blamed on pagination', async (t) => {
  const result = await run(t, {
    body: '<!doctype html><html><body><header><a href="https://www.linkedin.com/in/site-editor">LinkedIn</a></header><p>No results found.</p></body></html>',
    config: { maxResults: 20 },
  });
  if (!result) return;
  assert.equal(result.records.length, 0);
  // It said "the search engine offered no next page" before, which sends
  // everyone to look at pagination when the query is what came back empty.
  assert.match(result.stoppedBecause, /no results/i);
});

test('a CAPTCHA is recognised in each engine’s own words', async (t) => {
  const wordings = await run(t, {
    instead: (page) =>
      page.evaluate(() => {
        const web = globalThis.MLSAdapters.web;
        const tried = {};
        for (const [name, text] of Object.entries({
          // The wording that a live run hit and this check did not catch.
          challenge: 'One last step Please solve the challenge below to continue Verifying...',
          unusual: 'Our systems have detected unusual traffic from your computer network.',
          robot: 'Please verify you are a human to continue',
          results: 'No results found for site:linkedin.com/in kotlin trainer',
        })) {
          document.body.innerHTML = `<h1>${text}</h1>`;
          tried[name] = Boolean(web.blockedReason());
        }
        return tried;
      }),
  });
  if (!wordings) return;
  assert.equal(wordings.challenge, true, 'the wording a live run actually hit');
  assert.equal(wordings.unusual, true);
  assert.equal(wordings.robot, true);
  // An empty result set is not a challenge, and calling it one hides a real
  // "your query matched nothing".
  assert.equal(wordings.results, false);
});

test('the next page must be on the search engine itself', async (t) => {
  // findNext searches every link on the page, and on a search engine the
  // links are results — content an attacker can rank and title. A result
  // titled "Show more results for kotlin trainers" matches the label as well
  // as the engine's own control and sits above it in document order.
  // Followed, that URL was fetched with credentials and its markup imported
  // into the live page.
  const result = await run(t, {
    // The Next control points at another origin. Nothing should be fetched.
    body: fixture(PAGE_ONE, { next: 'https://attacker.example/next' }),
    config: { maxResults: 20 },
  });
  if (!result) return;
  assert.ok(
    !result.served.some((u) => /attacker\.example/.test(u)),
    `an off-engine URL was fetched: ${result.served.join(' | ')}`
  );
  assert.match(result.stoppedBecause, /no next page|no results/i);
});

test('markup from the next page cannot execute in this one', async (t) => {
  const hostile = fixture(
    PAGE_TWO +
      `<li class="MjjYud"><h3><a href="https://www.linkedin.com/in/evil-x">Evil X - Trainer | LinkedIn</a></h3>
         <img src="x" onerror="window.__pwned = true">
         <script>window.__pwned = true;<\/script>
         <a href="javascript:window.__pwned=true">click</a>
         <p>Chennai, Tamil Nadu, India</p></li>`,
    { next: '' }
  );
  const result = await run(t, { nextBody: hostile, config: { maxResults: 20 } });
  if (!result) return;
  // The page still pages — sanitising must not throw the results away.
  assert.ok(result.records.some((r) => r.name === 'Meera T'), JSON.stringify(result.records.map((r) => r.name)));
  assert.equal(result.pwned, undefined, 'imported markup ran in the page');
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
