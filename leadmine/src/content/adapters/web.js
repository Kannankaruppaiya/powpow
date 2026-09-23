/**
 * Public-web adapter: LinkedIn profiles found through a search engine.
 *
 * The reason this exists is a hard limit in the other adapter. LinkedIn's
 * logged-in people search *anonymises anyone outside your network* — the card
 * reads "LinkedIn Member" with no name — so a search that reaches the whole
 * site still hands back rows nobody can act on. The same person's public
 * profile page names them. It is a discovery problem, not a reading one: the
 * profile is readable, the URL is what is missing.
 *
 * Search engines have that URL. They have indexed hundreds of millions of
 * public LinkedIn profiles, and a result carries the name and the headline in
 * its title. No LinkedIn login, no connection degree, no anonymising.
 *
 * Everything here is found by SHAPE, because the engines this has to survive
 * lay their results out differently and all of them change:
 *
 *   - a result is any link that resolves to linkedin.com/in/<slug>
 *   - its title is a heading inside that link, or the link's own text
 *   - its snippet is whatever text sits around it, up to the next person
 *
 * Profiles are never opened. The title already carries the name and headline,
 * and opening each one multiplies the request count for very little — the same
 * call the LinkedIn adapter makes with `needsDetail`.
 */
(() => {
  'use strict';

  const { norm } = globalThis.MLSParse;

  const PROFILE = /(?:^|\.)linkedin\.com\/in\/([^/?#]+)/i;

  /**
   * The profile URL a link points at, following one layer of redirect.
   *
   * DuckDuckGo wraps every result in `/l/?uddg=<encoded>`; Google mostly links
   * straight out. Unwrapping one layer covers both without knowing which
   * engine this is.
   */
  function profileFrom(anchor) {
    const raw = anchor.getAttribute('href') || '';
    if (!raw) return null;

    let href = raw;
    try {
      const url = new URL(raw, location.href);
      const wrapped = url.searchParams.get('uddg') || url.searchParams.get('url');
      if (wrapped && PROFILE.test(wrapped)) href = wrapped;
      else href = url.href;
    } catch {
      /* a relative or malformed href — fall through to the raw string */
    }

    const match = decodeURIComponent(href).match(PROFILE);
    if (!match) return null;
    const slug = match[1].replace(/\/$/, '');
    // A slug is a person. /in/ also carries LinkedIn's own marketing pages.
    if (!slug || /^(edit|me|unavailable)$/i.test(slug)) return null;
    return { slug: slug.toLowerCase(), url: `https://www.linkedin.com/in/${slug}` };
  }

  /** Does this text read like a URL rather than a title? */
  const URLISH = /^(?:https?:|www\.)/i;
  const isUrlish = (text) => URLISH.test(text) || /linkedin\.com/i.test(text.replace(/\s*[›>/]\s*/g, ''));

  /**
   * Every distinct profile on the page, each paired with its best anchor.
   *
   * A result carries the same profile two or three times — the title, the
   * breadcrumb URL under it, sometimes a thumbnail — and they are not in a
   * fixed order across engines. Taking the first would put
   * "linkedin.com › in › priya-sharma" in the Name column, so the anchor that
   * reads like a title wins: not URL-shaped, and the longest of what is left.
   */
  function profileAnchors(root) {
    const found = [];
    for (const anchor of root.querySelectorAll('a[href]')) {
      const profile = profileFrom(anchor);
      // A link with no text is an image or a tracking pixel, not a result.
      if (profile && norm(anchor.textContent)) found.push({ anchor, ...profile });
    }
    return found;
  }

  const depthOf = (el) => {
    let n = 0;
    for (let e = el; e; e = e.parentElement) n += 1;
    return n;
  };

  /**
   * The part of the page the results live in.
   *
   * Every engine's header links to something — and on a query like
   * `site:linkedin.com/in` one of those links is a profile, which then walks
   * into the export as a person nobody searched for. Chrome is a lone link
   * far from the crowd; results come in a cluster. So: the deepest element
   * that still holds a majority of the profiles on the page. Falls back to
   * the whole document when there are too few results for a majority to mean
   * anything.
   */
  function resultsRoot(doc = document) {
    const anchors = profileAnchors(doc);
    const total = new Set(anchors.map((a) => a.slug)).size;
    const need = Math.max(2, Math.ceil(total / 2));

    const holds = (el) =>
      new Set(anchors.filter((a) => el.contains(a.anchor)).map((a) => a.slug)).size >= need;

    let best = doc.body || doc.documentElement;
    let bestDepth = -1;
    for (const { anchor } of anchors) {
      for (let el = anchor.parentElement; el; el = el.parentElement) {
        if (!holds(el)) continue;
        const depth = depthOf(el);
        if (depth > bestDepth) {
          best = el;
          bestDepth = depth;
        }
        break;
      }
    }
    return best;
  }

  /**
   * Is this link a result, or is it part of the page?
   *
   * The cluster rule alone cannot tell: on a page where the query matched
   * nothing, the engine's own header link to a profile is the ONLY profile
   * link, so it is trivially the majority and came back as a person named
   * "LinkedIn" — a fabricated row on an empty search, which is the worst
   * failure this adapter has.
   *
   * A result is titled. Every engine puts that title in a heading, on one
   * side of the link or the other, and gives it a line of text underneath. A
   * navigation link has neither.
   */
  const looksLikeResult = (anchor) => Boolean(headingOf(anchor)) || Boolean(snippetFor(anchor));

  function resultLinks() {
    const best = new Map();
    for (const { anchor, ...profile } of profileAnchors(resultsRoot())) {
      if (!looksLikeResult(anchor)) continue;
      const title = titleOf(anchor);
      const score = isUrlish(title) ? 0 : title.length;
      const held = best.get(profile.slug);
      if (held && held.score >= score) continue;
      best.set(profile.slug, { anchor, score, ...profile });
    }
    return [...best.values()];
  }

  /**
   * The title text of a result.
   *
   * DuckDuckGo puts the anchor inside the heading, so the anchor's own text is
   * the title. Google does the opposite: the anchor wraps the site line AND
   * the heading, so its text reads "LinkedIn · K P Ranjith Kumar 4.8K+
   * followers K P Ranjith Kumar - Transforming corporate teams…" and the Name
   * column gets all of it. A heading inside the link is the title whenever
   * there is one — that is what a heading means.
   */
  const HEADING = 'h1, h2, h3, h4, h5, h6';

  /** The heading a result is titled by, whichever side of the link it is on. */
  const headingOf = (anchor) => anchor.querySelector(HEADING) || anchor.closest(HEADING);

  function titleOf(anchor) {
    const heading = headingOf(anchor);
    return norm(heading ? heading.textContent : anchor.textContent);
  }

  /**
   * Split a result title into a name and a headline.
   *
   * The shape every engine shows is the same, because it is LinkedIn's own
   * page title: "Raghu Vaidyanathan - Manager Finance at Visesh Cargo |
   * LinkedIn". The separator is a hyphen or an en/em dash, and only the first
   * one splits — plenty of names contain the second.
   */
  function splitTitle(title) {
    const text = norm(title)
      // Trailing site name, in whichever language the engine served.
      .replace(/\s*[|·]\s*LinkedIn\s*$/i, '')
      .trim();
    const at = text.search(/\s+[-–—]\s+/);
    if (at === -1) return { name: text, headline: '' };
    return {
      name: text.slice(0, at).trim(),
      headline: text.slice(at).replace(/^\s*[-–—]\s*/, '').trim(),
    };
  }

  /** "… at Trioangle Technologies" → the employer. */
  function companyFrom(headline) {
    const match = norm(headline).match(/\bat\s+(.+)$/i);
    return match ? match[1].replace(/[.,]$/, '').trim() : '';
  }

  const PLACE = /,\s*[A-Z]/;
  const NOISE = /^(https?:|www\.|\d+\s*(days?|hours?|weeks?|months?)\s+ago)/i;

  // "Chennai, Tamil Nadu, India" — two or three capitalised parts, each at
  // most three words, separated by commas. Loose enough for any country's
  // place names, tight enough that a sentence does not match it.
  //
  // No full stop inside a word, deliberately: with one, "…at Globex.
  // Coimbatore, Tamil Nadu, India" matches from "Globex" and the employer
  // lands in the Location column. The cost is a "St." losing its prefix,
  // which is a smaller wrong answer than a sentence boundary being read as
  // part of a place.
  const PART = "[A-Z][\\w'’-]*(?: [A-Z][\\w'’-]*){0,2}";
  const PLACE_RUN = new RegExp(`${PART}, ${PART}(?:, ${PART})?`, 'g');

  const placeLike = (piece) =>
    piece && piece.length <= 60 && !NOISE.test(piece) && PLACE.test(piece) && !/\bat\b/i.test(piece);

  /**
   * A location out of the snippet, if it reads like one.
   *
   * Snippets are prose and vary by engine, so this only accepts a fragment
   * that looks like a place — "Chennai, Tamil Nadu, India" — rather than
   * guessing at the first line. Engines that bullet their fields give it up
   * whole; the rest need the place picked out of the middle of a sentence,
   * which is what the second pass does.
   */
  function locationFrom(text) {
    const flat = norm(text);
    for (const part of flat.split(/\s*[·|•]\s*|\s{2,}/)) {
      const piece = part.trim().replace(/[.;]+$/, '');
      if (placeLike(piece)) return piece;
    }
    for (const match of flat.match(PLACE_RUN) || []) {
      if (placeLike(match)) return match;
    }
    return '';
  }

  /** The distinct profiles linked from inside an element. */
  function slugsIn(el) {
    const slugs = new Set();
    for (const anchor of el.querySelectorAll('a[href]')) {
      const profile = profileFrom(anchor);
      if (profile) slugs.add(profile.slug);
    }
    return slugs;
  }

  /**
   * The text around a result, which is where the snippet lives.
   *
   * Climbing stops by shape, not by length: the moment a block links to a
   * second person it is the results list, not one result, and anything read
   * from there belongs to somebody else. A block linking to the same person
   * three times is still one result, so distinct profiles are what is
   * counted.
   */
  function snippetFor(anchor) {
    let best = anchor.parentElement || document.body;
    for (let el = best, hops = 0; el && el !== document.body && hops < 6; el = el.parentElement, hops += 1) {
      if (slugsIn(el).size > 1) break;
      best = el;
    }
    // Every link to this same person is chrome, not snippet: the title, and
    // the breadcrumb URL printed under it. Leaving the breadcrumb in put
    // "linkedin.com > in > priya-sharma Chennai, Tamil Nadu, India" in the
    // Location column, because it sits in the same run of text as the place.
    let text = norm(best.textContent);
    for (const link of best.querySelectorAll('a[href]')) {
      if (!profileFrom(link)) continue;
      for (const label of new Set([norm(link.textContent), titleOf(link)])) {
        if (label) text = text.replace(label, ' ');
      }
    }
    return norm(text);
  }

  /*
   * A challenge page, in the words the engines actually use.
   *
   * The first version of this looked for "unusual traffic" and "captcha" —
   * Google's words. Bing's challenge says "One last step / Please solve the
   * challenge below to continue / Verifying…" and matched none of them, so a
   * live run read the challenge page as an empty result set and reported
   * "the search engine offered no next page". A wrong reason is worse than no
   * reason: it sends everyone to look at the query.
   */
  const CHALLENGE =
    /unusual traffic|are you a robot|verify (?:you are|that you are) (?:a )?human|captcha|solve the challenge|one last step|before you continue|automated queries|access denied|too many requests/i;

  function challengeIn(doc) {
    const body = doc && doc.body;
    if (!body) return false;
    // innerText is layout-dependent and empty in a parsed document, so the
    // fetched next page needs textContent. Either way only the top of the
    // page matters: a challenge is all a challenge page has on it.
    const text = norm(body.innerText || body.textContent || '').slice(0, 600);
    return CHALLENGE.test(text);
  }

  const MORE_LABEL = /^next\b|next page|more results|show more/i;

  function findNext(doc = document) {
    for (const el of doc.querySelectorAll('a[href], button')) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const label = norm(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
      if (MORE_LABEL.test(label)) return el;
    }
    return null;
  }

  /**
   * The URL a Next control leads to, or '' if it is not one.
   *
   * The origin check is the whole of this function's safety. `findNext`
   * searches every link on the page, and on a search engine the links are
   * results — content an attacker can rank and title. A result titled "Show
   * more results for kotlin trainers" matches the label pattern as well as
   * the engine's own control does, and sits above it in document order.
   *
   * Without this check that URL was fetched with credentials and its markup
   * imported into the live page: a request to a site of the attacker's
   * choosing carrying whatever cookies the user has there, and their HTML
   * dropped into the search engine's own origin.
   *
   * The next page of a search is on the search engine. Anything else is not
   * a next page, whatever it calls itself.
   */
  function nextUrl(doc) {
    const el = findNext(doc);
    if (!el) return '';
    const href = el.getAttribute('href') || '';
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return '';
    try {
      const url = new URL(href, location.href);
      return url.origin === location.origin ? url.href : '';
    } catch {
      return '';
    }
  }

  /*
   * Markup from another page, made inert before it touches this one.
   *
   * DOMParser does not run anything, but these nodes are about to be inserted
   * into a live document, where an `onerror` on an <img> fires immediately —
   * in the page's own origin, not this script's isolated world. Result markup
   * is not trusted input, so nothing that can execute survives the trip.
   */
  const EXECUTABLE = 'script, iframe, object, embed, link, meta, base, form';

  function sanitise(node) {
    for (const el of [node, ...node.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        else if (
          (name === 'href' || name === 'src' || name === 'action' || name === 'formaction') &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    }
    for (const el of node.querySelectorAll(EXECUTABLE)) el.remove();
    return node.matches && node.matches(EXECUTABLE) ? null : node;
  }

  let endReason = '';

  /*
   * The page the next Next link is read from.
   *
   * Paging here does not click. On an engine, Next is a full navigation, and a
   * navigation destroys the content script mid-run — the scrape would be
   * abandoned with whatever page one gave and no error anywhere. So the next
   * page is fetched and its results are appended to the ones already on
   * screen, which is also what the harvest loop upstream expects: a list that
   * grows. This holds the last page fetched, so page three is found from page
   * two rather than from the page still in the tab.
   */
  let latest = null;

  globalThis.MLSAdapters = globalThis.MLSAdapters || {};
  globalThis.MLSAdapters.web = {
    id: 'web',

    matchesUrl(url) {
      // A results page on one of the engines — never Maps, which has its own
      // adapter and also lives on google.com.
      // DuckDuckGo's results live at the site root ("/?q="), not under
      // /search, so one path pattern does not cover both engines.
      return (
        /^https?:\/\/(?:[\w-]+\.)?google\.[a-z.]+\/search\b/i.test(url) ||
        /^https?:\/\/(?:[\w-]+\.)?duckduckgo\.com\/(?:html\/?)?\?.*\bq=/i.test(url)
      );
    },

    get endReason() {
      return endReason;
    },

    blockedReason() {
      if (challengeIn(document)) {
        return 'The search engine is asking for a CAPTCHA. Solve it in the tab, then press Resume.';
      }
      return '';
    },

    getSearchContext() {
      endReason = '';
      latest = null;
      const params = new URLSearchParams(location.search);
      return { query: norm(params.get('q') || ''), filters: {}, url: location.href };
    },

    async waitForResults() {
      const { waitFor } = globalThis.MLSEngine;
      // The page itself, once it holds at least one profile link. A results
      // page with none is a real answer, not a failure — some queries simply
      // match nothing.
      await waitFor(() => (resultLinks().length ? document.body : null), { timeout: 8000 });
      return document.body;
    },

    getResultIds() {
      return resultLinks().map((r) => r.slug);
    },

    extractResult(slug) {
      const hit = resultLinks().find((r) => r.slug === slug);
      if (!hit) return null;

      const { name, headline } = splitTitle(titleOf(hit.anchor));
      if (!name) return null;

      const snippet = snippetFor(hit.anchor);
      return {
        name,
        headline,
        company: companyFrom(headline),
        location: locationFrom(snippet),
        degree: '',
        openToWork: '',
        summary: snippet.slice(0, 300),
        profileUrl: hit.url,
        photoUrl: '',
        email: '',
        detailScraped: false,
      };
    },

    reachedEnd() {
      return false;
    },

    async loadMore() {
      const url = nextUrl(latest || document);
      if (!url) {
        // "No next page" is only true if there was a page. An engine that
        // answered nothing at all is a different problem and needs saying so,
        // or the query is the first thing everyone re-reads.
        endReason = this.getResultIds().length
          ? 'the search engine offered no next page'
          : 'the search engine returned no results for this query';
        return false;
      }

      let doc = null;
      try {
        // same-origin, not include: the URL is already checked to be this
        // engine, and `include` is what would have sent the user's cookies
        // to somebody else's server if that check were ever bypassed.
        const response = await fetch(url, { credentials: 'same-origin', redirect: 'follow' });
        if (!response.ok) {
          endReason = `the search engine answered ${response.status} for the next page`;
          return false;
        }
        // A redirect can land anywhere. Where it landed is what was actually
        // fetched, so that is what has to be on the engine.
        if (response.url && new URL(response.url).origin !== location.origin) {
          endReason = 'the next page redirected off the search engine';
          return false;
        }
        doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      } catch (err) {
        endReason = `the next page could not be read (${err && err.message})`;
        return false;
      }

      if (challengeIn(doc)) {
        endReason = 'the search engine asked for a CAPTCHA on the next page';
        return false;
      }

      const before = new Set(this.getResultIds());
      // Appended INTO the results, never beside them: resultsRoot picks the
      // element holding a majority of the profiles, so a second cluster
      // somewhere else in the page would push it back up to <body> and the
      // header's own profile link would start counting as a person again.
      const into = resultsRoot(document);
      for (const node of [...resultsRoot(doc).children]) {
        const safe = sanitise(document.importNode(node, true));
        if (safe) into.appendChild(safe);
      }
      latest = doc;

      const gained = this.getResultIds().some((id) => !before.has(id));
      if (!gained) endReason = 'the next page repeated the results already collected';
      return gained;
    },

    // The title already carries the name and the headline. Opening every
    // profile would multiply the request count for very little — the same
    // call the LinkedIn adapter makes.
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
