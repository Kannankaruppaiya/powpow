import { collectPlaceLinks, extractPlaceDetails, readMapCentre } from './lib/injected.js';
import { findEmails } from './lib/email.js';

const IDLE_STATE = {
  running: false,
  phase: 'idle',
  message: 'Ready.',
  tilesTotal: 0,
  tilesDone: 0,
  linksFound: 0,
  detailsDone: 0,
  emailsFound: 0,
  startedAt: null,
  finishedAt: null,
};

let state = { ...IDLE_STATE };
let results = [];
let stopRequested = false;
let workerTabId = null;

// ---------------------------------------------------------------- persistence

async function save() {
  await chrome.storage.local.set({ state, results });
}

async function restore() {
  const stored = await chrome.storage.local.get(['state', 'results']);
  if (stored.results) results = stored.results;
  if (stored.state) {
    // A run cannot survive a service-worker restart, so never restore as running.
    state = { ...stored.state, running: false };
    if (stored.state.running) {
      state.phase = 'stopped';
      state.message = 'Interrupted — the extension was reloaded mid-run.';
    }
  }
}

const ready = restore();

function setState(patch) {
  state = { ...state, ...patch };
  void save();
}

// ------------------------------------------------------------------ utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jitter(base) {
  return base + Math.floor(Math.random() * base * 0.5);
}

function checkStop() {
  if (stopRequested) throw new Error('__stopped__');
}

/** Builds a square grid of search centres so we can get past the ~120 result cap. */
function buildTiles(centre, gridSize, tileKm) {
  const half = Math.floor(gridSize / 2);
  const latStep = tileKm / 111;
  const lngStep = tileKm / (111 * Math.max(0.15, Math.cos((centre.lat * Math.PI) / 180)));
  const tiles = [];
  for (let row = -half; row <= half; row++) {
    for (let col = -half; col <= half; col++) {
      tiles.push({ lat: centre.lat + row * latStep, lng: centre.lng + col * lngStep });
    }
  }
  // Work outwards from the centre so an early stop still covers the core of the city.
  tiles.sort((a, b) => {
    const da = Math.abs(a.lat - centre.lat) + Math.abs(a.lng - centre.lng);
    const db = Math.abs(b.lat - centre.lat) + Math.abs(b.lng - centre.lng);
    return da - db;
  });
  return tiles;
}

/** Splits "12 MG Road, Indiranagar, Bengaluru, Karnataka 560038" into an area. */
function deriveArea(address, city) {
  if (!address) return '';
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const cityLower = (city || '').toLowerCase().split(',')[0].trim();
  const isNoise = (p) => /^\d{4,8}$/.test(p) || /^[A-Z]{2}\s*\d/.test(p);
  const cleaned = parts.filter((p) => !isNoise(p));
  const cityIndex = cleaned.findIndex((p) => cityLower && p.toLowerCase().includes(cityLower));
  if (cityIndex > 0) return cleaned[cityIndex - 1];
  if (cleaned.length >= 3) return cleaned[cleaned.length - 3];
  return cleaned[0] || '';
}

// ------------------------------------------------------------- tab automation

async function ensureTab() {
  if (workerTabId !== null) {
    try {
      await chrome.tabs.get(workerTabId);
      return workerTabId;
    } catch {
      workerTabId = null;
    }
  }
  const tab = await chrome.tabs.create({ url: 'https://www.google.com/maps', active: false });
  workerTabId = tab.id;
  await waitForLoad(workerTabId);
  return workerTabId;
}

