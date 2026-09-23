/**
 * Browser tests for the Posts source's two readers.
 *
 * Both run the real content scripts in Chromium against synthetic pages, not
 * live sites:
 *
 *   - an engine's results for `site:linkedin.com/posts …`, read by the
 *     public-web adapter in posts mode — Google's one-anchor title, a
 *     DuckDuckGo redirect, a profile link sitting in the same result, the
 *     engine's own "5 days ago —" in front of the snippet, and a Next page
 *   - LinkedIn's own post search, read by the linkedin-posts adapter — URNs on
 *     attributes, a reshared post nested inside another, a card still
 *     hydrating, text clamped behind "…see more", and a button that loads the
 *     next posts
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
  'src/content/adapters/linkedin-posts.js',
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

const CHROME_STUB = `
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__listener = fn; } },
      sendMessage: () => {},
    },
  };
`;

/* ------------------------------------------------------------ the engine */

const googleBlock = ({ href, site, title, snippet, extra = '' }) => `
  <li class="MjjYud">
    <div class="yuRUbf">
      <a href="${href}">
        <div class="q0vns"><span class="VuuXrf">LinkedIn</span> &middot; ${site}</div>
        <h3 class="LC20lb">${title}</h3>
      </a>
    </div>
    <div class="VwiC3b"><span>${snippet}</span>${extra}</div>
  </li>`;

const ID_A = '7502588916743708672'; // 2026-09-07
const ID_B = '7501151235211710464'; // 2026-09-03
const ID_C = '7500795809303683073'; // 2026-09-02
const ID_D = '7501912930729377792'; // page two

const POSTS_ONE = [
  googleBlock({
    href: `https://www.linkedin.com/posts/sarala-geriga-352940243_urgenthiring-corporatetrainer-activity-${ID_A}-b0d4?utm_source=share`,
    site: 'Sarala Geriga<br>20+ reactions',
    title: '🚨 URGENT CORPORATE TRAINER REQUIREMENT – PUNE | Sarala Geriga',
    // The engine's own date in front of the snippet, which is not the post's.
    snippet: '5 days ago — We are urgently looking for experienced Corporate Trainers. Share your profile: ta7069@sfjbs.com',
    // The author's profile, linked from inside the same result. It is not a
    // second result, and in posts mode it is not a result at all.
    extra: '<a href="https://www.linkedin.com/in/sarala-geriga-352940243">Sarala Geriga</a>',
  }),
  googleBlock({
    href: `/l/?uddg=${encodeURIComponent(`https://in.linkedin.com/posts/joshibhaskaran_hiringnow-activity-${ID_B}-Ub5i`)}`,
    site: 'Joshi Bhaskaran',
    title: 'Joshi Bhaskaran on LinkedIn: URGENT | Freelance Trainer Needed | Advanced Excel',
    snippet: 'Sep 3, 2026 · NADIA Global is urgently looking for a freelance trainer. Send your profile to contact@nadiaglobal.com',
  }),
  googleBlock({
    href: `https://www.linkedin.com/feed/update/urn:li:activity:${ID_C}/`,
    site: 'Bhavana Shaha',
    title: "Bhavana Shaha's Post - LinkedIn",
    snippet: 'Urgent trainer requirement – NetSuite, Hyderabad. Share your profile at Bhavana.S@iskillbox.com',
  }),
  // A profile result on a posts search: not a post, so not a row.
  googleBlock({
    href: 'https://www.linkedin.com/in/someone-else',
    site: 'Someone Else',
    title: 'Someone Else - Corporate Trainer | LinkedIn',
    snippet: 'Chennai, Tamil Nadu, India',
  }),
  // An article is not a post either.
  googleBlock({
    href: 'https://www.linkedin.com/pulse/how-hire-trainers-someone',
    site: 'Pulse',
    title: 'How to hire trainers | LinkedIn',
    snippet: 'An article.',
  }),
].join('');

const POSTS_TWO = googleBlock({
  href: `https://www.linkedin.com/posts/vandana-sharma_freelancetrainer-activity-${ID_D}-nXe3`,
  site: 'Vandana Sharma',
  title: 'URGENT REQUIREMENT | FREELANCE TECHNICAL TRAINERS – PAN INDIA | Vandana Sharma',
  snippet: 'Talent Bridge Global India is looking for Technical Freelance Trainers. DM 8146785224',
});

const NEXT = '/search?q=site%3Alinkedin.com%2Fposts+corporate+trainer&start=10';

