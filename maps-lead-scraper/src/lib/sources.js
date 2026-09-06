/**
 * What differs between the two sources, in one place.
 *
 * The engine, the queue and the storage layer are source-agnostic; these are
 * the handful of facts that are not — how to build a search URL, whether a
 * geographic grid means anything, and which fields prove the scraper is still
 * working.
 */

import { buildSearchUrl as mapsSearchUrl } from './geo.js';

export const SOURCES = {
  maps: {
    id: 'maps',
    label: 'Google Maps',
    /** Businesses: name and the place link are on every single result. */
    healthGates: { name: 0.9, mapsUrl: 0.9 },
    watched: ['name', 'mapsUrl', 'category', 'address', 'phone', 'rating', 'website'],
    // The grid is what gets past Google's ~120-per-search cap.
    supportsGrid: true,
    // Business websites are what the email pass reads.
    supportsEmails: true,
    urlPart: '/maps/',
    buildUrl: (term, point) => mapsSearchUrl(term, point),
    noun: 'businesses',
  },

  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn People',
    /** People: a name and a profile link are the two universal fields. */
    healthGates: { name: 0.9, profileUrl: 0.9 },
    watched: ['name', 'profileUrl', 'headline', 'company', 'location', 'degree'],
    // A people search is not geographic — location is a filter, not a viewport.
    supportsGrid: false,
    // People have no website to read an address off, so the email pass is moot.
    supportsEmails: false,
    urlPart: '/search/results/',
    buildUrl: (term) =>
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(String(term).trim())}`,
    noun: 'people',
  },
};

export const DEFAULT_SOURCE = 'maps';

export function sourceFor(id) {
  return SOURCES[id] || SOURCES[DEFAULT_SOURCE];
}

/** Whether this source should have a grid laid over it at all. */
export function supportsGrid(id) {
  return sourceFor(id).supportsGrid;
}

export function buildUrl(id, term, point) {
  const source = sourceFor(id);
  // A point is meaningless where the grid does not apply; drop it rather than
  // building a URL the site will ignore or choke on.
  return source.buildUrl(term, source.supportsGrid ? point : null);
}