function waitForLoad(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigate(url) {
  const tabId = await ensureTab();
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  return tabId;
}

async function runInTab(tabId, func, args = []) {
  const [injected] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return injected ? injected.result : null;
}

// ------------------------------------------------------------------- the crawl

async function geocodeCity(city) {
  const tabId = await navigate('https://www.google.com/maps/place/' + encodeURIComponent(city));
  await sleep(1500);
  const centre = await runInTab(tabId, readMapCentre);
  if (!centre) throw new Error('Could not locate "' + city + '" on Google Maps.');
  return centre;
}

async function crawl(config) {
  const query = config.category + ' in ' + config.city;

  setState({ phase: 'locating', message: 'Locating ' + config.city + '…' });
  const centre = await geocodeCity(config.city);
  checkStop();

  const tiles = config.gridSize > 1 ? buildTiles(centre, config.gridSize, config.tileKm) : [centre];
  setState({ tilesTotal: tiles.length, phase: 'collecting' });

  // Phase 1 — sweep the grid collecting place links.
  const seen = new Map();
  for (let i = 0; i < tiles.length; i++) {
    checkStop();
    const tile = tiles[i];
    const url =
      'https://www.google.com/maps/search/' +
      encodeURIComponent(query) +
      '/@' + tile.lat.toFixed(6) + ',' + tile.lng.toFixed(6) + ',' + config.zoom + 'z';

    setState({ message: 'Searching area ' + (i + 1) + ' of ' + tiles.length + '…' });
    const tabId = await navigate(url);
    await sleep(jitter(1200));

    let batch = { links: [] };
    try {
      batch = await runInTab(tabId, collectPlaceLinks, [
        { maxIdleRounds: 5, maxItems: config.maxPerTile, pauseMs: config.scrollPauseMs },
      ]);
    } catch (err) {
      setState({ message: 'Area ' + (i + 1) + ' failed: ' + err.message });
    }

    for (const link of (batch && batch.links) || []) {
      if (!seen.has(link.key)) seen.set(link.key, link);
    }
    setState({ tilesDone: i + 1, linksFound: seen.size });

    if (config.maxResults && seen.size >= config.maxResults) break;
    await sleep(jitter(config.tilePauseMs));
  }

  let links = Array.from(seen.values());
  if (config.maxResults) links = links.slice(0, config.maxResults);

  // Phase 2 — open each place and read its detail panel.
  setState({ phase: 'details', message: 'Reading ' + links.length + ' listings…' });
  results = [];
  await save();

  for (let i = 0; i < links.length; i++) {
    checkStop();
    setState({ message: 'Listing ' + (i + 1) + ' of ' + links.length + '…' });
    try {
      const tabId = await navigate(links[i].href);
      const details = await runInTab(tabId, extractPlaceDetails);
      if (details && details.name) {
        results.push({
          ...details,
          email: '',
          area: deriveArea(details.address, config.city),
          query,
        });
      }
    } catch (err) {
      if (err.message === '__stopped__') throw err;
    }
    setState({ detailsDone: i + 1 });
    if (i % 10 === 0) await save();
    await sleep(jitter(config.detailPauseMs));
  }
  await save();

  // Phase 3 — optional: find emails on the business websites.
  if (config.findEmails) {
    const withSites = results.filter((r) => r.website);
    setState({
      phase: 'emails',
      message: 'Checking ' + withSites.length + ' websites for emails…',
    });
    let checked = 0;
    let found = 0;
    for (const row of withSites) {
      checkStop();
      const emails = await findEmails(row.website);
      if (emails.length) {
        row.email = emails.join('; ');
        found++;
      }
      checked++;
      setState({
        emailsFound: found,
        message: 'Website ' + checked + ' of ' + withSites.length + ' — ' + found + ' emails so far.',
      });
      if (checked % 5 === 0) await save();
    }
  }

  await save();
  return results.length;
}

async function start(config) {
  await ready;
  if (state.running) return;

  stopRequested = false;
  results = [];
  state = {
    ...IDLE_STATE,
    running: true,
    phase: 'starting',
    message: 'Starting…',
    startedAt: Date.now(),
  };
  await save();

  try {
    const count = await crawl(config);
    setState({
      running: false,
      phase: 'done',
      message: 'Finished — ' + count + ' listings collected.',
      finishedAt: Date.now(),
    });
  } catch (err) {
    const stopped = err.message === '__stopped__';
    setState({
      running: false,
      phase: stopped ? 'stopped' : 'error',
      message: stopped
        ? 'Stopped — ' + results.length + ' listings kept.'
        : 'Error: ' + err.message,
      finishedAt: Date.now(),
    });
  } finally {
    if (workerTabId !== null) {
      try {
        await chrome.tabs.remove(workerTabId);
      } catch {
        /* the tab may already be closed */
      }
      workerTabId = null;
    }
  }
}

// -------------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg.type) {
      case 'start':
        void start(msg.config);
        sendResponse({ ok: true });
        break;
      case 'stop':
        stopRequested = true;
        setState({ message: 'Stopping after the current listing…' });
        sendResponse({ ok: true });
        break;
      case 'getState':
        sendResponse({ state, count: results.length });
        break;
      case 'getResults':
        sendResponse({ results });
        break;
      case 'clear':
        results = [];
        state = { ...IDLE_STATE };
        await save();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // keep the channel open for the async response
});
