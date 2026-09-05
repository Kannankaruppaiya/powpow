import { toCsv } from './lib/csv.js';

const $ = (id) => document.getElementById(id);
const fields = ['category', 'city', 'gridSize', 'tileKm', 'maxResults', 'zoom'];

async function loadForm() {
  const { form } = await chrome.storage.local.get('form');
  if (!form) return;
  for (const id of fields) if (form[id] !== undefined) $(id).value = form[id];
  $('findEmails').checked = !!form.findEmails;
}

function saveForm() {
  const form = { findEmails: $('findEmails').checked };
  for (const id of fields) form[id] = $(id).value;
  void chrome.storage.local.set({ form });
}

function readConfig() {
  return {
    category: $('category').value.trim(),
    city: $('city').value.trim(),
    findEmails: $('findEmails').checked,
    gridSize: Math.max(1, parseInt($('gridSize').value, 10) || 1),
    tileKm: Math.max(1, parseFloat($('tileKm').value) || 3),
    maxResults: Math.max(1, parseInt($('maxResults').value, 10) || 200),
    zoom: Math.min(17, Math.max(11, parseInt($('zoom').value, 10) || 14)),
    maxPerTile: 300,
    scrollPauseMs: 1100,
    tilePauseMs: 1500,
    detailPauseMs: 900,
  };
}

function render(state, count) {
  $('status').textContent = state.message || 'Ready.';
  $('start').disabled = state.running;
  $('stop').disabled = !state.running;
  $('download').disabled = count === 0;

  const parts = [];
  if (state.tilesTotal) parts.push(state.tilesDone + '/' + state.tilesTotal + ' areas');
  if (state.linksFound) parts.push(state.linksFound + ' listings found');
  if (state.detailsDone) parts.push(state.detailsDone + ' read');
  if (state.emailsFound) parts.push(state.emailsFound + ' emails');
  if (count && state.phase === 'done') parts.push(count + ' rows ready');
  $('counts').textContent = parts.join(' · ');

  let pct = 0;
  if (state.phase === 'collecting' && state.tilesTotal) {
    pct = (state.tilesDone / state.tilesTotal) * 40;
  } else if (state.phase === 'details' && state.linksFound) {
    pct = 40 + (state.detailsDone / state.linksFound) * 50;
  } else if (state.phase === 'emails') {
    pct = 92;
  } else if (state.phase === 'done') {
    pct = 100;
  }
  $('progress').style.width = pct + '%';
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: 'getState' });
  if (res) render(res.state, res.count);
}

$('start').addEventListener('click', async () => {
  const config = readConfig();
  if (!config.category || !config.city) {
    $('status').textContent = 'Enter both a category and a city.';
    return;
  }
  saveForm();
  await chrome.runtime.sendMessage({ type: 'start', config });
  await refresh();
});

$('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  await refresh();
});

$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear' });
  await refresh();
});

$('download').addEventListener('click', async () => {
  const { results } = await chrome.runtime.sendMessage({ type: 'getResults' });
  if (!results || !results.length) return;
  const blob = new Blob([toCsv(results)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const slug = ($('category').value + '-' + $('city').value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'maps-leads';
  await chrome.downloads.download({ url, filename: slug + '-' + stamp + '.csv', saveAs: true });
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

for (const id of fields) $(id).addEventListener('change', saveForm);
$('findEmails').addEventListener('change', saveForm);

loadForm();
refresh();
setInterval(refresh, 1000);
