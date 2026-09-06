/**
 * Google Maps adapter.
 *
 * Google ships obfuscated, rotating class names, so every selector here is
 * tried in order: stable attribute hooks (data-item-id, role, aria-label)
 * first, hashed class names only as a last resort. Forcing hl=en on the search
 * URL keeps the aria-label prefixes ("Phone:", "Address:") predictable.
 *
 * The results feed is virtualised — cards are added as you scroll — so the
 * engine's harvest loop reads what is on screen each round rather than
 * expecting one complete list.
 */
(() => {
  'use strict';

  const { norm, nameKey, parseRatingLabel, parseCardParts, deriveArea, phoneFromItemId } =
    globalThis.MLSParse;

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
    detailHours: '[aria-label*="Hours" i], div.t39EBf[aria-label], div.OqCZI[aria-label]',
    detailPrice: '[aria-label*="Price" i], span.mgr77e span',
    detailClaim: 'a[href*="/business/"], button[aria-label*="Claim" i]',
    backButton: 'button[jsaction*="back"], button[aria-label="Back"]',
    consent: 'form[action*="consent"], div[aria-label*="Before you continue"]',
  };

  const END_OF_LIST_HINTS = [
    "you've reached the end of the list",
    'you have reached the end of the list',
  ];

  /* ------------------------------------------------------- field extractors */

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
      const m = norm(link && (link.getAttribute('aria-label') || link.textContent)).match(/([\d.,]+)/);
      if (m) out.reviews = m[1].replace(/[.,]/g, '');
    }
    return out;
  }

  /**
   * Read the card's secondary info rows. Maps packs "Category · Address" on
   * one line and "Open now · Closing time" plus an optional phone on the next.
   */
  function extractCardInfo(card, name = '') {
    if (!card) return { category: '', address: '', phone: '' };

    // These containers nest — the outer one holds the business name and the
    // rating as well, so its text would glue "Bright Smile Dental" onto
    // "Dental clinic". Keep only leaf rows.
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

  function blankRecord() {
    return {
      name: '', category: '', address: '', area: '', phone: '', email: '',
      rating: '', reviews: '', website: '', hours: '', priceLevel: '',
      claimed: '', plusCode: '', mapsUrl: '', detailScraped: false,
    };
  }

  function extractCard(link) {
    const card = link.closest('div[jsaction]') || link.parentElement;
    const name =
      norm(link.getAttribute('aria-label')) ||
      norm(card && card.querySelector('div.qBF1Pd')?.textContent);
    if (!name) return null;

    const { rating, reviews } = extractRating(card);
    const info = extractCardInfo(card, name);
    const site = card && card.querySelector('a[data-value="Website"], a[aria-label^="Visit"]');

    return {
      ...blankRecord(),
      name,
      category: info.category,
      address: info.address,
      phone: info.phone,
      rating,
      reviews,
      website: site ? site.href : '',
      mapsUrl: link.href,
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

    // Opening hours live in an aria-label holding the whole week, e.g.
    // "Monday, 9 AM to 9 PM; Tuesday, 9 AM to 9 PM; ...".
    const hours = main.querySelector(SEL.detailHours);
    if (hours) {
      const label = norm(hours.getAttribute('aria-label'));
      // Reject the collapsed summary ("Open ⋅ Closes 9 pm") in favour of the
      // full week, which is the only version worth putting in a spreadsheet.
      if (label && label.includes(';')) rec.hours = label.replace(/^hours:\s*/i, '');
    }

    const price = main.querySelector(SEL.detailPrice);
    if (price) {
      const label = norm(price.getAttribute('aria-label') || price.textContent);
      const m = label.match(
        /(?:price[:\s]*)?((?:[₹$€£¥]{1,4})|(?:\p{Sc}\s?\d[\d,]*(?:\s?[–-]\s?\p{Sc}?\s?\d[\d,]*)?))/u
      );
      if (m) rec.priceLevel = norm(m[1]);
    }

    // An unclaimed listing advertises "Claim this business" — a strong signal
    // that nobody is managing the page.
    const claim = [...main.querySelectorAll(SEL.detailClaim)].some((el) =>
      /claim this business|own this business/i.test(
        `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`
      )
    );
    rec.claimed = claim ? 'No' : 'Yes';

    const { rating, reviews } = extractRating(main);
    if (rating) rec.rating = rating;
    if (reviews) rec.reviews = reviews;

    return rec;
  }

  /* ---------------------------------------------------------- the adapter */

  globalThis.MLSAdapters = globalThis.MLSAdapters || {};
  globalThis.MLSAdapters.maps = {
    id: 'maps',

    matchesUrl(url) {
      return /^https:\/\/(www\.)?google\.[a-z.]+\/maps/.test(String(url || ''));
    },

    blockedReason() {
      return document.querySelector(SEL.consent)
        ? 'Google is showing a consent screen. Accept it in this tab, then run the scrape again.'
        : '';
    },

    getSearchContext() {
      const term = decodeURIComponent((location.pathname.match(/\/maps\/search\/([^/@]+)/) || [])[1] || '')
        .replace(/\+/g, ' ');
      return { query: norm(term), filters: {} };
    },

    async waitForResults() {
      const { waitFor } = globalThis.MLSEngine;
      return waitFor(() => document.querySelector(SEL.feed), { timeout: 15000 });
    },

    getResultIds(feed) {
      // The href is the identity: stable per business within a page.
      return [...feed.querySelectorAll(SEL.cardLink)].map((a) => a.href);
    },

    extractResult(id, feed) {
      const link = feed.querySelector(`a[href="${CSS.escape(id)}"]`);
      return link ? extractCard(link) : null;
    },

    reachedEnd(feed) {
      const tail = norm(feed.textContent).toLowerCase().slice(-400);
      return END_OF_LIST_HINTS.some((h) => tail.includes(h));
    },

    async loadMore(feed) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'auto' });
      return true;
    },

    needsDetail(record) {
      // Skip records that already carry everything the detail pass would add.
      if (record.phone && record.website && record.address) {
        record.detailScraped = true;
        return false;
      }
      return true;
    },

    async openDetail(record, config, { waitFor, sleep }) {
      const feed = document.querySelector(SEL.feed);
      if (!feed) return null;

      let link = feed.querySelector(`a[href="${CSS.escape(record.mapsUrl)}"]`);
      if (!link) {
        // The card scrolled out of the rendered window — find it again by name.
        link = [...feed.querySelectorAll(SEL.cardLink)].find(
          (a) => nameKey(a.getAttribute('aria-label')) === nameKey(record.name)
        );
      }
      if (!link) return null;

      link.scrollIntoView({ block: 'center' });
      await sleep(120);
      link.click();

      return waitFor(
        () => {
          const d = extractDetailPanel();
          // Guard against reading the previous business's panel.
          return d && nameKey(d.name) === nameKey(record.name) ? d : null;
        },
        { timeout: config.detailTimeout || 7000 }
      );
    },

    async closeDetail({ waitFor, sleep }) {
      const back = document.querySelector(SEL.backButton);
      if (back) back.click();
      else history.back();
      await waitFor(() => document.querySelector(SEL.feed), { timeout: 6000 });
      await sleep(150);
    },

    /** A search precise enough to match one business skips the list entirely. */
    async extractSingle({ waitFor }) {
      const single = await waitFor(() => extractDetailPanel(), { timeout: 6000 });
      if (!single) return null;
      return { ...blankRecord(), ...single, mapsUrl: location.href };
    },

    finalise(records, config) {
      for (const r of records) {
        r.area = deriveArea(r.address, config.city);
        r.city = config.city || '';
        r.searchCategory = config.category || '';
      }
    },
  };
})();