const serp = (results, next) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <header><a href="https://www.linkedin.com/posts/linkedin_activity-7000000000000000000-abcd">LinkedIn</a></header>
  <div id="main"><ol id="rso">${results}</ol>
  ${next ? `<nav><a id="pnnext" href="${next}" aria-label="Next page">Next</a></nav>` : ''}</div>
  </body></html>`;

async function launch(t) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    t.skip('playwright-core is not installed (npm i -D playwright-core)');
    return null;
  }
  const bin = findChromium();
  return chromium.launch({ headless: true, ...(bin ? { executablePath: bin } : {}) });
}

async function scrapeEngine(t, { query = 'site:linkedin.com/posts corporate trainer (required OR urgent)', config = {} } = {}) {
  const browser = await launch(t);
  if (!browser) return null;
  const page = await browser.newPage();
  await page.route('https://www.google.com/**', (route) => {
    const html = route.request().url().includes('start=10') ? serp(POSTS_TWO, '') : serp(POSTS_ONE, NEXT);
    route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}&tbs=qdr:d12`);
  await page.addScriptTag({ content: CHROME_STUB });
  for (const src of CONTENT_SCRIPTS) await page.addScriptTag({ content: src });
  const result = await page.evaluate(
    (cfg) =>
      new Promise((resolve) => {
        window.__listener({ type: 'RUN_SCRAPE', config: cfg }, {}, resolve);
      }),
    { scrollDelay: 30, deep: false, ...config }
  );
  await browser.close();
  return result;
}

test('a posts search on an engine collects posts, not profiles', async (t) => {
  const result = await scrapeEngine(t);
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  const ids = result.records.map((r) => r.postId).sort();
  assert.deepEqual(ids, [ID_A, ID_B, ID_C, ID_D].sort(), JSON.stringify(result.records.map((r) => r.postUrl)));
  for (const record of result.records) {
    assert.equal(record.source, 'posts', 'a post is not a person');
    assert.equal(record.profileUrl, undefined);
  }
});

