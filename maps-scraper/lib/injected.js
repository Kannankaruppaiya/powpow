// Functions in this file are stringified and injected into the Google Maps tab by
// chrome.scripting.executeScript. They must be fully self-contained: no imports,
// no references to anything outside their own body.

/**
 * Scrolls the Maps results feed until it stops growing, collecting place links.
 * Runs inside the Maps tab.
 */
export async function collectPlaceLinks(options) {
  const opts = Object.assign({ maxIdleRounds: 5, maxItems: 300, pauseMs: 1100 }, options || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const links = new Map();

  const keyFor = (href) => {
    // The !1s0x...:0x... segment is Google's stable feature id for the place.
    const m = href.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    return m ? m[1] : href.split('?')[0];
  };

  const harvest = () => {
    document.querySelectorAll('a[href*="/maps/place/"]').forEach((a) => {
      const href = a.href;
      if (!href || href.indexOf('/maps/place/') === -1) return;
      const key = keyFor(href);
      if (!links.has(key)) {
        links.set(key, { key, href, name: a.getAttribute('aria-label') || '' });
      }
    });
  };

  // Wait for the results panel to appear.
  let feed = null;
  for (let i = 0; i < 24 && !feed; i++) {
    feed = document.querySelector('div[role="feed"]');
    if (!feed) await sleep(500);
  }

  if (!feed) {
    // A query specific enough to match one business lands straight on its page.
    harvest();
    if (location.pathname.indexOf('/maps/place/') !== -1) {
      const h1 = document.querySelector('h1');
      links.set(keyFor(location.href), {
        key: keyFor(location.href),
        href: location.href,
        name: h1 ? h1.textContent.trim() : '',
      });
    }
    return { links: Array.from(links.values()), endOfList: true };
  }

  let idle = 0;
  let previous = 0;
  let endOfList = false;

  while (idle < opts.maxIdleRounds && links.size < opts.maxItems) {
    harvest();
    if (links.size === previous) idle++;
    else {
      idle = 0;
      previous = links.size;
    }
    if (feed.innerText.indexOf("You've reached the end of the list") !== -1) {
      endOfList = true;
      break;
    }
    feed.scrollTo(0, feed.scrollHeight);
    await sleep(opts.pauseMs);
  }

  harvest();
  return { links: Array.from(links.values()), endOfList };
}

/**
 * Reads the detail panel of a single place page. Runs inside the Maps tab.
 */
export async function extractPlaceDetails() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el ? (el.textContent || '').trim() : '');
  const label = (el) => (el ? (el.getAttribute('aria-label') || '').trim() : '');

  // Wait for the panel heading to settle.
  let h1 = null;
  for (let i = 0; i < 30; i++) {
    h1 = document.querySelector('h1');
    const t = text(h1);
    if (t && t !== 'Results' && t !== 'Sponsored') break;
    await sleep(400);
  }

  const name = text(h1);
  if (!name) return null;

  // These data-item-id attributes are the most stable hooks on the panel.
  const addressEl = document.querySelector('button[data-item-id="address"]');
  const phoneEl = document.querySelector('button[data-item-id^="phone:tel:"]');
  const siteEl = document.querySelector('a[data-item-id="authority"]');
  const plusEl = document.querySelector('button[data-item-id="oloc"]');

  const address = label(addressEl).replace(/^Address:\s*/i, '');
  const phone = phoneEl
    ? (phoneEl.getAttribute('data-item-id') || '').replace('phone:tel:', '')
    : label(phoneEl).replace(/^Phone:\s*/i, '');
  const website = siteEl ? siteEl.href : '';
  const plusCode = label(plusEl).replace(/^Plus code:\s*/i, '');

  let category = '';
  const catBtn = document.querySelector('button[jsaction*="category"]');
  if (catBtn) category = text(catBtn);

  let rating = '';
  let reviews = '';
  const starEl = document.querySelector('[role="img"][aria-label*="stars"]');
  if (starEl) {
    const m = label(starEl).match(/([\d.,]+)\s*stars?/i);
    if (m) rating = m[1].replace(',', '.');
  }
  const reviewEl = document.querySelector('button[aria-label*="review"]');
  if (reviewEl) {
    const m = label(reviewEl).match(/([\d,.]+)\s*review/i);
    if (m) reviews = m[1].replace(/[.,]/g, '');
  }

  // Fallback: the header block renders as "4.3 (128)" when the aria labels move.
  if (!rating || !reviews) {
    const header = h1 && h1.parentElement ? h1.parentElement.parentElement : null;
    const m = header ? (header.innerText || '').match(/(\d[.,]\d)\s*\(?\s*([\d,.]+)\s*\)?/) : null;
    if (m) {
      if (!rating) rating = m[1].replace(',', '.');
      if (!reviews) reviews = m[2].replace(/[.,]/g, '');
    }
  }

  return {
    name,
    category,
    rating,
    reviews,
    phone,
    address,
    plusCode,
    website,
    url: location.href,
  };
}

/**
 * Reads the map centre out of the current Maps URL. Runs inside the Maps tab.
 */
export async function readMapCentre() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 30; i++) {
    const m = location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
    await sleep(400);
  }
  return null;
}
