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
   * shape — a container whose children each hold a link to a profile.
   */
  function findResultList() {
    return groupResults().list;
  }

  /**
   * Group the page's profile links into result cards and their container.
   *
   * Every ancestor is a candidate container, not just the first one with two
   * link-bearing children. Stopping at the first meant a card's own inner
   * wrapper won — grouping the person with the "is a mutual connection" link
   * beneath them, instead of grouping the cards with each other.
   *
   * Returns the counts alongside the result, because when this finds nothing
   * the counts are the only way to tell why.
   */
  function groupResults() {
    // Search the whole document. Scoping to <main> was a guess about where
    // LinkedIn puts its results, and a wrong one is indistinguishable from
    // "no results" — sibling cards are evidence enough wherever they sit.
    const anchors = [...document.querySelectorAll(SEL.profileLink)];
    const links = anchors.filter((a) => profileUrl(a) && !a.closest('nav, header'));

    const byContainer = new Map();
    for (const link of links) {
      let node = link;
      for (let up = 0; up < 10 && node.parentElement; up += 1) {
        const container = node.parentElement;
        if (!byContainer.has(container)) byContainer.set(container, new Set());
        byContainer.get(container).add(node);
        node = container;
      }
    }

    let list = null;
    let best = { size: 0, depth: Infinity };
    for (const [container, items] of byContainer) {
      const size = items.size;
      const depth = ancestorDepth(container);
      // The most cards wins. On a tie the shallower container wins, because
      // that is the list itself rather than something inside one card.
      if (size > best.size || (size === best.size && depth < best.depth)) {
        list = container;
        best = { size, depth };
      }
    }

    return {
      // Two sibling cards is a list; one is just a link somewhere on the page.
      list: best.size >= 2 ? list : null,
      anchors: anchors.length,
      links: links.length,
      containers: byContainer.size,
      items: best.size,
    };
  }

  function ancestorDepth(node) {
    let depth = 0;
    for (let el = node; el; el = el.parentElement) depth += 1;
    return depth;
  }


  /**
   * What the page actually looks like, for when detection fails.
   * A user can paste this; "no results found" on a page full of results cannot
   * be acted on by anyone.
   */
  function describeDom() {
    const g = groupResults();
    const sample = [...document.querySelectorAll(SEL.profileLink)]
      .slice(0, 3)
      .map((a) => {
        const raw = a.getAttribute('href') || '';
        return `${raw.slice(0, 60)}${a.closest('li') ? ' [in li]' : ' [no li]'}`;
      });
    return (
      `links=${g.anchors} usable=${g.links} groups=${g.containers} biggest=${g.items}` +
      `; lists=${document.querySelectorAll('ul').length}` +
      `; main=${document.querySelector('main') ? 'yes' : 'no'}` +
      (sample.length ? `; samples: ${sample.join(' | ')}` : '')
    );
  }

  /**
   * The list as it exists right now.
   *
   * LinkedIn replaces the results wholesale when you page, so a node captured
   * on page 1 is detached by page 2 and reports nothing.
   */
  function liveList(list) {
    return list && list.isConnected ? list : findResultList();
  }

  /**
   * The pagination control, found by what it says rather than by an exact
   * aria-label. `button[aria-label="Next"]` matched nothing on the live site.
   */
  function findNextButton() {
    const scope = document.querySelector('[class*="pagination" i]') || document;
    for (const el of scope.querySelectorAll('button, a[role="button"]')) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const label = norm(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
      if (/^next\b|next page/i.test(label)) return el;
    }
    return null;
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
   * The card's visible text, one entry per rendered line.
   *
   * innerText is the right tool here and querySelector is not: it returns what
   * a person actually sees, in reading order, and it does not care what any of
   * it is called. Every class-based extractor written for this page has been
   * broken by LinkedIn within weeks; line order has not changed in years.
   */
  function cardLines(item) {
    const lines = [];
    for (const raw of String(item.innerText || '').split('\n')) {
      const line = undouble(norm(stripScreenReader(raw)));
      // The doubling is sometimes across lines rather than within one.
      if (!line || line === lines[lines.length - 1]) continue;
      lines.push(line);
    }
    return lines;
  }

  /**
   * Drop the link text LinkedIn renders for screen readers.
   *
   * It sits inline next to the visible name, so it lands on the same line and
   * would otherwise be read as part of the person's name.
   */
  function stripScreenReader(text) {
    // No leading word boundary: the copy sits flush against the visible name,
    // so the text can read "Anubha GoelView Anubha Goel's profile".
    return String(text).replace(/view\s+.{1,60}?['’]s\s+profile/gi, ' ');
  }

  /**
   * "Priya Sharma Priya Sharma • 2nd" -> "Priya Sharma • 2nd".
   *
   * LinkedIn prints the name twice — once visible, once for assistive tech —
   * in two inline spans, which innerText joins into a single line. Dropping
   * repeated *lines* misses this; the repeat has to be undone within the line.
   */
  function undouble(line) {
    // The two spans sit flush against each other, so there may be no space
    // between the copies at all: "Priya SharmaPriya Sharma".
    return norm(line.replace(/^(.{4,60}?)\s*\1(?=$|[\s•·,|])/, '$1'));
  }

  /** Buttons and affordances that are chrome, not information. */
  const NOISE =
    /^(connect|message|follow|following|view full profile|invite|pending|\d+(\.\d+)?k? followers?)$/i;

  const DEGREE_ONLY = /^[•·]?\s*(1st|2nd|3rd\+?)\s*(degree)?\s*(connection)?$/i;
  const CONTEXT_LINE = /^(current|past|about|summary)\s*:/i;
  const MUTUAL_LINE = /\bmutual connections?\b/i;

  /**
   * Does this line look like a place rather than a job title?
   *
   * Locations are short, comma-separated and free of the punctuation people
   * pack headlines with. "Indore, Madhya Pradesh, India" passes;
   * "Technical Trainer|C,C++,Java FSD" does not, despite the commas.
   */
  function looksLikeLocation(line) {
    if (!line || line.length > 70) return false;
    if (/[|@:/]/.test(line)) return false;
    if (MUTUAL_LINE.test(line) || CONTEXT_LINE.test(line)) return false;
    const parts = line.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 4) return false;
    // A headline fragment is usually long; place names are not.
    return parts.every((p) => p.length <= 32);
  }

  /** "Current: Technical Trainer at Oracle" -> "Oracle". Also handles "@Acme". */
  function companyFrom(text) {
    const value = norm(text).replace(CONTEXT_LINE, '');
    const at = value.match(/\s+at\s+([^|·•]+)$/i) || value.match(/@\s*([^|·•(]+)/);
    return at ? norm(at[1]).replace(/[.,]$/, '') : '';
  }

  /**
   * Read one result card.
   *
   * Everything below the profile URL comes from the card's lines and their
   * order, not from any class name. LinkedIn now wraps the whole card in the
   * profile link, so reading the anchor's text gets the entire card and the
   * name twice — which is exactly what the previous version exported.
   */
  function extractItem(item) {
    const url = itemProfileUrl(item);
    // No profile link means the skeleton has not hydrated yet.
    if (!url) return null;

    const lines = cardLines(item).filter((line) => !NOISE.test(line));
    if (!lines.length) return null;

    // The name is the first line, minus any degree badge sharing it.
    const name = norm(lines[0].replace(/\s*[•·]\s*(1st|2nd|3rd\+?)\s*$/i, ''));
    if (!name) return null;

    const rest = lines.slice(1);
    const degreeMatch = lines.slice(0, 3).join(' ').match(DEGREE_RE);
    const contextLine = rest.find((line) => CONTEXT_LINE.test(line)) || '';
    const locationLine = rest.find(looksLikeLocation) || '';

    // The headline is the first line that is not the degree, the location,
    // the "Current:" context or the mutual-connection footer.
    const headline =
      rest.find(
        (line) =>
          !DEGREE_ONLY.test(line) &&
          line !== locationLine &&
          !CONTEXT_LINE.test(line) &&
          !MUTUAL_LINE.test(line)
      ) || '';

    // "Open to work" is a photo frame, not text, so this is best effort.
    const openToWork = Boolean(
      item.querySelector('[class*="open-to-work" i]') ||
        [...item.querySelectorAll('img[alt]')].some((img) => /open.?to.?work/i.test(img.alt))
    );

    return {
      name,
      headline,
      company: companyFrom(contextLine) || companyFrom(headline),
      location: locationLine,
      degree: degreeMatch ? degreeMatch[1].toLowerCase() : '',
      openToWork: openToWork ? 'Yes' : '',
      summary: contextLine,
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
      const list = await waitFor(() => findResultList(), { timeout: 20000 });
      if (list) return list;

      // LinkedIn's markup changes often enough that "not found" has to carry
      // evidence, or every breakage costs a guessing round.
      throw new Error(
        `Could not find the results on this LinkedIn page. Details for a bug report — ${describeDom()}`
      );
    },

    getResultIds(list) {
      const live = liveList(list);
      return live ? resultItems(live).map(itemProfileUrl).filter(Boolean) : [];
    },

    extractResult(id, list) {
      const live = liveList(list);
      const item = live && resultItems(live).find((el) => itemProfileUrl(el) === id);
      return item ? extractItem(item) : null;
    },

    reachedEnd() {
      // The user changing the query is an end condition too — better to stop
      // than to blend two different searches into one export.
      if (expectedFingerprint !== null && fingerprint() !== expectedFingerprint) {
        console.warn('[leadmine] LinkedIn search changed mid-run; stopping.');
        return true;
      }
      // Exhaustion is loadMore's call: no Next button does not mean this page
      // has finished hydrating, and treating it that way cut the last cards
      // off every final page.
      return false;
    },

    async loadMore(list) {
      const { sleep, waitFor } = globalThis.MLSEngine;

      const idsNow = () => {
        const live = liveList(list);
        return live ? resultItems(live).map(itemProfileUrl).filter(Boolean) : [];
      };

      // Scroll first: it hydrates lazily-rendered cards, and it is also what
      // brings the pagination control into the DOM at the foot of the page.
      const before = idsNow();
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
      await sleep(700);

      // Count *usable* results, not raw children: skeleton items exist from
      // the start and hydrating one fills it in without adding an element.
      if (idsNow().length > before.length) return true;

      const next = findNextButton();
      if (!next) return false;

      next.click();
      // Wait for the list to actually turn over rather than guessing at a
      // delay — the first result changing is the signal the page has moved.
      const turned = await waitFor(
        () => {
          const ids = idsNow();
          return ids.length && ids[0] !== before[0] ? ids : null;
        },
        { timeout: 15000 }
      );
      window.scrollTo({ top: 0, behavior: 'auto' });
      return Boolean(turned);
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
