/**
 * Pure text-parsing helpers shared by the content script.
 *
 * This file is loaded as a classic content script (it cannot be an ES module —
 * Chrome does not support module content scripts), so it publishes itself on
 * `globalThis`. Node's ESM loader still executes it on import, which is how the
 * unit tests get at these functions without a browser.
 */
(() => {
  'use strict';

  /** Collapse the non-breaking and thin spaces Google Maps sprinkles around. */
  const norm = (s) =>
    (s || '')
      .replace(/[    ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /** Comparison key for two business names, ignoring case and punctuation. */
  const nameKey = (s) =>
    norm(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');

  const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

  /**
   * Card rows mix phone numbers with review counts, opening hours and price
   * bands, so a bare digit test is not enough.
   */
  function looksLikePhone(text) {
    const t = norm(text);
    if (!PHONE_RE.test(t)) return false;
    if (/review|hour|open|clos|₹|\$|€|£/i.test(t)) return false;
    return (t.match(/\d/g) || []).length >= 8;
  }

  /** Pull "4.5" and "128" out of an aria-label like "4.5 stars 128 Reviews". */
  function parseRatingLabel(label) {
    const text = norm(label);
    const rating = text.match(/([\d.,]+)\s*star/i);
    const reviews = text.match(/([\d.,]+)\s*review/i);
    return {
      rating: rating ? rating[1].replace(',', '.') : '',
      reviews: reviews ? reviews[1].replace(/[.,]/g, '') : '',
    };
  }

  const STATUS_RE = /^(open|clos|temporarily|permanently|24 hours|opens|closes)/i;

  /**
   * A fragment that is only a rating and/or a review count.
   *
   * Live Maps renders these as adjacent spans with no separator, so the card's
   * text comes through glued: "5.0(139)". Matching the two halves separately
   * was not enough — the joined form slipped past every filter and took the
   * category slot, which then pushed the real category into the address and
   * the real address out entirely.
   */
  const RATING_ONLY = /^[\d.,]*\s*(\([\d,]+\))?$/;
  const ADDRESS_HINT =
    /\d|street|st\b|road|rd\b|ave|avenue|lane|ln\b|nagar|colony|block|sector|floor|plaza|highway|cross|main\b/i;

  /**
   * Turn the middle-dot separated fragments of a result card into a category
   * and an address.
   *
   * ["Dental clinic", "12, Anna Nagar", "Open ⋅ Closes 9 pm", "044 2345 6789"]
   *   -> { category: "Dental clinic", address: "12, Anna Nagar", phone: "044 2345 6789" }
   */
  function parseCardParts(parts) {
    const out = { category: '', address: '', phone: '' };

    for (const raw of parts) {
      const p = norm(raw);
      if (!p) continue;

      if (!out.phone && looksLikePhone(p)) {
        out.phone = p;
        continue;
      }
      if (STATUS_RE.test(p)) continue;
      if (RATING_ONLY.test(p)) continue; // stray rating / review counts

      if (!out.category) out.category = p;
      else if (!out.address && ADDRESS_HINT.test(p)) out.address = p;
      else if (!out.address) out.address = p;
    }
    return out;
  }

  const AREA_NOISE =
    /^(india|united states|usa|uk|united kingdom|canada|australia|singapore|uae|deutschland|\d{4,6}(-\d{4})?)$/i;

  /**
   * Pull the neighbourhood out of a formatted address.
   *
   *   "12, 2nd Ave, Anna Nagar, Chennai, Tamil Nadu 600040, India"
   *     with city "Chennai" -> "Anna Nagar"
   *
   * Countries and bare postcodes are dropped, then the segment immediately
   * before the searched city wins. Without a city match, the second-to-last
   * segment that carries no postcode is the best available guess.
   */
  /**
   * A segment carrying a postcode, i.e. the state/region tail of an address
   * rather than a neighbourhood: "IL 62701", "Tamil Nadu 600040",
   * "London NW1 6XE".
   */
  const POSTAL_SEGMENT = /\d{4,}|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;

  function deriveArea(address, city) {
    const segments = norm(address)
      .split(',')
      .map((s) => norm(s))
      .filter((s) => s && !AREA_NOISE.test(s));
    if (!segments.length) return '';

    const cityKey = nameKey(city);
    if (cityKey) {
      const idx = segments.findIndex((s) => {
        const k = nameKey(s);
        if (!k) return false;
        // "Chennai" should match the "Chennai 600040" segment too.
        return k === cityKey || k.startsWith(cityKey) || cityKey.startsWith(k);
      });
      if (idx > 0) return segments[idx - 1];
      if (idx === 0) return segments[0];
    }

    // No city to anchor on: drop the administrative tail (state + postcode)
    // and the innermost remaining segment is the best available locality.
    //   "5 Main St, Springfield, IL 62701"      -> "Springfield"
    //   "221B Baker St, Marylebone, London NW1 6XE" -> "Marylebone"
    const usable = segments.filter((s) => !POSTAL_SEGMENT.test(s));
    return usable[usable.length - 1] || segments[segments.length - 1];
  }

  /** Strip the "phone:tel:+919876543210" wrapper Maps puts on the call button. */
  function phoneFromItemId(itemId) {
    const raw = String(itemId || '');
    const index = raw.indexOf('phone:tel:');
    return index === -1 ? '' : norm(raw.slice(index + 'phone:tel:'.length));
  }

  /**
   * Author and text out of the title an engine shows for a LinkedIn post.
   *
   * LinkedIn titles its post pages in a few shapes, and engines add their own
   * site suffix on top:
   *
   *   "Urgent SAP FI trainer requirement | Shreya Wagh"
   *   "Shreya Wagh on LinkedIn: Urgent SAP FI trainer requirement…"
   *   "Shreya Wagh's Post - LinkedIn"
   *   "🚨 Urgent requirement | Shreya Wagh posted on the topic | LinkedIn"
   */
  function parsePostTitle(title) {
    let text = norm(title)
      .replace(/\s*[-|·–—]\s*LinkedIn\s*$/i, '')
      .replace(/\s*\|\s*LinkedIn\s*$/i, '')
      .trim();

    const onLinkedIn = text.match(/^(.{2,80}?) on LinkedIn:\s*(.*)$/i);
    if (onLinkedIn) return { author: onLinkedIn[1].trim(), text: onLinkedIn[2].trim() };

    const possessive = text.match(/^(.{2,80}?)['’]s (?:Post|Activity|Update)$/i);
    if (possessive) return { author: possessive[1].trim(), text: '' };

    const bar = text.lastIndexOf(' | ');
    if (bar > 0) {
      const author = text
        .slice(bar + 3)
        .replace(/\s+(?:posted|reposted|commented)(?: on the topic| on this)?$/i, '')
        .trim();
      // A name is short. A long tail after the bar is part of the post, which
      // happens when the post itself uses " | " as punctuation.
      if (author && author.split(' ').length <= 8 && author.length <= 80) {
        return { author, text: text.slice(0, bar).trim() };
      }
    }
    return { author: '', text };
  }

  /*
   * An engine's snippet for a LinkedIn post, with the engine's furniture taken
   * out and the author read off it.
   *
   * Read off a real run of 140 results. Google puts all of this in the text
   * around a post result:
   *
   *   "Web results"
   *   "linkedin.comhttps://www.linkedin.com › posts › joe-adams-9a93556b..."
   *   "LinkedIn · RAJENDRA SHARMA9 reactions"      ← the author, glued to a count
   *   "Asif Ebrahim posted this —", "Pramita Kaur Sidhu's Post - …"
   *   "· 1 week ago", "2w. Report this post; Close menu.", "Like · Reply."
   *
   * Left in, they were the Post column, the name "39 comments" was the
   * Author, and "LinkedIn · Tech Talent Sourcing, Diversity Hiring…" was read
   * as somebody hiring.
   */
  const COUNT = /\d[\d,.]*\s*K?\+?\s*(?:reactions?|comments?|followers?|reposts?)/i;

  function cleanPostSnippet(raw) {
    let text = norm(raw);
    let author = '';

    const site = text.match(new RegExp(`LinkedIn\\s*·\\s*(.{2,80}?)\\s*(?:${COUNT.source}|·|$)`, 'i'));
    if (site && !/^https?:|linkedin\.com/i.test(site[1])) author = site[1].trim();
    const postedThis = text.match(/(?:^|—\s*)([^—|·]{2,60}?)\s+posted this\b/i);
    if (!author && postedThis) author = postedThis[1].trim();
    const possessive = text.match(/(?:^|—\s*)([^—|·]{2,60}?)['’]s?\s+Post\b/i);
    if (!author && possessive) author = possessive[1].trim();

    text = text
      .replace(/\bWeb results\b/gi, ' ')
      // "linkedin.comhttps://www.linkedin.com › posts › slug..." and "LinkedInhttps://…"
      .replace(/(?:linkedin\.com|LinkedIn)?\s*https?:\/\/(?:[\w-]+\.)?linkedin\.com(?:\s*›\s*[\w%-]+)*(?:\.{2,}|…)?/gi, ' ')
      .replace(new RegExp(`LinkedIn\\s*·\\s*.{0,80}?${COUNT.source}`, 'gi'), ' ')
      .replace(/LinkedIn\s*·\s*[^·—]{0,80}?(?=\s*·|\s*—|$)/gi, ' ')
      .replace(/\s*·\s*\d+\s+(?:minutes?|hours?|days?|weeks?|months?)\s+ago\b/gi, ' ')
      .replace(/(?:^|\s)\d+\s*(?:h|d|w|mo|yr)\.?\s+Report this (?:post|comment)[;.]?\s*(?:Close menu\.?)?/gi, ' ')
      .replace(/\bReport this (?:post|comment)[;.]?\s*(?:Close menu\.?)?/gi, ' ')
      .replace(/\bLike\s*·\s*Reply\.?/gi, ' ')
      .replace(new RegExp(`(?:^|\\s)${COUNT.source}`, 'gi'), ' ')
      .replace(/[^—|]{2,60}?\s+posted this\s*(?:—|-)?/gi, ' ')
      .replace(/^\s*(?:—|-|\|)\s*/, '');
    return { text: norm(text), author };
  }

  globalThis.MLSParse = {
    norm,
    nameKey,
    looksLikePhone,
    parseRatingLabel,
    parseCardParts,
    deriveArea,
    phoneFromItemId,
    parsePostTitle,
    cleanPostSnippet,
  };
})();
