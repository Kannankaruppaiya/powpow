/** Public-web adapter: LinkedIn profiles found through a search engine. */
(() => {
  'use strict';

  const { norm, parsePostTitle } = globalThis.MLSParse;

  const PROFILE = /(?:^|\.)linkedin\.com\/in\/([^/?#]+)/i;

  /** The profile URL a link points at, following one layer of redirect. */
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

  // Posts, not people.
  const POSTS_QUERY = /site:\S*linkedin\.com\/(?:posts|feed)/i;
  const POST_PAGE = /(?:^|\.)linkedin\.com\/(?:posts|feed\/update)\//i;
  const POST_ID = /(?:activity|ugcPost|share)(?:%3A|:|-)(\d{18,20})(?!\d)/i;

  function postsMode() {
    try {
      return POSTS_QUERY.test(new URLSearchParams(location.search).get('q') || '');
    } catch {
      return false;
    }
  }

  /** The post a link points at, following one layer of redirect. */
  function postFrom(anchor) {
    const raw = anchor.getAttribute('href') || '';
    if (!raw) return null;

    let href = raw;
    try {
      const url = new URL(raw, location.href);
      const wrapped = url.searchParams.get('uddg') || url.searchParams.get('url');
      href = wrapped && POST_PAGE.test(wrapped) ? wrapped : url.href;
    } catch {
      /* fall through to the raw string */
    }

    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      /* a stray % — read it as it is */
    }
    if (!POST_PAGE.test(decoded)) return null;
    const match = decoded.match(POST_ID);
    if (!match) return null;

    // Tracking parameters are not part of the post, and they make the same post look like two links.
    let clean = decoded;
    try {
      const url = new URL(decoded);
      clean = `${url.origin}${url.pathname}`;
    } catch {
      /* keep what there is */
    }
    return { slug: match[1], url: clean };
  }

  /** What a result links to, in whichever mode the search is. */
  const targetFrom = (anchor) => (postsMode() ? postFrom(anchor) : profileFrom(anchor));

  /** Does this text read like a URL rather than a title? */
  const URLISH = /^(?:https?:|www\.)/i;
  const isUrlish = (text) => URLISH.test(text) || /linkedin\.com/i.test(text.replace(/\s*[›>/]\s*/g, ''));

  /** Every distinct profile on the page, each paired with its best anchor. */
  function profileAnchors(root) {
    const found = [];
    for (const anchor of root.querySelectorAll('a[href]')) {
      const profile = targetFrom(anchor);
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

  /** The part of the page the results live in. */
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

  /** Is this link a result, or is it part of the page? */
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

  /** The title text of a result. */
  const HEADING = 'h1, h2, h3, h4, h5, h6';

  /** The heading a result is titled by, whichever side of the link it is on. */
  const headingOf = (anchor) => anchor.querySelector(HEADING) || anchor.closest(HEADING);

  function titleOf(anchor) {
    const heading = headingOf(anchor);
    return norm(heading ? heading.textContent : anchor.textContent);
  }

  /** Split a result title into a name and a headline. */
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

  // "Chennai, Tamil Nadu, India" — two or three capitalised parts, each at most three words, separated by commas.
  const PART = "[A-Z][\\w'’-]*(?: [A-Z][\\w'’-]*){0,2}";
  const PLACE_RUN = new RegExp(`${PART}, ${PART}(?:, ${PART})?`, 'g');

  const placeLike = (piece) =>
    piece && piece.length <= 60 && !NOISE.test(piece) && PLACE.test(piece) && !/\bat\b/i.test(piece);

  /** A location out of the snippet, if it reads like one. */
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
      const profile = targetFrom(anchor);
      if (profile) slugs.add(profile.slug);
    }
    return slugs;
  }

  /** The text around a result, which is where the snippet lives. */
  function snippetFor(anchor) {
    let best = anchor.parentElement || document.body;
    for (let el = best, hops = 0; el && el !== document.body && hops < 6; el = el.parentElement, hops += 1) {
      if (slugsIn(el).size > 1) break;
      best = el;
    }
    // Every link to this same person is chrome, not snippet: the title, and the breadcrumb URL printed under it.
    let text = norm(best.textContent);
    for (const link of best.querySelectorAll('a[href]')) {
      if (!targetFrom(link)) continue;
      for (const label of new Set([norm(link.textContent), titleOf(link)])) {
        if (label) text = text.replace(label, ' ');
      }
    }
    return norm(text);
  }

  // A challenge page, in the words the engines actually use.
  const CHALLENGE =
    /unusual traffic|are you a robot|verify (?:you are|that you are) (?:a )?human|captcha|solve the challenge|one last step|before you continue|automated queries|access denied|too many requests/i;

  function challengeIn(doc) {
    const body = doc && doc.body;
    if (!body) return false;
    // innerText is layout-dependent and empty in a parsed document, so the fetched next page needs textContent.
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

  /** The URL a Next control leads to, or '' if it is not one. */
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

  // Markup from another page, made inert before it touches this one.
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

  // The engine's own date in front of a snippet — "5 days ago —", "Sep 7, 2026 ·".
  const ENGINE_DATE =
    /^(?:\d+\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago|[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}|\d{1,2} [A-Z][a-z]{2,8}\.? \d{4})\s*[—–·-]\s*/;

  /** One post result as a record. The worker dates and classifies it. */
  function postRecord(hit) {
    const { author, text: fromTitle } = parsePostTitle(titleOf(hit.anchor));
    const snippet = snippetFor(hit.anchor).replace(ENGINE_DATE, '').trim();
    // The title is usually the post's first line and the snippet the next few.
    const text =
      fromTitle && !snippet.toLowerCase().includes(fromTitle.toLowerCase().slice(0, 40))
        ? `${fromTitle} — ${snippet}`
        : snippet || fromTitle;
    return {
      source: 'posts',
      name: author || 'LinkedIn post',
      author,
      headline: fromTitle,
      text,
      summary: snippet.slice(0, 300),
      postId: hit.slug,
      postUrl: hit.url,
      detailScraped: false,
    };
  }

  let endReason = '';

  // The page the next Next link is read from.
  let latest = null;

  globalThis.MLSAdapters = globalThis.MLSAdapters || {};
  globalThis.MLSAdapters.web = {
    id: 'web',

    matchesUrl(url) {
      // A results page on one of the engines — never Maps, which has its own adapter and also lives on google.com.
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
      // The page itself, once it holds at least one profile link.
      await waitFor(() => (resultLinks().length ? document.body : null), { timeout: 8000 });
      return document.body;
    },

    getResultIds() {
      return resultLinks().map((r) => r.slug);
    },

    extractResult(slug) {
      const hit = resultLinks().find((r) => r.slug === slug);
      if (!hit) return null;
      if (postsMode()) return postRecord(hit);

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
        // "No next page" is only true if there was a page.
        endReason = this.getResultIds().length
          ? 'the search engine offered no next page'
          : 'the search engine returned no results for this query';
        return false;
      }

      let doc = null;
      try {
        // same-origin, not include.
        const response = await fetch(url, { credentials: 'same-origin', redirect: 'follow' });
        if (!response.ok) {
          endReason = `the search engine answered ${response.status} for the next page`;
          return false;
        }
        // A redirect can land anywhere.
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
      // Appended INTO the results, never beside them.
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

    // The title already carries the name and the headline.
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
