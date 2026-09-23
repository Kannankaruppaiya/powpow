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

  globalThis.MLSParse = {
    norm,
    nameKey,
    looksLikePhone,
    parseRatingLabel,
    parseCardParts,
    deriveArea,
    phoneFromItemId,
  };
})();
