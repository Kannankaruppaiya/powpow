/** LinkedIn post search, read from the tab the user already has open. */
(() => {
  'use strict';

  const { norm } = globalThis.MLSParse;

  const URN = /urn:li:activity:(\d{18,20})(?!\d)/;

  const SEL = {
    // Where LinkedIn puts a post's URN.
    urnHolders: '[data-urn*="urn:li:activity:"], [data-id*="urn:li:activity:"], [data-entity-urn*="urn:li:activity:"]',
    // The post body.
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

  /** One element per post: the outermost one carrying its URN. */
  function postCards() {
    const cards = new Map();
    for (const el of document.querySelectorAll(SEL.urnHolders)) {
      const id = urnOf(el);
      if (!id) continue;
      const outer = el.parentElement && el.parentElement.closest(SEL.urnHolders);
      if (outer && urnOf(outer)) continue;
      if (!cards.has(id)) cards.set(id, el);
    }
    return cards;
  }

  /** The visible post text, without LinkedIn's "…see more" control. */
  function postText(card) {
    const body = card.querySelector(SEL.commentary);
    const raw = body ? body.textContent : card.innerText || card.textContent || '';
    return norm(String(raw).replace(/…\s*(?:see )?more\s*$/i, '').replace(/\bhashtag\s*#/gi, '#'));
  }

  /** The author's name and profile, from the actor block at the top. */
  function authorOf(card) {
    const actor = card.querySelector(SEL.actor) || card;
    const nameEl = actor.querySelector(SEL.actorName);
    // LinkedIn renders the name twice.
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

    matchesUrl(url) {
      return /^https:\/\/([\w-]+\.)?linkedin\.com\/search\/results\/content/.test(String(url || ''));
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
      const text = postText(card);
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
