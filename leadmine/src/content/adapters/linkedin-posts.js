/**
 * LinkedIn post search, read from the tab the user already has open.
 *
 * The Posts source normally searches an engine, which needs no LinkedIn login
 * but only knows about a post once it has indexed it — one to three weeks
 * after the post, for most of them. LinkedIn's own "Posts" search, sorted by
 * latest and filtered to the past week, has yesterday's post today. That makes
 * it the only way to find the newest requirements, and the reason this
 * adapter exists.
 *
 * It only ever reads the page the user set up — the source runs it through
 * "Use the tab I'm on", never by navigating — and it never opens a post or a
 * profile. Everything is on the card: the post's id (and so its exact time),
 * its author and a link to them, and the whole text, which LinkedIn keeps in
 * the DOM even when it clamps it behind "…see more".
 *
 * Found by shape, like the other adapters: a post is any element carrying an
 * activity URN, whatever LinkedIn calls it this month.
 */
(() => {
  'use strict';

  const { norm } = globalThis.MLSParse;

  const URN = /urn:li:activity:(\d{18,20})(?!\d)/;

  const SEL = {
    // Where LinkedIn puts a post's URN. Attributes, not classes: these have
    // outlived three redesigns of the markup around them.
    urnHolders: '[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"], [data-entity-urn*="urn:li:activity:"]',
    // The post body. Two generations of class, then the whole card as a last
    // resort — reading too much beats reading nothing.
    commentary: '.update-components-text, .feed-shared-inline-show-more-text, .feed-shared-update-v2__description',
    actor: '.update-components-actor, .feed-shared-actor',
    actorName: '.update-components-actor__title, .update-components-actor__name, .feed-shared-actor__name',
    authWall: 'form.login__form, .authwall, [data-test-id="auth-wall"]',
    captcha: '#captcha-internal, iframe[title*="captcha" i], .challenge-dialog',
  };

  const urnOf = (el) =>
    ['data-urn', 'data-id', 'data-entity-urn']
      .map((name) => el.getAttribute(name) || '')
      .map((value) => (value.match(URN) || [])[1])
      .find(Boolean) || '';

  /*
   * A post id in a link: /feed/update/urn:li:activity:<id>/ or a
   * /posts/…-activity-<id>-xxxx share link. The redesigned LinkedIn (the
   * "I'm looking for…" search bar) links every post card this way, and does
   * not promise the data-urn attribute the older markup carried.
   */
  const LINK_ID = /(?:urn(?::|%3A)li(?::|%3A)activity(?::|%3A)|-activity-)(\d{18,20})(?!\d)/i;
  const LINKS = 'a[href*="urn:li:activity:"], a[href*="urn%3Ali%3Aactivity%3A"], a[href*="-activity-"]';

  const linkId = (a) => ((a.getAttribute('href') || '').match(LINK_ID) || [])[1] || '';

  /** Every post id mentioned anywhere inside an element. */
  function idsIn(el) {
    const ids = new Set();
    const own = urnOf(el);
    if (own) ids.add(own);
    for (const holder of el.querySelectorAll(SEL.urnHolders)) {
      const id = urnOf(holder);
      if (id) ids.add(id);
    }
    for (const a of el.querySelectorAll(LINKS)) {
      const id = linkId(a);
      if (id) ids.add(id);
    }
    return ids;
  }

  /*
   * The card around a post link, found by shape: climb from the link while
   * the element still holds no other post. The last element that is about
   * this post alone is the card; one more step up is the list.
   *
   * A reshared post inside a card links to its own id too, and would stop
   * the climb inside the card — so an id that sits inside another post's
   * card is a reshare, and dropped by the outermost-wins rule below.
   */
  function cardFromLink(a, id) {
    let card = a;
    for (let el = a.parentElement, hops = 0; el && el !== document.body && hops < 14; el = el.parentElement, hops += 1) {
      const ids = idsIn(el);
      if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
      card = el;
    }
    return card;
  }

  /**
   * One element per post: the outermost one about that post.
   *
   * Two ways in, because LinkedIn has shipped both: elements carrying the
   * post's URN as an attribute, and — in the redesign — cards that only link
   * to it. LinkedIn nests URN holders (the card, an inner wrapper, a
   * reshared post with its own URN); the outermost is the post as the user
   * sees it, and a reshared original inside it is part of that post.
   */
  function postCards() {
    const found = new Map();
    for (const el of document.querySelectorAll(SEL.urnHolders)) {
      const id = urnOf(el);
      if (!id) continue;
      const outer = el.parentElement && el.parentElement.closest(SEL.urnHolders);
      if (outer && urnOf(outer)) continue;
      if (!found.has(id)) found.set(id, el);
    }
    for (const a of document.querySelectorAll(LINKS)) {
      const id = linkId(a);
      if (!id || found.has(id) || a.closest('nav, header, aside, [role="dialog"]')) continue;
      found.set(id, cardFromLink(a, id));
    }
    // Outermost wins: a card inside another card is a reshare.
    const cards = new Map();
    for (const [id, el] of found) {
      const inside = [...found.values()].some((other) => other !== el && other.contains(el));
      if (!inside) cards.set(id, el);
    }
    return cards;
  }

  /*
   * The text of an element as a person sees it, without its buttons.
   *
   * innerText, not textContent: LinkedIn breaks a post into lines with <br>,
   * and textContent glues "Hi Connections," onto "A QA Automation…". The
   * buttons inside — "… more", the control menu's "…" — are subtracted.
   */
  function seenText(el) {
    let text = String(el.innerText || el.textContent || '');
    for (const button of el.querySelectorAll('button, [role="button"]')) {
      const label = String(button.innerText || button.textContent || '').trim();
      if (label) text = text.replace(label, ' ');
    }
    return text;
  }

  const AUTHOR_OR_POST_LINK = 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"], ' + LINKS;

  /*
   * The post body, when no class names it: the element in the card with the
   * most text that is not the header. The header is what links to the author
   * or to the post (the name, the "1w •"); the counts and buttons are short.
   * Preferring what follows the post's own link keeps a long headline from
   * winning over a short post.
   */
  function bodyByShape(card, id) {
    const own = [...card.querySelectorAll(LINKS)].find((a) => linkId(a) === id);
    let best = null;
    let bestLength = 0;
    let bestFollows = false;
    for (const el of card.querySelectorAll('div, span, p, section, article')) {
      if (el.closest('button, [role="button"], nav, header')) continue;
      if (el.querySelector(AUTHOR_OR_POST_LINK) || el.closest('a')) continue;
      const length = norm(seenText(el)).length;
      if (!length) continue;
      const follows = Boolean(own && own.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const better = follows !== bestFollows ? follows : length > bestLength;
      if (better) {
        best = el;
        bestLength = length;
        bestFollows = follows;
      }
    }
    return best;
  }

  /** The post text, without LinkedIn's "…see more" control. */
  function postText(card, id) {
    const body = card.querySelector(SEL.commentary) || bodyByShape(card, id);
    const raw = body ? seenText(body) : '';
    return norm(String(raw).replace(/…\s*(?:see\s+)?more\s*$/i, '').replace(/\bhashtag\s*#/gi, '#'));
  }

  /** The author's name and profile, from the actor block at the top. */
  function authorOf(card) {
    const actor = card.querySelector(SEL.actor) || card;
    let nameEl = actor.querySelector(SEL.actorName);
    // No actor class to name: the author is the first profile or company
    // link in the card that has visible text.
    if (!nameEl) {
      nameEl = [...card.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')].find((a) => norm(a.textContent));
    }
    // LinkedIn renders the name twice — once for the eye (aria-hidden) and
    // once for a screen reader, clipped rather than removed, so innerText
    // reads both: "Girish PM Girish PM". The sighted copy is the name.
    const sighted = nameEl && nameEl.querySelector('[aria-hidden="true"]');
    const name = sighted
      ? norm(sighted.textContent)
      : nameEl
        ? undouble(norm(String(nameEl.innerText || nameEl.textContent).split('\n')[0]))
        : '';
    let url = '';
    for (const link of actor.querySelectorAll('a[href]')) {
      try {
        const href = new URL(link.href);
        if (/^\/(?:in|company|school)\/[^/]+/.test(href.pathname)) {
          url = `${href.origin}${href.pathname.replace(/\/+$/, '')}`;
          break;
        }
      } catch {
        /* not a URL */
      }
    }
    return { name: name.replace(/\s*(?:•|·)\s*(?:1st|2nd|3rd\+?|Following)\b.*$/i, '').trim(), url };
  }

  /** "Girish PM Girish PM" → "Girish PM", when a name is its own echo. */
  function undouble(text) {
    const words = text.split(' ');
    const half = words.length / 2;
    if (Number.isInteger(half) && half > 0 && words.slice(0, half).join(' ') === words.slice(half).join(' ')) {
      return words.slice(0, half).join(' ');
    }
    return text;
  }

  function scrollToEnd() {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
  }

  const MORE_LABEL = /show more results|see more results|load more/i;

  function findMoreButton() {
    for (const el of document.querySelectorAll('button')) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (MORE_LABEL.test(norm(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`))) return el;
    }
    return null;
  }

  let endReason = '';

  globalThis.MLSAdapters = globalThis.MLSAdapters || {};
  globalThis.MLSAdapters.linkedinPosts = {
    id: 'posts',

    /*
     * Where posts are listed: LinkedIn's post search, a person's or a
     * company's activity, and a profile page's own posts carousel — the one
     * the two posts this source was tuned on were read from. The people
     * search keeps its own adapter.
     */
    matchesUrl(url) {
      const u = String(url || '');
      return (
        /^https:\/\/([\w-]+\.)?linkedin\.com\/search\/results\/content/.test(u) ||
        /^https:\/\/([\w-]+\.)?linkedin\.com\/in\/[^/?#]+\/recent-activity\//.test(u) ||
        /^https:\/\/([\w-]+\.)?linkedin\.com\/company\/[^/?#]+\/posts/.test(u) ||
        /^https:\/\/([\w-]+\.)?linkedin\.com\/in\/[^/?#]+\/?(?:[?#].*)?$/.test(u)
      );
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

    get endReason() {
      return endReason;
    },

    getSearchContext() {
      endReason = '';
      const params = new URLSearchParams(location.search);
      return { query: norm(params.get('keywords') || ''), filters: {}, url: location.href };
    },

    async waitForResults() {
      const { waitFor } = globalThis.MLSEngine;
      const found = await waitFor(() => (postCards().size ? document.body : null), { timeout: 15000 });
      if (found) return found;
      throw new Error(
        'Could not find any posts on this LinkedIn page. Open LinkedIn search, choose the Posts tab, ' +
          'then press Start again.'
      );
    },

    getResultIds() {
      return [...postCards().keys()];
    },

    extractResult(id) {
      const card = postCards().get(id);
      if (!card) return null;
      const text = postText(card, id);
      // A card with no text yet is a skeleton; it will be read next round.
      if (!text) return null;
      const author = authorOf(card);
      return {
        source: 'posts',
        name: author.name || 'LinkedIn post',
        author: author.name,
        authorUrl: author.url,
        headline: text.slice(0, 150),
        text,
        summary: text.slice(0, 300),
        postId: id,
        postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
        detailScraped: false,
      };
    },

    reachedEnd() {
      return false;
    },

    async loadMore() {
      const { waitFor } = globalThis.MLSEngine;
      const before = postCards().size;
      scrollToEnd();
      const grew = await waitFor(() => postCards().size > before, { timeout: 4000 });
      if (grew) return true;

      const more = findMoreButton();
      if (!more) {
        endReason = 'LinkedIn showed no more posts';
        return false;
      }
      more.click();
      const loaded = await waitFor(() => postCards().size > before, { timeout: 8000 });
      if (!loaded) endReason = 'the next posts did not load';
      return Boolean(loaded);
    },

    needsDetail() {
      return false;
    },

    finalise(records, config, context) {
      for (const r of records) {
        r.searchCategory = config.category || (context && context.query) || '';
      }
    },
  };
})();
