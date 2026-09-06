/**
 * Maps Lead Scraper — content script.
 *
 * Runs inside google.com/maps. Owns all DOM work:
 *   Phase 1 — scroll the results feed to the end, collecting one record per card.
 *   Phase 2 — (optional "deep" mode) open each card's detail panel to read the
 *             phone number, website and full address, which the card itself
 *             usually omits.
 *
 * Google ships obfuscated, rotating class names, so every selector below is
 * tried in order: stable attribute hooks (data-item-id, role, aria-label)
 * first, hashed class names only as a last resort. Forcing hl=en on the search
 * URL keeps the aria-label prefixes ("Phone:", "Address:") predictable.
 */
(() => {
  'use strict';

  // The content script is re-injected on SPA navigations in some Chrome
  // versions; keep exactly one listener alive.
  if (window.__mapsLeadScraperLoaded) return;
  window.__mapsLeadScraperLoaded = true;

  const SEL = {
    feed: 'div[role="feed"]',
    // Every result card wraps a link to the place page.
    cardLink: 'a[href*="/maps/place/"]',
    main: 'div[role="main"]',
    detailName: 'h1',
    detailAddress: 'button[data-item-id="address"]',
    detailPhone: 'button[data-item-id^="phone:tel:"]',
    detailWebsite: 'a[data-item-id="authority"]',
    detailPlusCode: 'button[data-item-id="oloc"]',
    detailCategory: 'button[jsaction*="category"]',
    backButton: 'button[jsaction*="back"], button[aria-label="Back"]',
    consent: 'form[action*="consent"], div[aria-label*="Before you continue"]',
  };

  const END_OF_LIST_HINTS = [
    "you've reached the end of the list",
    'you have reached the end of the list',
  ];

  const state = {
    running: false,
    cancelled: false,
    phase: 'idle',
    found: 0,
    detailed: 0,
    total: 0,
  };

  /* ----------------------------------------------------------------- utils */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Provided by src/lib/parse.js, loaded as the content script before this one.
  const { norm, nameKey, parseRatingLabel, parseCardParts, deriveArea, phoneFromItemId } =
    globalThis.MLSParse;

  /** Poll for a condition instead of guessing at fixed sleeps. */
  async function waitFor(fn, { timeout = 8000, interval = 120 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (state.cancelled) return null;
      let value;
      try {
        value = fn();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  function report(patch) {
    Object.assign(state, patch);
    try {
      chrome.runtime.sendMessage({
        type: 'SCRAPE_PROGRESS',
        phase: state.phase,
        found: state.found,
        detailed: state.detailed,
        total: state.total,
      });
    } catch {
      /* popup closed / worker asleep — progress is best effort */
    }
  }

  /* ------------------------------------------------------- field extractors */

  /**
   * Rating + review count. Maps renders these as
   * `<span role="img" aria-label="4.5 stars 128 Reviews">` on cards and as a
   * plain number next to a review link on the detail panel.
   */
  function extractRating(scope) {
    const out = { rating: '', reviews: '' };
    if (!scope) return out;

    const img = scope.querySelector('span[role="img"][aria-label]');
    if (img) Object.assign(out, parseRatingLabel(img.getAttribute('aria-label')));

    if (!out.rating) {
      // Detail panel: the bare number is the first aria-hidden span.
      const bare = scope.querySelector('div.F7nice span[aria-hidden="true"], span.MW4etd');
      const v = norm(bare && bare.textContent);
      if (/^\d+([.,]\d+)?$/.test(v)) out.rating = v.replace(',', '.');
    }

    if (!out.reviews) {
      const link = scope.querySelector('[aria-label*="review" i], span.UY7F9');
      const m = norm(link && (link.getAttribute('aria-label') || link.textContent)).match(
        /([\d.,]+)/
      );
      if (m) out.reviews = m[1].replace(/[.,]/g, '');
    }
    return out;
  }

  /**
   * Read the card's secondary info rows. Maps packs
   * "Category · Address" on one line and "Open now · Closing time" plus an
   * optional phone number on the next, all separated by middle dots.
   */
  function extractCardInfo(card, name = '') {
    if (!card) return { category: '', address: '', phone: '' };

    // These containers nest — the outer one holds the business name and the
    // rating as well, so its text would glue "Bright Smile Dental" onto
    // "Dental clinic". Keep only leaf rows: a candidate that contains no other
    // candidate.
    const candidates = [...card.querySelectorAll('div.W4Efsd, div.fontBodyMedium')];
    const rows = candidates
      .filter((el) => !candidates.some((other) => other !== el && el.contains(other)))
      .map((el) => norm(el.textContent))
      .filter(Boolean);

    const nameText = nameKey(name);
    const parts = [];
    for (const row of rows) {
      for (const piece of row.split(/[·⋅]/)) {
        const p = norm(piece);
        // Belt and braces: never let the business name become the category.
        if (!p || parts.includes(p) || (nameText && nameKey(p) === nameText)) continue;
        parts.push(p);
      }
    }
    return parseCardParts(parts);
  }

  function extractCard(link) {
    const card = link.closest('div[jsaction]') || link.parentElement;
    const name = norm(link.getAttribute('aria-label')) || norm(card && card.querySelector('div.qBF1Pd')?.textContent);
    if (!name) return null;

    const { rating, reviews } = extractRating(card);
    const info = extractCardInfo(card, name);
    const site = card && card.querySelector('a[data-value="Website"], a[aria-label^="Visit"]');

    return {
      name,
      category: info.category,
      address: info.address,
      area: '',
      phone: info.phone,
      email: '',
      rating,
      reviews,
      website: site ? site.href : '',
      plusCode: '',
      mapsUrl: link.href,
      detailScraped: false,
    };
  }

  /** Read the open detail panel. Returns null while it is still loading. */
  function extractDetailPanel() {
    const main = document.querySelector(SEL.main);
    if (!main) return null;
    const h1 = main.querySelector(SEL.detailName);
    const name = norm(h1 && h1.textContent);
    if (!name) return null;

    const rec = { name, detailScraped: true };

    const addrBtn = main.querySelector(SEL.detailAddress);
    if (addrBtn) {
      const label = norm(addrBtn.getAttribute('aria-label'));
      rec.address = label.replace(/^address:\s*/i, '') || norm(addrBtn.textContent);
    }

    const phoneBtn = main.querySelector(SEL.detailPhone);
    if (phoneBtn) {
      // data-item-id is "phone:tel:+919876543210" — the cleanest source there is.
      rec.phone =
        phoneFromItemId(phoneBtn.getAttribute('data-item-id')) ||
        norm(phoneBtn.getAttribute('aria-label')).replace(/^phone:\s*/i, '') ||
        norm(phoneBtn.textContent);
    }

    const siteLink = main.querySelector(SEL.detailWebsite);
    if (siteLink && siteLink.href && !/google\.com/.test(siteLink.href)) rec.website = siteLink.href;

    const plus = main.querySelector(SEL.detailPlusCode);
    if (plus) rec.plusCode = norm(plus.getAttribute('aria-label')).replace(/^plus code:\s*/i, '');

    const cat = main.querySelector(SEL.detailCategory);
    if (cat) rec.category = norm(cat.textContent);

    const { rating, reviews } = extractRating(main);
    if (rating) rec.rating = rating;
    if (reviews) rec.reviews = reviews;

    return rec;
  }

  /* ---------------------------------------------------------- phase 1: feed */

  function feedReachedEnd(feed) {
    const tail = norm(feed.textContent).toLowerCase().slice(-400);
    return END_OF_LIST_HINTS.some((h) => tail.includes(h));
  }

  async function collectFromFeed(config) {
    const feed = await waitFor(() => document.querySelector(SEL.feed), { timeout: 15000 });
    if (!feed) return null;

    const byUrl = new Map();
    let stagnantRounds = 0;
    const maxResults = config.maxResults || 0;
    const scrollDelay = config.scrollDelay || 900;

    report({ phase: 'listing' });

    for (let round = 0; round < 400; round += 1) {
      if (state.cancelled) break;

      for (const link of feed.querySelectorAll(SEL.cardLink)) {
        if (byUrl.has(link.href)) continue;
        const rec = extractCard(link);
        if (rec) byUrl.set(link.href, rec);
      }

      const before = state.found;
      report({ found: byUrl.size, total: byUrl.size });

      if (maxResults && byUrl.size >= maxResults) break;
      if (feedReachedEnd(feed)) break;

      stagnantRounds = byUrl.size > before ? 0 : stagnantRounds + 1;
      // Maps sometimes pauses a beat before appending the next page; give it
      // a few empty rounds before calling it done.
      if (stagnantRounds >= 4) break;

      feed.scrollTo({ top: feed.scrollHeight, behavior: 'auto' });
      await sleep(scrollDelay);
    }

    const results = [...byUrl.values()];
    return maxResults ? results.slice(0, maxResults) : results;
  }

  /* -------------------------------------------------- phase 2: detail panels */

  async function openDetail(record, config) {
    const feed = document.querySelector(SEL.feed);
    if (!feed) return false;

    let link = feed.querySelector(`a[href="${CSS.escape(record.mapsUrl)}"]`);
    if (!link) {
      // The card scrolled out of the rendered window — find it again by name.
      link = [...feed.querySelectorAll(SEL.cardLink)].find(
        (a) => nameKey(a.getAttribute('aria-label')) === nameKey(record.name)
      );
    }
    if (!link) return false;

    link.scrollIntoView({ block: 'center' });
    await sleep(120);
    link.click();

    const panel = await waitFor(
      () => {
        const d = extractDetailPanel();
        if (!d) return null;
        // Guard against reading the previous business's panel.
        return nameKey(d.name) === nameKey(record.name) ? d : null;
      },
      { timeout: config.detailTimeout || 7000 }
    );
    return panel;
  }

  async function closeDetail() {
    const back = document.querySelector(SEL.backButton);
    if (back) back.click();
    else history.back();
    await waitFor(() => document.querySelector(SEL.feed), { timeout: 6000 });
    await sleep(150);
  }

  async function enrichWithDetails(records, config) {
    report({ phase: 'details', total: records.length });

    for (let i = 0; i < records.length; i += 1) {
      if (state.cancelled) break;
      const record = records[i];

      // Skip records that already carry everything deep mode would add.
      if (record.phone && record.website && record.address) {
        record.detailScraped = true;
        report({ detailed: i + 1 });
        continue;
      }

      try {
        const detail = await openDetail(record, config);
        if (detail) {
          for (const [k, v] of Object.entries(detail)) {
            if (v && (k !== 'name' || !record.name)) record[k] = v;
          }
        }
      } catch (err) {
        console.warn('[maps-lead-scraper] detail failed for', record.name, err);
      }

      try {
        await closeDetail();
      } catch {
        /* ignore — next openDetail re-checks for the feed */
      }

      report({ detailed: i + 1 });
      await sleep(config.detailDelay || 250);
    }
  }

  /* ----------------------------------------------------------------- driver */

  async function run(config) {
    if (document.querySelector(SEL.consent)) {
      throw new Error(
        'Google is showing a consent screen. Accept it in this tab, then run the scrape again.'
      );
    }

    let records = await collectFromFeed(config);

    if (!records) {
      // A search precise enough to match one business skips the list entirely.
      const single = await waitFor(() => extractDetailPanel(), { timeout: 6000 });
      if (!single) {
        throw new Error(
          'No results list found on this page. Make sure the tab is showing Google Maps search results.'
        );
      }
      records = [
        {
          name: single.name,
          category: '',
          address: '',
          area: '',
          phone: '',
          email: '',
          rating: '',
          reviews: '',
          website: '',
          plusCode: '',
          mapsUrl: location.href,
          ...single,
        },
      ];
    }

    if (config.deep !== false && records.length) {
      await enrichWithDetails(records, config);
    }

    for (const r of records) {
      r.area = deriveArea(r.address, config.city);
      r.city = config.city || '';
      r.searchCategory = config.category || '';
    }

    report({ phase: 'done' });
    return records;
  }

  /* --------------------------------------------------------------- messaging */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'PING') {
      sendResponse({ ok: true, running: state.running });
      return undefined;
    }

    if (msg.type === 'CANCEL_SCRAPE') {
      state.cancelled = true;
      sendResponse({ ok: true });
      return undefined;
    }

    if (msg.type === 'RUN_SCRAPE') {
      if (state.running) {
        sendResponse({ ok: false, error: 'A scrape is already running in this tab.' });
        return undefined;
      }
      state.running = true;
      state.cancelled = false;
      state.found = 0;
      state.detailed = 0;

      run(msg.config || {})
        .then((records) => sendResponse({ ok: true, records, cancelled: state.cancelled }))
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }))
        .finally(() => {
          state.running = false;
          state.phase = 'idle';
        });
      return true; // keep the message channel open for the async reply
    }

    return undefined;
  });
})();
