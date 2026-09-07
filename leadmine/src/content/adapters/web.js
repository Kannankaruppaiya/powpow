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
 * Everything here is found by SHAPE, because the three engines this has to
 * survive lay their results out differently and all of them change:
 *
 *   - a result is any link that resolves to linkedin.com/in/<slug>
 *   - its title is the link's own text
 *   - its snippet is whatever text sits around it
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
   * DuckDuckGo wraps every result in `/l/?uddg=<encoded>`; Bing and Google
   * mostly link straight out. Unwrapping one layer covers all three without
   * knowing which engine this is.
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
  function resultsRoot() {
    const anchors = profileAnchors(document);
    const total = new Set(anchors.map((a) => a.slug)).size;
    const need = Math.max(2, Math.ceil(total / 2));

    const holds = (el) =>
      new Set(anchors.filter((a) => el.contains(a.anchor)).map((a) => a.slug)).size >= need;

    let best = document.body || document.documentElement;
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

  function resultLinks() {
    const best = new Map();
    for (const { anchor, ...profile } of profileAnchors(resultsRoot())) {
      const score = isUrlish(norm(anchor.textContent)) ? 0 : norm(anchor.textContent).length;
      const held = best.get(profile.slug);
      if (held && held.score >= score) continue;
      best.set(profile.slug, { anchor, score, ...profile });
    }
    return [...best.values()];
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
      const label = norm(link.textContent);
      if (label) text = text.replace(label, ' ');
    }
    return norm(text);
  }

  const MORE_LABEL = /^next\b|next page|more results|show more/i;

  function findNext() {
    for (const el of document.querySelectorAll('a[href], button')) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const label = norm(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
      if (MORE_LABEL.test(label)) return el;
    }
    return null;
  }

  let endReason = '';

  globalThis.MLSAdapters = globalThis.MLSAdapters || {};
  globalThis.MLSAdapters.web = {
    id: 'web',

    matchesUrl(url) {
      // A results page on one of the engines — never Maps, which has its own
      // adapter and also lives on google.com.
      // DuckDuckGo's results live at the site root ("/?q="), not under
      // /search, so a single path pattern does not cover all three engines.
      return (
        /^https?:\/\/(?:[\w-]+\.)?(?:bing\.com|google\.[a-z.]+)\/(?:html\/)?search\b/i.test(url) ||
        /^https?:\/\/(?:[\w-]+\.)?duckduckgo\.com\/(?:html\/?)?\?.*\bq=/i.test(url)
      );
    },

    get endReason() {
      return endReason;
    },

    blockedReason() {
      const body = norm(document.body ? document.body.innerText : '').slice(0, 400);
      if (/unusual traffic|are you a robot|verify you are human|captcha/i.test(body)) {
        return 'The search engine is asking for a CAPTCHA. Solve it in the tab, then press Resume.';
      }
      return '';
    },

    getSearchContext() {
      endReason = '';
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

      const { name, headline } = splitTitle(hit.anchor.textContent);
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
      const { waitFor } = globalThis.MLSEngine;
      const before = new Set(this.getResultIds());

      const next = findNext();
      if (!next) {
        endReason = 'the search engine offered no next page';
        return false;
      }

      next.click();
      // Turned over means a person who was not here before. Watching only the
      // top row misses a page whose first result repeats, and waits out the
      // full timeout for nothing.
      const turned = await waitFor(
        () => {
          const ids = this.getResultIds();
          return ids.some((id) => !before.has(id)) ? ids : null;
        },
        { timeout: 15000 }
      );
      if (!turned) endReason = 'the next page of results did not load';
      return Boolean(turned);
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
