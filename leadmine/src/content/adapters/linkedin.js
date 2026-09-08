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

  /*
   * A person LinkedIn will not name.
   *
   * Outside your network — and once a month's searching passes LinkedIn's
   * commercial-use limit, well inside it too — a card comes back titled
   * "LinkedIn Member" with no profile link on it at all. There is no name and
   * no URL to collect, so the run cannot use it.
   *
   * It used to skip these in silence, and that silence is the bug: a search
   * showing twelve results and exporting three looks exactly like a broken
   * scraper. It is not. LinkedIn withheld nine identities, and saying so is
   * the difference between "this is broken" and "use the other source".
   */
  const ANONYMOUS = /^linkedin member$/i;

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

    /*
     * A card LinkedIn refused to name votes for its list too.
     *
     * The list used to be found as "the container holding the most profile
     * links", which quietly assumed every result has one. On a search whose
     * results are mostly outside your network that assumption inverts: nine
     * cards out of ten carry no link at all, so a handful of links in the
     * message overlay or a promoted card can out-vote the results — and a
     * page where NO result is named has nothing to vote at all, so the run
     * failed with "No results list found on this page" while looking at a
     * page full of results.
     *
     * A withheld card is still a card. It is found by the one thing LinkedIn
     * does render for it: the words "LinkedIn Member" as a leaf.
     */
    const nameless = [...document.querySelectorAll('span, div, p, h3')].filter(
      (el) => !el.children.length && ANONYMOUS.test(norm(el.textContent))
    );

    const byContainer = new Map();
    for (const link of [...links, ...nameless]) {
      let node = link;
      for (let up = 0; up < 10 && node.parentElement; up += 1) {
        const container = node.parentElement;
        if (!byContainer.has(container)) byContainer.set(container, new Set());
        byContainer.get(container).add(node);
        node = container;
      }
    }

    /*
     * A list's cards are siblings of one kind — li, li, li.
     *
     * Size alone cannot separate a list from the page holding it. On a search
     * whose results LinkedIn will not name, three cards in the list tie with
     * three regions of <body> that hold one card each: the results, a
     * promoted profile, the message overlay. <body> won that tie and the
     * promoted profile became a "result".
     *
     * Depth cannot separate them either, in either direction: while the list
     * is still hydrating it holds two cards, which ties with the two links
     * inside a single card — its profile anchor and its mutual-connection
     * footer — and the deeper of those is the card, not the list.
     *
     * What actually tells them apart is what the children are. A list's are
     * all the same tag; a page region holds a <main>, an <aside> and an
     * overlay, and one card holds an <a> and a <div>.
     */
    const uniform = (items) => items.size >= 2 && new Set([...items].map((el) => el.tagName)).size === 1;

    let list = null;
    let best = { size: 0, depth: Infinity, uniform: false };
    for (const [container, items] of byContainer) {
      const size = items.size;
      const depth = ancestorDepth(container);
      const alike = uniform(items);
      // Looking like a list beats being bigger. Among equals: the most cards,
      // then the shallower, which is the list rather than something inside a
      // card.
      const better =
        alike !== best.uniform
          ? alike
          : size > best.size || (size === best.size && depth < best.depth);
      if (better) {
        list = container;
        best = { size, depth, uniform: alike };
      }
    }

    return {
      // Two sibling cards is a list; one is just a link somewhere on the page.
      list: best.size >= 2 ? list : null,
      anchors: anchors.length,
      links: links.length,
      nameless: nameless.length,
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
      `links=${g.anchors} usable=${g.links} nameless=${g.nameless}` +
      ` groups=${g.containers} biggest=${g.items}` +
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
   * The control that brings the next results, found by what it says rather
   * than by an exact aria-label. `button[aria-label="Next"]` matched nothing
   * on the live site.
   *
   * Two labels, because LinkedIn ships two layouts: numbered pagination with
   * a Next button, and a list that grows behind a "Show more results" button.
   * Matching only "next" left the second one stuck at whatever had already
   * loaded.
   */
  const MORE_LABEL = /^next\b|next page|show more result|see more result|load more/i;

  function findNextButton() {
    // The pagination container is a hint about where to look first, never a
    // restriction: scoping the search to it meant that if any *other* element
    // happened to carry a "pagination" class, the real button was invisible.
    const pagination = document.querySelector('[class*="pagination" i]');
    for (const scope of [pagination, document].filter(Boolean)) {
      for (const el of scope.querySelectorAll('button, a[role="button"]')) {
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const label = norm(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
        if (MORE_LABEL.test(label)) return el;
      }
    }
    return null;
  }

  /**
   * Scroll to the foot of whatever is actually scrolling.
   *
   * `window.scrollTo` alone is a guess that the page scrolls. When the results
   * sit in their own scrollable panel it does nothing at all, and the lazy
   * list never hydrates past the first screenful.
   */
  function scrollToEnd(list) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    for (let el = list; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      const scrolls = /auto|scroll/.test(`${style.overflowY} ${style.overflow}`);
      if (scrolls && el.scrollHeight > el.clientHeight + 1) {
        el.scrollTop = el.scrollHeight;
        return;
      }
    }
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

  /**
   * Record a card that is a person but carries no identity.
   *
   * Only a card LinkedIn has explicitly titled "LinkedIn Member" counts. A
   * card with no link and no text is a skeleton that has not hydrated yet,
   * and one with a name but no link is something else going wrong — neither
   * is a withheld identity, and guessing they are would put a made-up number
   * in front of the user.
   */
  function noteWithheld(item) {
    const lines = cardLines(item).filter((line) => !NOISE.test(line));
    if (!lines.length || !ANONYMOUS.test(norm(lines[0]))) return;
    withheld.add(norm(lines.join(' | ')).slice(0, 200));
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

  /*
   * Cards seen but not collectable, fingerprinted so paging does not count
   * one person twice. Two anonymous people with the same headline and place
   * do collapse into one — which undercounts rather than overstates, and an
   * overstated number here would be its own lie.
   */
  const withheld = new Set();

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
    // "Current company filter. Clicking this button displays..." → keep the head.
    const filters = { ...readPills() };

    // The URL is the authoritative record of an applied facet.
    const params = new URLSearchParams(location.search);
    for (const [key, value] of params) {
      if (['keywords', 'origin', 'sid', 'page'].includes(key)) continue;
      filters[key] = value;
    }
    return filters;
  }

  /**
   * The URL parameters that are actually a facet the user chose.
   *
   * The fingerprint used to be built from *every* parameter except a four-item
   * denylist, and that is what stopped every paginated run at page two:
   * LinkedIn rewrites the URL as you page, adding its own tracking and session
   * parameters, so the fingerprint changed on its own and the adapter
   * concluded the user had changed the search.
   *
   * An allowlist fails in the right direction. A parameter we have not heard
   * of can no longer end a run; at worst a facet edit goes unnoticed — and the
   * filter pills below catch almost all of those anyway.
   */
  const FACET_PARAMS = new Set([
    'geoUrn', 'currentCompany', 'pastCompany', 'industry', 'network',
    'schoolFilter', 'schoolFreetext', 'serviceCategory', 'titleFreeText',
    'firstName', 'lastName', 'company', 'title', 'connectionOf', 'followerOf',
    'profileLanguage', 'openToVolunteer', 'contactInterest',
  ]);

  /**
   * Labels seen on filter options, keyed by the id LinkedIn puts in the URL.
   *
   * LinkedIn's facets take ids, not names — geoUrn wants 102713980, not
   * "India" — and those ids are internal, undocumented and not derivable. The
   * only place both halves appear together is the filter panel: the checkbox
   * carries the id, its label carries the name. So whenever the user ticks
   * one, both are recorded here, and `learnedUrns` pairs them with whichever
   * URL parameter the id then turns up in.
   *
   * Observation only. Nothing is inferred, and a value seen without a label
   * is simply not learned — a wrong id searches the wrong place and hands
   * back a plausible spreadsheet, which is worse than knowing nothing.
   */
  const seenLabels = new Map();

  /**
   * Options that appeared together, which is what makes one applied filter
   * teach ten.
   *
   * Typing "usa" into LinkedIn's location box renders United States, US Virgin
   * Islands, Uşak, Worcester and half a dozen more — every one of them with
   * its id sitting on the checkbox. Learning only the one that gets ticked
   * throws the other nine away, and then the panel's own list stays almost
   * empty however much the user browses.
   *
   * Options rendered in the same panel belong to the same facet, so the moment
   * *any* of them turns up in the URL, the whole batch is attributable — and
   * that is an observation, not a guess: they were on screen together.
   */
  const batches = [];

  function noteOption(input, batch) {
    if (!input || input.type !== 'checkbox' || !input.value) return;
    const byFor = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    const label = norm((byFor || input.closest('label') || input.parentElement || {}).textContent);
    // A bare number is the id echoed back, not a name for it.
    if (!label || /^\d+$/.test(label)) return;
    seenLabels.set(input.value, label);
    if (batch) batch.set(input.value, label);
  }

  /** Record the options a filter panel is showing right now, as one batch. */
  function noteBatch(root) {
    const boxes = (root || document).querySelectorAll('input[type="checkbox"]');
    if (!boxes.length) return;
    const batch = new Map();
    for (const input of boxes) noteOption(input, batch);
    // Two identical batches in a row are the same list re-rendered.
    if (!batch.size) return;
    const last = batches[batches.length - 1];
    if (last && last.size === batch.size && [...batch].every(([k, v]) => last.get(k) === v)) return;
    batches.push(batch);
    // A page visit does not need unbounded history.
    if (batches.length > 40) batches.shift();
  }

  document.addEventListener(
    'change',
    (event) => {
      const target = event.target;
      if (target && target.tagName === 'INPUT') noteOption(target);
    },
    true
  );

  /*
   * Watch for filter options arriving.
   *
   * LinkedIn's typeahead is network-backed, so the options appear well after
   * any click. Scanning only when a run starts would miss every list the user
   * scrolled past on the way here.
   */
  if (typeof MutationObserver === 'function') {
    let pending = null;
    new MutationObserver((mutations) => {
      const added = mutations.some((m) =>
        [...m.addedNodes].some(
          (node) =>
            node.nodeType === 1 &&
            (node.matches('input[type="checkbox"]') ||
              node.querySelector('input[type="checkbox"]'))
        )
      );
      if (!added || pending) return;
      // Debounced: a typeahead renders its rows one mutation at a time.
      pending = setTimeout(() => {
        pending = null;
        noteBatch(document);
      }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /**
   * Everything the current URL lets us attribute to a facet.
   *
   * An id in the URL names its own facet. Any other option that was on screen
   * beside it belongs to the same one, so a single applied filter teaches the
   * whole list it was chosen from.
   */
  function learnedUrns() {
    const out = [];
    const seenPair = new Set();

    const add = (facet, id, label) => {
      const token = `${facet}|${id}`;
      if (!label || seenPair.has(token)) return;
      seenPair.add(token);
      out.push({ facet, id: String(id), label });
    };

    for (const [facet, raw] of new URLSearchParams(location.search)) {
      if (!raw || raw[0] !== '[') continue;
      let values;
      try {
        values = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!Array.isArray(values)) continue;

      for (const id of values) {
        add(facet, id, seenLabels.get(String(id)));
        // Whatever shared a panel with it shares its facet.
        for (const batch of batches) {
          if (!batch.has(String(id))) continue;
          for (const [value, label] of batch) add(facet, value, label);
        }
      }
    }
    return out;
  }

  function searchContext() {
    const params = new URLSearchParams(location.search);
    // Anything already on screen when a run starts is worth recording too —
    // a panel left open, or options rendered before the observer attached.
    noteBatch(document);
    return {
      query: norm(params.get('keywords') || ''),
      filters: readFilters(),
      url: location.href,
      learned: learnedUrns(),
    };
  }

  /**
   * A stable summary of "which search is this". The user owns this page and
   * can retype the query mid-run; comparing this each round is how the adapter
   * notices rather than silently mixing two searches into one file.
   */
  function fingerprint() {
    const params = new URLSearchParams(location.search);
    const parts = [nameKey(params.get('keywords') || '')];

    // Only the facets, and only the pills the user has actually applied —
    // nothing the site rewrites while paging.
    for (const [key, value] of [...params].sort()) {
      if (FACET_PARAMS.has(key)) parts.push(`${key}=${value}`);
    }
    for (const key of Object.keys(readPills()).sort()) parts.push(`pill:${key}`);

    return parts.join('|');
  }

  /** The applied filter pills, which is how a mid-run filter change shows up. */
  function readPills() {
    const pills = {};
    for (const pill of document.querySelectorAll(SEL.filterPills)) {
      const label = norm(pill.getAttribute('aria-label') || pill.textContent);
      if (!label) continue;
      const applied =
        pill.getAttribute('aria-pressed') === 'true' ||
        /\bfilter\b.*\bapplied\b/i.test(label) ||
        pill.classList.contains('artdeco-pill--selected');
      if (!applied) continue;
      const key = label.split(/filter|\./i)[0].trim();
      if (key) pills[key] = true;
    }
    return pills;
  }

  /* ------------------------------------------------- resolving a filter */

  /*
   * Ask LinkedIn for its own id for a name.
   *
   * `geoUrn` wants 102713980, not "Chennai", and that number is LinkedIn's
   * own — undocumented, and not derivable from anything we hold. But the page
   * already contains a resolver: the filter panel's typeahead. Type into it
   * and LinkedIn answers with its options, each carrying its id.
   *
   * So this drives that box once per new name and remembers the answer.
   * Everything is found by shape rather than class name, because LinkedIn's
   * classes are build output and change without notice.
   */

  const FACET_PILL = { geoUrn: 'location', serviceCategory: 'service categor' };
  const APPLY_LABEL = /show results|apply|done/i;

  const accessibleName = (el) => norm(el.getAttribute('aria-label') || el.textContent);

  /** The pill that opens a facet, matched on the head of its label. */
  function findPill(facet) {
    const want = FACET_PILL[facet];
    if (!want) return null;
    for (const el of document.querySelectorAll('button')) {
      const head = accessibleName(el).split(/\s+filter\b/i)[0].trim().toLowerCase();
      if (head.startsWith(want)) return el;
    }
    return null;
  }

  /**
   * The open panel, by shape: whatever holds a text box and an apply button.
   *
   * It renders as a portal at the end of the document rather than inside the
   * pill, so anything scoped to the pill's subtree finds nothing.
   */
  function findPanel() {
    for (const box of document.querySelectorAll('input[type="text"], input[type="search"]')) {
      for (let el = box.parentElement; el && el !== document.body; el = el.parentElement) {
        const apply = [...el.querySelectorAll('button')].find((b) =>
          APPLY_LABEL.test(accessibleName(b))
        );
        if (apply) return { panel: el, box, apply };
      }
    }
    return null;
  }

  function optionsIn(panel) {
    return [...panel.querySelectorAll('input[type="checkbox"]')].map((input) => {
      const byFor = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      return {
        input,
        value: input.value,
        label: norm((byFor || input.closest('label') || input.parentElement || {}).textContent),
      };
    });
  }

  /** Type the way a person does, so a framework-bound box actually reacts. */
  function typeInto(box, text) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const fold = (text) => norm(text).toLowerCase().replace(/[.,]/g, '');

  /**
   * Find a filter value in its panel and either read it or apply it.
   *
   * The same six steps either way — open the pill, type, wait for the
   * network-backed list, match, tick — and then a choice: put the panel back
   * (a lookup) or press Show results (a filter the user asked for).
   */
  async function pickInPanel({ facet, label, apply }, { waitFor, sleep }) {
    const pill = findPill(facet);
    if (!pill) return { ok: false, reason: `this page has no ${facet} filter` };

    pill.click();
    const found = await waitFor(findPanel, { timeout: 6000 });
    if (!found) return { ok: false, reason: 'the filter panel did not open' };

    typeInto(found.box, label);
    // The list is network-backed: wait for options rather than for a delay.
    const options = await waitFor(
      () => {
        const list = optionsIn(found.panel).filter((o) => o.value && o.label);
        return list.length ? list : null;
      },
      { timeout: 10000 }
    );
    if (!options) return { ok: false, reason: `LinkedIn offered nothing for “${label}”` };

    // Exact first. A prefix is the fallback, so "Chennai" finds "Chennai,
    // Tamil Nadu, India" — but never a substring, which would let "India"
    // match "Theni, Tamil Nadu, India".
    const wanted = fold(label);
    const hit =
      options.find((o) => fold(o.label) === wanted) ||
      options.find((o) => fold(o.label).startsWith(wanted));

    // Whatever was offered is worth keeping either way; a near miss now is an
    // exact hit the next time the user types one of these names.
    noteBatch(found.panel);

    if (!hit) {
      return {
        ok: false,
        reason: `LinkedIn does not offer “${label}”`,
        offered: options.map((o) => o.label).slice(0, 8),
      };
    }

    const id = hit.value;
    if (!hit.input.checked) hit.input.click();
    await sleep(150);

    if (!apply) {
      // A lookup: leave the page exactly as it was found.
      if (hit.input.checked) hit.input.click();
      pill.click();
      return { ok: true, facet, id, label: hit.label };
    }

    // Applying is LinkedIn's own job — press its button and let it build the
    // URL. That is why no id has to be known in advance: the page knows.
    const before = location.href;
    found.apply.click();
    const changed = await waitFor(
      () => (location.href !== before ? location.href : null),
      { timeout: 8000 }
    );
    if (!changed) return { ok: false, reason: `“${hit.label}” did not apply` };
    return { ok: true, facet, id, label: hit.label, url: changed };
  }

  const resolveFacet = (want, helpers) => pickInPanel({ ...want, apply: false }, helpers);

  /**
   * Apply every filter the run asked for, in LinkedIn's own UI.
   *
   * This is what makes the ids optional. Rather than building a URL out of
   * numbers nobody publishes, the page is driven the way a person would drive
   * it — type the name, tick what comes back, press Show results — and
   * LinkedIn writes the URL itself. Every option seen on the way is learned,
   * so the next run for the same place could skip all of this.
   */
  async function applyFilters(wants, helpers) {
    const applied = [];
    for (const want of wants || []) {
      // eslint-disable-next-line no-await-in-loop
      const result = await pickInPanel({ ...want, apply: true }, helpers);
      if (!result.ok) return { ok: false, reason: result.reason, applied };
      applied.push({ facet: result.facet, id: result.id, label: result.label });
      // eslint-disable-next-line no-await-in-loop
      await helpers.sleep(600);
    }
    return { ok: true, applied, url: location.href };
  }

  let expectedFingerprint = null;
  let endReason = '';

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

    resolveFacet,
    applyFilters,

    getSearchContext() {
      expectedFingerprint = fingerprint();
      endReason = '';
      withheld.clear();
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
      if (!live) return [];
      const ids = [];
      for (const item of resultItems(live)) {
        const url = itemProfileUrl(item);
        if (url) ids.push(url);
        else noteWithheld(item);
      }
      return ids;
    },

    extractResult(id, list) {
      const live = liveList(list);
      const item = live && resultItems(live).find((el) => itemProfileUrl(el) === id);
      return item ? extractItem(item) : null;
    },

    // Why this adapter stopped, when the reason is its own rather than the
    // page's. "The source said there are no more" was reported for a search
    // the adapter itself had decided to abandon, which sent everyone looking
    // at LinkedIn instead of at this file.
    get endReason() {
      return endReason;
    },

    reachedEnd() {
      // The user changing the query is an end condition too — better to stop
      // than to blend two different searches into one export.
      if (expectedFingerprint !== null && fingerprint() !== expectedFingerprint) {
        console.warn('[leadmine] LinkedIn search changed mid-run; stopping.');
        endReason = 'the search on the page changed';
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
      //
      // Twice, with a wait between, because LinkedIn renders in chunks: one
      // jump to the bottom moves the bottom, and the footer that carries the
      // pagination is the last thing to arrive.
      const before = idsNow();
      scrollToEnd(liveList(list));
      await sleep(700);
      scrollToEnd(liveList(list));
      await sleep(700);

      // Count *usable* results, not raw children: skeleton items exist from
      // the start and hydrating one fills it in without adding an element.
      if (idsNow().length > before.length) return true;

      // Wait for the control rather than looking once. A single check the
      // moment scrolling stops finds nothing on a page that renders its
      // footer late, and the run then ends after one page of ten.
      const next = await waitFor(findNextButton, { timeout: 4000 });
      if (!next) {
        endReason = 'LinkedIn offered no next page';
        return false;
      }

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
      if (!turned) endReason = 'the next page did not load';
      return Boolean(turned);
    },

    // Everything worth having is on the card; opening each profile would
    // multiply the request count for very little, and is exactly the pattern
    // LinkedIn acts on.
    needsDetail() {
      return false;
    },

    finalise(records, config, context) {
      for (const r of records) {
        r.city = r.location || config.city || '';
        r.area = r.location || '';
        r.searchCategory = config.category || '';
      }
      // The count travels with the run, not in a console warning nobody has
      // open: this is the answer to "why only three?".
      if (context) context.withheld = withheld.size;
    },
  };
})();
