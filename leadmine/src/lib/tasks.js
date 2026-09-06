/**
 * The search queue.
 *
 * A run is no longer one search. It is a list of tasks, where a task is "run
 * this term at this map point", and the list comes from two multipliers:
 *
 *   batch  — several category/city pairs entered at once
 *   grid   — each pair expanded into a grid of map viewports
 *
 * Keeping the queue as plain data (rather than a loop in the worker) is what
 * makes a run resumable: it can be written to storage after every task and
 * picked up later exactly where it stopped.
 */

import { buildGrid, gridSteps, viewportSpanMetres } from './geo.js';
import { supportsGrid, buildTerm } from './sources.js';

/**
 * Parse the batch box into search pairs. Accepts either separator people
 * actually type:
 *
 *   dentists, Chennai
 *   gyms in Coimbatore
 *   # comments and blank lines are ignored
 */
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

/**
 * The initial queue: one "locate" task per search.
 *
 * A locate task runs the plain search, which both collects its own results and
 * tells us where on the globe the city actually is — the map centre and zoom
 * land in the tab's URL. That is what the grid is then built around, so no
 * geocoding service is needed.
 */
export function buildTaskList(config = {}) {
  // Scraping the tab the user already set up: there is one search, it is
  // whatever is on screen, and the extension must not navigate — navigating
  // is exactly what would throw away the filters they applied by hand.
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

  // A LinkedIn people search is not geographic, so no grid is laid over it
  // however the coverage control is set.
  const steps = supportsGrid(config.source) ? gridSteps(config.grid) : 1;
  return searchesFromConfig(config).map((search, index) => ({
    id: `s${index}`,
    ...search,
    point: null,
    expandsToGrid: steps > 1,
    status: 'pending',
    found: 0,
    error: '',
  }));
}

/**
 * Grid tasks for a search, once its locate task has revealed the map centre.
 * Returns [] when gridding is off or the centre could not be read.
 */
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
