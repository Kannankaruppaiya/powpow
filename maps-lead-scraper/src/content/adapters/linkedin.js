/**
 * LinkedIn People search adapter.
 *
 * LinkedIn has no public API for people search, so this reads the page the
 * signed-in user is already looking at. Two consequences shape the code:
 *
 *   1. The result list is lazily hydrated. LinkedIn renders empty <li>
 *      skeletons and fills them as they approach the viewport, so a result
 *      that exists in the DOM may have no text yet. Anything without a profile
 *      link is treated as not-yet-rendered and simply retried next round.
 *
 *   2. Class names are build output and rotate constantly. Selectors here go
 *      through the same ladder as the Maps adapter: semantic attributes first
 *      (the /in/ profile link, aria-labels, roles), structural position next,
 *      hashed classes last and only as one option among several.
 *
 * Unlike Maps, the user drives this page — they can retype the query or change
 * a filter mid-run — so the adapter fingerprints the search and refuses to
 * keep collecting if it changes underneath.
 */
(() => {
  'use strict';

  const { norm, nameKey } = globalThis.MLSParse;

  const SEL = {
    profileLink: 'a[href*="/in/"]',
    // Filter controls in the bar above the results.
    filterPills: 'button[aria-label*="filter" i], .search-reusables__filter-pill-button',
    filterBar: '.search-reusables__filter-list, [class*="filter-list"]',
    paginationNext: 'button[aria-label="Next"]',
    endMarker: '.artdeco-pagination__indicator--number:last-child',
    authWall: 'form.login__form, .authwall, [data-test-id="auth-wall"]',
    captcha: '#captcha-internal, iframe[title*="captcha" i], .challenge-dialog',
  };

  // A trailing \b cannot match after the "+" in "3rd+" — "+" is not a word
  // character, so the boundary never fires and the match silently degrades to
  // "3rd". A negative lookahead for a word character is the correct edge here.
  const DEGREE_RE = /\b(1st|2nd|3rd\+?)(?!\w)/i;

  /**
   * Find the results list by shape, not by class name.
   *
   * Naming it was the original approach and it failed on the live site within
   * weeks: LinkedIn's classes are build output. What does not change is the
   * shape — a container whose children each hold a link to a profile. So count
   * how many sibling items under each candidate container carry a profile
   * link, and take the container with the most.
   *
   * This also steps around the promo cards LinkedIn injects mid-list, which
   * simply contribute no profile link and are ignored.
   */
  function findResultList() {
    const scope = document.querySelector('main') || document.body;
    const links = [...scope.querySelectorAll(SEL.profileLink)].filter((a) => profileUrl(a));
    if (links.length < 2) return null;

    const byContainer = new Map();
    for (const link of links) {
      const item = link.closest('li') || link.parentElement;
      const container = item && item.parentElement;
      if (!container) continue;
      if (!byContainer.has(container)) byContainer.set(container, new Set());
      byContainer.get(container).add(item);
    }

    let best = null;
    let bestCount = 0;
    for (const [container, items] of byContainer) {
      if (items.size > bestCount) {
        best = container;
        bestCount = items.size;
      }
    }
    // Two is enough to be a list; one is just a link somewhere on the page.
    return bestCount >= 2 ? best : null;
  }

  /** The result cards inside a list, whatever element type they happen to be. */
  function resultItems(list) {
    if (!list) return [];
    const lis = [...list.children].filter((el) => el.tagName === 'LI');
    return lis.length ? lis : [...list.children];
  }

  /**
   * The profile a card is *about*.
   *
   * Cards carry more than one profile link — "Suranjith Prasad is a mutual
   * connection" is one too — so the first is taken, which is the name.
   */
  function itemProfileUrl(item) {
    for (const link of item.querySelectorAll(SEL.profileLink)) {
      const url = profileUrl(link);
      if (url) return url;
    }
    return '';
  }

  /** The profile URL without tracking noise — the identity of a person. */
  function profileUrl(anchor) {
    if (!anchor || !anchor.href) return '';
    try {
      const url = new URL(anchor.href);
      if (!url.pathname.startsWith('/in/')) return '';
      // Strip the query LinkedIn appends; /in/<slug>/ is the stable part.
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return '';
    }
  }

  /**
   * The person's name.
   *
   * LinkedIn renders it twice inside the link — once visible, once for screen
   * readers ("Priya Sharma" plus "Priya Sharma’s profile") — so prefer the
   * aria-hidden span, which holds exactly the display name.
   */
  function extractName(item, anchor) {
    const hidden = anchor && anchor.querySelector('span[aria-hidden="true"]');
    const name = norm(hidden && hidden.textContent);
    if (name) return name;

    const titled = item.querySelector('.entity-result__title-text a, .app-aware-link span[dir="ltr"]');
    const fromTitle = norm(titled && titled.textContent).split('\n')[0];
    if (fromTitle) return fromTitle;

    return norm(anchor && anchor.textContent).split('View')[0].trim();
  }

  /** "Software Engineer at Acme" → { headline, company }. */
  function splitHeadline(headline) {
    const text = norm(headline);
    const at = text.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    return at ? { headline: text, company: norm(at[2]) } : { headline: text, company: '' };
  }

  function firstText(item, selectors) {
    for (const selector of selectors) {
      const el = item.querySelector(selector);
      const text = norm(el && el.textContent);
      if (text) return text;
    }
    return '';
  }

  function extractItem(item) {
    const url = itemProfileUrl(item);
    // No profile link means the skeleton has not hydrated yet.
    if (!url) return null;

    const anchor = [...item.querySelectorAll(SEL.profileLink)].find((a) => profileUrl(a) === url);
    const name = extractName(item, anchor);
    if (!name) return null;

    const rawHeadline = firstText(item, [
      '.entity-result__primary-subtitle',
      '[class*="primary-subtitle"]',
      'div.t-14.t-black.t-normal',
    ]);
    const { headline, company } = splitHeadline(rawHeadline);

    const location = firstText(item, [
      '.entity-result__secondary-subtitle',
      '[class*="secondary-subtitle"]',
      'div.t-14.t-normal.t-black--light',
    ]);

    const badge = firstText(item, ['.entity-result__badge-text', 'span.dist-value', '[class*="badge-text"]']);
    const degreeMatch = `${badge} ${norm(item.textContent).slice(0, 200)}`.match(DEGREE_RE);

    // "Open to work" is a photo frame, not text, so this is best effort: the
    // frame carries it in an image alt or a class name.
    const openToWork = Boolean(
      item.querySelector('[class*="open-to-work" i]') ||
        [...item.querySelectorAll('img[alt]')].some((img) => /open.?to.?work/i.test(img.alt))
    );

    return {
      name,
      headline,
      company,
      location,
      degree: degreeMatch ? degreeMatch[1].toLowerCase() : '',
      openToWork: openToWork ? 'Yes' : '',
      summary: firstText(item, ['.entity-result__summary', '[class*="entity-result__summary"]']),
      profileUrl: url,
      photoUrl: (item.querySelector('img[src*="licdn"]') || {}).src || '',
      email: '',
      detailScraped: false,
    };
  }

  /* ------------------------------------------------------------- filters */

  /**
   * Read whatever filters the user has actually applied.
   *
   * These are never hardcoded: the pills in the filter bar carry their current
   * state in aria-label / aria-pressed, and the URL carries the rest, so both
   * are read and merged.
   */
  function readFilters() {
    const filters = {};

    for (const pill of document.querySelectorAll(SEL.filterPills)) {
      const label = norm(pill.getAttribute('aria-label') || pill.textContent);
      if (!label) continue;
      const applied =
        pill.getAttribute('aria-pressed') === 'true' ||
        /\bfilter\b.*\bapplied\b/i.test(label) ||
        pill.classList.contains('artdeco-pill--selected');
      if (!applied) continue;

      // "Current company filter. Clicking this button displays..." → keep the head.
      const key = label.split(/filter|\./i)[0].trim();
      if (key) filters[key] = true;
    }

    // The URL is the authoritative record of an applied facet.
    const params = new URLSearchParams(location.search);
    for (const [key, value] of params) {
      if (['keywords', 'origin', 'sid', 'page'].includes(key)) continue;
      filters[key] = value;
    }
    return filters;
  }

  function searchContext() {
    const params = new URLSearchParams(location.search);
    return {
      query: norm(params.get('keywords') || ''),
      filters: readFilters(),
    };
  }

  /**
   * A stable summary of "which search is this". The user owns this page and
   * can retype the query mid-run; comparing this each round is how the adapter
   * notices rather than silently mixing two searches into one file.
   */
  function fingerprint() {
    const { query, filters } = searchContext();
    return `${nameKey(query)}|${Object.keys(filters).sort().map((k) => `${k}=${filters[k]}`).join('&')}`;
  }

  let expectedFingerprint = null;

  /* ---------------------------------------------------------- the adapter */

  globalThis.MLSAdapters = globalThis.MLSAdapters || {};
  globalThis.MLSAdapters.linkedin = {
    id: 'linkedin',

    matchesUrl(url) {
      return /^https:\/\/([\w-]+\.)?linkedin\.com\/search\/results\/(people|all)/.test(String(url || ''));
    },

    blockedReason() {
      if (document.querySelector(SEL.captcha)) {
        return 'LinkedIn is showing a security check. Solve it in this tab, then run the scrape again.';
      }
      if (document.querySelector(SEL.authWall)) {
        return 'You are signed out of LinkedIn. Sign in in this tab, then run the scrape again.';
      }
      return '';
    },

    getSearchContext() {
      expectedFingerprint = fingerprint();
      return searchContext();
    },

    async waitForResults() {
      const { waitFor } = globalThis.MLSEngine;
      // Wait for real content, not the skeletons LinkedIn paints first.
      return waitFor(() => findResultList(), { timeout: 20000 });
    },

    getResultIds(list) {
      return resultItems(list).map(itemProfileUrl).filter(Boolean);
    },

    extractResult(id, list) {
      const item = resultItems(list).find((el) => itemProfileUrl(el) === id);
      return item ? extractItem(item) : null;
    },

    reachedEnd() {
      // The user changing the query is an end condition too — better to stop
      // than to blend two different searches into one export.
      if (expectedFingerprint !== null && fingerprint() !== expectedFingerprint) {
        console.warn('[maps-lead-scraper] LinkedIn search changed mid-run; stopping.');
        return true;
      }
      const next = document.querySelector(SEL.paginationNext);
      return Boolean(next && next.disabled);
    },

    async loadMore(list) {
      const { sleep } = globalThis.MLSEngine;

      // LinkedIn hydrates on scroll, so walk the window down first.
      //
      // Count *usable* results, not raw children: the skeleton <li>s exist
      // from the start and hydrating one fills it in without adding an
      // element, so counting children would never register progress.
      const rendered = () => resultItems(list).filter(itemProfileUrl).length;
      const before = rendered();
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
      await sleep(600);

      if (rendered() > before) return true;

      // Page is exhausted — take the next one if there is one.
      const next = document.querySelector(SEL.paginationNext);
      if (next && !next.disabled) {
        next.click();
        await sleep(1200);
        window.scrollTo({ top: 0, behavior: 'auto' });
        return true;
      }
      return false;
    },

    // Everything worth having is on the card; opening each profile would
    // multiply the request count for very little, and is exactly the pattern
    // LinkedIn acts on.
    needsDetail() {
      return false;
    },

    finalise(records, config) {
      for (const r of records) {
        r.city = r.location || config.city || '';
        r.area = r.location || '';
        r.searchCategory = config.category || '';
      }
    },
  };
})();
