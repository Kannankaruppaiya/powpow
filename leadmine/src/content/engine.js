/**
 * Content-script engine — the part that is the same for every source.
 *
 * Adapters own the DOM; this owns the process. Concretely it runs the harvest
 * loop (collect what is on screen, ask for more, stop when the page stops
 * giving), the optional detail pass, deduplication within a page, progress
 * reporting and cancellation.
 *
 * The split matters because Google Maps and LinkedIn differ in every DOM
 * detail and in almost none of the process: both render a virtualised list
 * that grows as you scroll, and both need the same care about when to stop.
 *
 * An adapter registers itself on `globalThis.MLSAdapters` and implements:
 *
 *   id                          a short source name
 *   matchesUrl(url)             does this adapter handle the current page
 *   blockedReason()             consent wall, login wall, captcha — or ''
 *   getSearchContext()          { query, filters } read off the page
 *   waitForResults()            resolve with the list container, or null
 *   getResultIds()              ids of the results currently in the DOM
 *   extractResult(id)           a record for one id, or null
 *   loadMore(container)         scroll or paginate; false when exhausted
 *   reachedEnd(container)       an explicit "no more results" marker
 *   needsDetail(record)         should the detail pass open this one
 *   openDetail(record, config)  open it and return the extra fields
 *   closeDetail()               return to the list
 *   finalise(records, config)   derive per-record fields once collecting ends
 */
