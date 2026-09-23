/** The search queue. */

import { buildGrid, gridSteps, viewportSpanMetres } from './geo.js';
import { supportsGrid, buildTerm } from './sources.js';
import { buildUrl as buildQueryUrl, partition } from './linkedin-query.js';
import { postQueries, postSearchUrl } from './posts.js';

/** Parse the batch box into search pairs. */
export function parseBatch(text, source) {
  const searches = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    let category = line;
    let city = '';

    const comma = line.split(',');
    if (comma.length >= 2) {
      // "dentists, Chennai, Tamil Nadu" -> category "dentists", city "Chennai, Tamil Nadu"
      category = comma[0].trim();
      city = comma.slice(1).join(',').trim();
    } else {
      const inSplit = line.match(/^(.*?)\s+in\s+(.+)$/i);
      if (inSplit) {
        category = inSplit[1].trim();
        city = inSplit[2].trim();
      }
    }

    if (!category) continue;
    searches.push({ category, city, term: buildTerm(source, category, city) });
  }

  return searches;
}

/** The searches a config asks for, whether typed as one pair or as a batch. */
export function searchesFromConfig(config = {}) {
  const batch = parseBatch(config.batch, config.source);
  if (batch.length) return batch;

  const category = String(config.category || '').trim();
  const city = String(config.city || '').trim();
  if (!category && !city) return [];
  return [{ category, city, term: buildTerm(config.source, category, city) }];
}

/** A LinkedIn search that carries real facets, as the URL that runs it. */
function facetUrl(term, facets) {
  return buildQueryUrl({
    scalars: { keywords: String(term || '').trim(), origin: 'FACETED_SEARCH' },
    facets,
  });
}

/** Facet values, dropping the ones nothing was chosen for. */
function usedFacets(config) {
  const out = {};
  for (const [name, values] of Object.entries(config.facets || {})) {
    const list = (values || []).map((v) => String(v || '').trim()).filter(Boolean);
    if (list.length) out[name] = list;
  }
  return out;
}

/** The searches a LinkedIn run with facets should make. */
/** The names chosen per facet, dropping the blanks. */
function chosenLabels(config) {
  const out = {};
  for (const [facet, labels] of Object.entries(config.facetLabels || {})) {
    const list = (labels || []).map((v) => String(v || '').trim()).filter(Boolean);
    if (list.length) out[facet] = list;
  }
  return out;
}

/** The searches a LinkedIn run with filters should make. */
export function facetSearches(config = {}) {
  // Facets are LinkedIn's.
  if (config.source !== 'linkedin') return [];

  const labels = chosenLabels(config);
  // Nothing chosen: the run is a plain keyword search, and `searchesFromConfig` already puts the town in it.
  if (!Object.keys(labels).length) return [];

  // A town typed in "Where?" is a location the user asked for.
  const typedCity = String(config.city || '').trim();
  if (!labels.geoUrn && typedCity) labels.geoUrn = [typedCity];

  const facetNames = Object.keys(labels);
  const ids = usedFacets(config);
  // Every name has an id only when each facet's two lists line up.
  const known = facetNames.every(
    (facet) => (ids[facet] || []).length === labels[facet].length
  );

  const term = buildTerm(config.source, config.category, '');
  const places = labels.geoUrn || [];
  const split = config.splitLocations && places.length > 1;

  const search = (placeIndex) => {
    const wants = [];
    for (const facet of facetNames) {
      const chosen = facet === 'geoUrn' && placeIndex !== null
        ? [labels[facet][placeIndex]]
        : labels[facet];
      for (const label of chosen) wants.push({ facet, label });
    }

    const base = {
      category: config.category || '',
      // The label, not the id: this is what lands on every record and in the export's filename.
      city: placeIndex === null ? places.join(', ') : places[placeIndex] || '',
      term,
    };

    if (!known) return { ...base, url: facetUrl(term, {}), applyFilters: wants };

    const chosenIds = {};
    for (const facet of facetNames) {
      chosenIds[facet] = facet === 'geoUrn' && placeIndex !== null
        ? [ids[facet][placeIndex]]
        : ids[facet];
    }
    return { ...base, url: facetUrl(term, chosenIds) };
  };

  if (!split) return [search(null)];
  return places.map((_, index) => search(index));
}

/** The initial queue: one "locate" task per search. */
export function buildTaskList(config = {}) {
  // Scraping the tab the user already set up.
  if (config.useCurrentTab) {
    return [
      {
        id: 's0',
        category: config.category || '',
        city: config.city || '',
        term: '',
        point: null,
        useCurrentTab: true,
        expandsToGrid: false,
        status: 'pending',
        found: 0,
        error: '',
      },
    ];
  }

  // A LinkedIn people search is not geographic, so no grid is laid over it however the coverage control is set.
  const steps = supportsGrid(config.source) ? gridSteps(config.grid) : 1;
  // Facets outrank the typed city.
  const searches = facetSearches(config);
  const plain = searches.length ? searches : searchesFromConfig(config);
  return (config.source === 'posts' ? postSearches(plain, config) : plain).map((search, index) => ({
    id: `s${index}`,
    ...search,
    point: null,
    expandsToGrid: steps > 1,
    status: 'pending',
    found: 0,
    error: '',
  }));
}

/** The engine searches a Posts run makes: one per intent group per search. */
function postSearches(searches, config) {
  const days = Number(config.postsDays) || 10;
  const out = [];
  for (const search of searches) {
    for (const query of postQueries(search.category, search.city)) {
      out.push({ ...search, term: query, url: postSearchUrl(query, days) });
    }
  }
  return out;
}

/** Grid tasks for a search, once its locate task has revealed the map centre. */
export function expandGridTasks(task, centre, config = {}, viewport) {
  const steps = supportsGrid(config.source) ? gridSteps(config.grid) : 1;
  if (steps <= 1 || !centre) return [];

  const span = viewportSpanMetres(centre, viewport);
  return buildGrid({ lat: centre.lat, lng: centre.lng, spanM: span, steps, viewport }).map(
    (point, index) => ({
      id: `${task.id}g${index}`,
      category: task.category,
      city: task.city,
      term: task.term,
      point,
      expandsToGrid: false,
      status: 'pending',
      found: 0,
      error: '',
    })
  );
}

/** Insert new tasks directly after the one that produced them. */
export function insertAfter(tasks, taskId, extra) {
  if (!extra.length) return tasks;
  const at = tasks.findIndex((t) => t.id === taskId);
  if (at === -1) return [...tasks, ...extra];
  return [...tasks.slice(0, at + 1), ...extra, ...tasks.slice(at + 1)];
}

export function nextPending(tasks) {
  return (tasks || []).find((t) => t.status === 'pending') || null;
}

export function taskProgress(tasks) {
  const list = tasks || [];
  const settled = list.filter((t) => t.status === 'done' || t.status === 'failed').length;
  return { settled, total: list.length };
}
