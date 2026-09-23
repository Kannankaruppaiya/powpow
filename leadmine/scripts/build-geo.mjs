/**
 * Generates the country / state / city lists the "Where?" picker offers.
 *
 * The source is the Countries States Cities Database, a public dataset of
 * 250 countries, ~5,000 states and ~150,000 cities:
 *
 *   https://github.com/dr5hn/countries-states-cities-database
 *
 * It is not vendored, because the file is 46 MB and almost all of that is
 * things a dropdown has no use for — ids, coordinates, timezones, currency,
 * translations, wikiData links. This strips it to names and writes one small
 * file per country, so the panel loads India and nothing else when you pick
 * India.
 *
 * The output is committed; this only needs re-running to refresh the data.
 *
 *   node scripts/build-geo.mjs
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'data', 'geo');
const SOURCE =
  'https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/countries%2Bstates%2Bcities.json';

/** Sort the way a person reads a list, not the way bytes compare. */
const collator = new Intl.Collator('en', { sensitivity: 'base' });
const byName = (a, b) => collator.compare(a, b);

/** Duplicates are common in the source; a dropdown showing one twice is a bug. */
function uniqueSorted(names) {
  const seen = new Map();
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) seen.set(key, name);
  }
  return [...seen.values()].sort(byName);
}

async function load() {
  // A local copy is honoured so a rebuild does not re-download 46 MB.
  const cached = process.argv[2];
  if (cached && existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));

  process.stdout.write(`Fetching ${SOURCE}\n`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
  return res.json();
}

const data = await load();

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const index = [];
let states = 0;
let cities = 0;

for (const country of data) {
  const code = String(country.iso2 || '').trim();
  const name = String(country.name || '').trim();
  // Without a code there is no filename, and without a name there is nothing
  // to show — either way it cannot be offered.
  if (!code || !name) continue;

  const regions = [];
  for (const state of country.states || []) {
    const stateName = String(state.name || '').trim();
    if (!stateName) continue;
    const list = uniqueSorted((state.cities || []).map((city) => city.name));
    regions.push({ n: stateName, c: list });
    cities += list.length;
  }
  regions.sort((a, b) => byName(a.n, b.n));
  states += regions.length;

  index.push({ c: code, n: name, e: String(country.emoji || '') });
  writeFileSync(join(OUT, `${code}.json`), JSON.stringify({ n: name, s: regions }));
}

index.sort((a, b) => byName(a.n, b.n));
writeFileSync(join(OUT, 'countries.json'), JSON.stringify(index));

process.stdout.write(
  `Wrote ${index.length} countries, ${states} states, ${cities} cities to src/data/geo\n`
);