test('each post keeps its author, its whole text and a clean link', async (t) => {
  const result = await scrapeEngine(t);
  if (!result) return;
  const sarala = result.records.find((r) => r.postId === ID_A);
  assert.equal(sarala.author, 'Sarala Geriga');
  assert.match(sarala.text, /^🚨 URGENT CORPORATE TRAINER REQUIREMENT – PUNE — We are urgently looking/);
  assert.ok(!/5 days ago/.test(sarala.text), 'the engine’s date is not part of the post');
  assert.ok(!/followers|reactions|LinkedIn ·/.test(sarala.text), sarala.text);
  assert.equal(
    sarala.postUrl,
    `https://www.linkedin.com/posts/sarala-geriga-352940243_urgenthiring-corporatetrainer-activity-${ID_A}-b0d4`,
    'tracking parameters are not part of the post'
  );

  const joshi = result.records.find((r) => r.postId === ID_B);
  assert.equal(joshi.author, 'Joshi Bhaskaran', 'the "X on LinkedIn:" title shape');
  assert.match(joshi.postUrl, /^https:\/\/in\.linkedin\.com\/posts\//, 'the redirect wrapper is unwrapped');
  assert.ok(!/Sep 3, 2026/.test(joshi.text));

  const bhavana = result.records.find((r) => r.postId === ID_C);
  assert.equal(bhavana.author, 'Bhavana Shaha', 'the "X’s Post" title shape');
  assert.match(bhavana.text, /NetSuite, Hyderabad/);
});

test('a people search on the same engine still reads people', async (t) => {
  // The mode comes from the query. The same page with site:linkedin.com/in
  // must behave exactly as it did before posts existed.
  const result = await scrapeEngine(t, { query: 'site:linkedin.com/in corporate trainer' });
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  const people = result.records.filter((r) => r.profileUrl);
  assert.ok(people.some((r) => /someone-else/.test(r.profileUrl)), 'the profile result is a person here');
  assert.ok(result.records.every((r) => r.source === 'web'));
});

/* ----------------------------------------------------- LinkedIn's own search */

const card = ({ id, name, profile, text, reshare = '' }) => `
  <li class="artdeco-card">
    <div data-urn="urn:li:activity:${id}" class="feed-shared-update-v2">
      <div class="update-components-actor">
        <a href="${profile}?miniProfileUrn=abc">
          <span class="update-components-actor__title"><span aria-hidden="true">${name}</span>
          <span class="visually-hidden">${name}</span> • 2nd</span>
        </a>
      </div>
      <div class="update-components-text"><span dir="ltr">${text}</span>
        <button class="see-more">…see more</button></div>
      ${reshare}
    </div>
  </li>`;

const LI_ID_1 = '7502609941795483648';
const LI_ID_2 = '7501220653728096256';
const LI_ID_RESHARED = '7496096314401759232';
const LI_ID_LATE = '7500525266172010496';

const LINKEDIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <main style="min-height: 3000px">
    <ul id="results">
      ${card({
        id: LI_ID_1,
        name: 'Girish PM',
        profile: 'https://www.linkedin.com/in/girish-pm-940872238',
        text: 'Dear Trainers, we are looking for experienced Freelance Corporate Trainers for a Customer Leadership program. 📞 86600 80253',
      })}
      ${card({
        id: LI_ID_2,
        name: 'Rakhi Mann',
        profile: 'https://www.linkedin.com/in/rakhi-mann-209a33203',
        text: 'Looking for Freelance Corporate Trainers! Share your profile at pitambara.singh@myrealdata.in',
        // A reshared post inside this one carries its own URN. It is part of
        // Rakhi's post, not a second result.
        reshare: `<div data-urn="urn:li:activity:${LI_ID_RESHARED}"><div class="update-components-text">Original</div></div>`,
      })}
      <li class="artdeco-card"><div data-urn="urn:li:activity:7500000000000000000"></div></li>
    </ul>
    <button id="more" aria-label="Show more results" onclick="
      document.getElementById('results').insertAdjacentHTML('beforeend', window.__late);
      this.remove();">Show more results</button>
  </main>
  </body></html>`;

const LATE = card({
  id: LI_ID_LATE,
  name: 'Freelance Trainings',
  profile: 'https://www.linkedin.com/company/freelancetrainings',
  text: 'Freelance Trainer Requirement – Campus to Corporate. Commercials ₹8,000 per day.',
});

async function scrapeLinkedIn(t, config = {}) {
  const browser = await launch(t);
  if (!browser) return null;
  const page = await browser.newPage();
  await page.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: LINKEDIN_PAGE })
  );
  await page.goto('https://www.linkedin.com/search/results/content/?keywords=corporate%20trainer&datePosted=%22past-week%22');
  await page.addScriptTag({ content: CHROME_STUB });
  await page.evaluate((late) => { window.__late = late; }, LATE);
  for (const src of CONTENT_SCRIPTS) await page.addScriptTag({ content: src });
  const result = await page.evaluate(
    (cfg) =>
      new Promise((resolve) => {
        window.__listener({ type: 'RUN_SCRAPE', config: cfg }, {}, resolve);
      }),
    { scrollDelay: 30, deep: false, ...config }
  );
  await browser.close();
  return result;
}

test('LinkedIn’s post search is read by the posts adapter, and only that page', async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  const page = await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: CHROME_STUB });
  for (const src of CONTENT_SCRIPTS) await page.addScriptTag({ content: src });
  const picks = await page.evaluate(() => {
    const a = globalThis.MLSAdapters;
    const content = 'https://www.linkedin.com/search/results/content/?keywords=x';
    const people = 'https://www.linkedin.com/search/results/people/?keywords=x';
    return {
      postsOnContent: a.linkedinPosts.matchesUrl(content),
      peopleOnContent: a.linkedin.matchesUrl(content),
      postsOnPeople: a.linkedinPosts.matchesUrl(people),
      webOnContent: a.web.matchesUrl(content),
    };
  });
  await browser.close();
  assert.deepEqual(picks, { postsOnContent: true, peopleOnContent: false, postsOnPeople: false, webOnContent: false });
});

test('each post on LinkedIn’s page is one row, with its author and whole text', async (t) => {
  const result = await scrapeLinkedIn(t);
  if (!result) return;
  assert.equal(result.ok, true, result.error);
  const ids = result.records.map((r) => r.postId);
  assert.ok(!ids.includes(LI_ID_RESHARED), 'a reshared original is part of the post around it');
  assert.ok(!ids.includes('7500000000000000000'), 'a card with no text yet is not a post yet');

  const girish = result.records.find((r) => r.postId === LI_ID_1);
  assert.equal(girish.source, 'posts');
  assert.equal(girish.author, 'Girish PM', 'the screen-reader copy and the degree are not the name');
  assert.equal(girish.authorUrl, 'https://www.linkedin.com/in/girish-pm-940872238');
  assert.match(girish.text, /86600 80253$/, '"…see more" is not part of the post');
  assert.equal(girish.postUrl, `https://www.linkedin.com/feed/update/urn:li:activity:${LI_ID_1}/`);
});

test('more posts are loaded until LinkedIn has no more, and company authors keep their page', async (t) => {
  const result = await scrapeLinkedIn(t);
  if (!result) return;
  const late = result.records.find((r) => r.postId === LI_ID_LATE);
  assert.ok(late, `the posts behind "Show more results" were not loaded: ${result.records.map((r) => r.postId)}`);
  assert.equal(late.authorUrl, 'https://www.linkedin.com/company/freelancetrainings');
  assert.match(result.stoppedBecause, /no more posts|four rounds/);
});

test('a posts run on LinkedIn stops at the limit it was given', async (t) => {
  const result = await scrapeLinkedIn(t, { maxResults: 1 });
  if (!result) return;
  assert.equal(result.records.length, 1);
});