(() => {
  'use strict';

  // The content script is re-injected on SPA navigations in some Chrome
  // versions; keep exactly one listener alive.
  if (window.__mlsEngineLoaded) return;
  window.__mlsEngineLoaded = true;

  const state = {
    running: false,
    cancelled: false,
    phase: 'idle',
    found: 0,
    detailed: 0,
    total: 0,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Poll for a condition instead of guessing at fixed sleeps. */
  async function waitFor(fn, { timeout = 8000, interval = 120 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (state.cancelled) return null;
      let value;
      try {
        value = fn();
      } catch {
        value = null;
      }
      if (value) return value;
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  function report(patch) {
    Object.assign(state, patch);
    try {
      chrome.runtime.sendMessage({
        type: 'SCRAPE_PROGRESS',
        phase: state.phase,
        found: state.found,
        detailed: state.detailed,
        total: state.total,
      });
    } catch {
      /* popup closed / worker asleep — progress is best effort */
    }
  }

  function pickAdapter(url) {
    const adapters = Object.values(globalThis.MLSAdapters || {});
    return adapters.find((a) => {
      try {
        return a.matchesUrl(url);
      } catch {
        return false;
      }
    });
  }

  /* ------------------------------------------------------- the harvest loop */

  /**
   * Collect every result the page will give up.
   *
   * Stops on an explicit end marker, on the requested maximum, or after
   * several rounds that added nothing — a lazy list often pauses a beat before
   * appending the next page, so one empty round is not the end.
   */
  async function harvest(adapter, config) {
    let container = await adapter.waitForResults();
    if (!container) return null;

    const byId = new Map();
    const maxResults = config.maxResults || 0;
    const scrollDelay = config.scrollDelay || 900;
    let stagnantRounds = 0;
    // "It stopped at 20" is not something anyone can act on without knowing
    // which of the four exits it took.
    let stopped = 'round limit';

    report({ phase: 'listing' });

    for (let round = 0; round < 500; round += 1) {
      if (state.cancelled) break;

      // A single-page app replaces its list on pagination or a filter change.
      // The old node is then detached and yields nothing — which is
      // indistinguishable from having reached the end unless it is re-found.
      if (container.isConnected === false) {
        let fresh = null;
        try {
          fresh = await adapter.waitForResults();
        } catch {
          fresh = null;
        }
        if (!fresh) break;
        container = fresh;
      }

      for (const id of adapter.getResultIds(container)) {
        if (byId.has(id)) continue;
        let record = null;
        try {
          record = adapter.extractResult(id, container);
        } catch (err) {
          console.warn('[leadmine] extract failed', id, err);
        }
        if (record) byId.set(id, record);
      }

      const before = state.found;
      report({ found: byId.size, total: byId.size });

      if (maxResults && byId.size >= maxResults) {
        stopped = `the limit of ${maxResults}`;
        break;
      }
      if (adapter.reachedEnd(container)) {
        stopped = 'the source said there are no more';
        break;
      }

      stagnantRounds = byId.size > before ? 0 : stagnantRounds + 1;
      if (stagnantRounds >= 4) {
        stopped = 'four rounds in a row added nothing';
        break;
      }

      const more = await adapter.loadMore(container);
      if (more === false) {
        stopped = 'there was no next page';
        break;
      }
      await sleep(scrollDelay);
    }

    const records = [...byId.values()];
    harvest.stoppedBecause = stopped;
    return maxResults ? records.slice(0, maxResults) : records;
  }

  /* ------------------------------------------------------- the detail pass */

  async function enrichWithDetails(adapter, records, config) {
    if (typeof adapter.openDetail !== 'function') return;
    report({ phase: 'details', total: records.length });

    for (let i = 0; i < records.length; i += 1) {
      if (state.cancelled) break;
      const record = records[i];

      if (!adapter.needsDetail(record)) {
        report({ detailed: i + 1 });
        continue;
      }

      try {
        const detail = await adapter.openDetail(record, config, { waitFor, sleep });
        if (detail) {
          for (const [k, v] of Object.entries(detail)) {
            if (v !== '' && v !== null && v !== undefined) record[k] = v;
          }
        }
      } catch (err) {
        console.warn('[leadmine] detail failed for', record.name, err);
      }

      try {
        await adapter.closeDetail({ waitFor, sleep });
      } catch {
        /* ignore — the next open re-checks for the list */
      }

      report({ detailed: i + 1 });
      await sleep(config.detailDelay || 250);
    }
  }

  /* ----------------------------------------------------------------- driver */

  async function run(config) {
    const adapter = pickAdapter(location.href);
    if (!adapter) {
      throw new Error(`This page is not a supported search results page (${location.host}).`);
    }

    const blocked = adapter.blockedReason ? adapter.blockedReason() : '';
    if (blocked) throw new Error(blocked);

    const context = adapter.getSearchContext ? adapter.getSearchContext() : {};
    let records = await harvest(adapter, config);

    if (!records) {
      // Some searches land straight on a single result instead of a list.
      const single = adapter.extractSingle ? await adapter.extractSingle({ waitFor }) : null;
      if (!single) {
        throw new Error(
          'No results list found on this page. Make sure the tab is showing search results.'
        );
      }
      records = [single];
    }

    if (config.deep !== false && records.length) {
      await enrichWithDetails(adapter, records, config);
    }

    if (typeof adapter.finalise === 'function') adapter.finalise(records, config, context);
    for (const record of records) record.source = adapter.id;

    report({ phase: 'done' });
    return { records, context, stoppedBecause: harvest.stoppedBecause || '' };
  }

  // Exposed so adapters can share the engine's helpers.
  globalThis.MLSEngine = { state, sleep, waitFor, report };

  /* --------------------------------------------------------------- messaging */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'PING') {
      const adapter = pickAdapter(location.href);
      sendResponse({ ok: true, running: state.running, source: adapter ? adapter.id : null });
      return undefined;
    }

    if (msg.type === 'CANCEL_SCRAPE') {
      state.cancelled = true;
      sendResponse({ ok: true });
      return undefined;
    }

    if (msg.type === 'RUN_SCRAPE') {
      if (state.running) {
        sendResponse({ ok: false, error: 'A scrape is already running in this tab.' });
        return undefined;
      }
      state.running = true;
      state.cancelled = false;
      state.found = 0;
      state.detailed = 0;

      run(msg.config || {})
        .then(({ records, context, stoppedBecause }) =>
          sendResponse({ ok: true, records, context, stoppedBecause, cancelled: state.cancelled })
        )
        .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }))
        .finally(() => {
          state.running = false;
          state.phase = 'idle';
        });
      return true; // keep the message channel open for the async reply
    }

    return undefined;
  });
})();
