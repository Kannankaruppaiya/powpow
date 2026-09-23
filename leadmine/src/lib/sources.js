/** What differs between the two sources, in one place. */

import { buildSearchUrl as mapsSearchUrl } from './geo.js';
import { postSearchUrl } from './posts.js';

export const SOURCES = {
  maps: {
    id: 'maps',
    label: 'Google Maps',
    site: 'Google Maps',
    rowNoun: 'listings',
    /** Businesses: name and the place link are on every single result. */
    healthGates: { name: 0.9, mapsUrl: 0.9 },
    watched: ['name', 'mapsUrl', 'category', 'address', 'phone', 'rating', 'website'],
    // The grid is what gets past Google's ~120-per-search cap.
    supportsGrid: true,
    // Business websites are what the email pass reads.
    supportsEmails: true,
    // A business is labelled with a category; that is what narrowing filters on.
    filterField: 'category',
    filterLabel: 'Category',
    filterHint: 'Only keep listings whose category matches',
    urlPart: '/maps/',
    buildUrl: (term, point) => mapsSearchUrl(term, point),
    // "dentists in Chennai" is exactly how a person phrases a Maps search.
    buildTerm: (category, city) => (city ? `${category} in ${city}` : category).trim(),
    noun: 'businesses',
  },

  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn People',
    site: 'LinkedIn',
    rowNoun: 'people',
    /** People: a name and a profile link are the two universal fields. */
    healthGates: { name: 0.9, profileUrl: 0.9 },
    watched: ['name', 'profileUrl', 'headline', 'company', 'location', 'degree'],
    // A people search is not geographic — location is a filter, not a viewport.
    supportsGrid: false,
    // People have no website to read an address off, so the email pass is moot.
    supportsEmails: false,
    // A person has no category, and their headline is not the whole story.
    filterField: ['headline', 'summary', 'company'],
    filterLabel: 'Headline contains',
    filterHint: 'Only keep people whose headline matches',
    urlPart: '/search/results/',
    buildUrl: (term) =>
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(String(term).trim())}`,
    // LinkedIn matches keywords literally.
    buildTerm: (category, city) => [category, city].filter(Boolean).join(' ').trim(),
    noun: 'people',
  },

  web: {
    id: 'web',
    label: 'Public web',
    site: 'The search engine',
    rowNoun: 'results',
    /** A search result gives a name and a profile link, and little else. */
    healthGates: { name: 0.9, profileUrl: 0.9 },
    watched: ['name', 'profileUrl', 'headline', 'company', 'location'],
    // A search engine's results are a list, not a map.
    supportsGrid: false,
    // There is no company website here to read an address off.
    supportsEmails: false,
    filterField: ['headline', 'summary', 'company'],
    filterLabel: 'Result text contains',
    filterHint: 'Only keep people whose result text matches',
    urlPart: '/search',
    // Google by default.
    buildUrl: (term) => `https://www.google.com/search?q=${encodeURIComponent(String(term).trim())}`,
    // The whole point of this source.
    buildTerm: (category, city) =>
      ['site:linkedin.com/in', category, city].filter(Boolean).join(' ').trim(),
    noun: 'people',
  },

  // Recent LinkedIn posts that ask for something.
  posts: {
    id: 'posts',
    label: 'LinkedIn posts',
    site: 'The search engine',
    rowNoun: 'posts',
    // Every post has a link, and the link carries the id its date comes from.
    healthGates: { postUrl: 0.9, postId: 0.9 },
    watched: ['postUrl', 'postId', 'author', 'text', 'postedAt'],
    supportsGrid: false,
    supportsEmails: false,
    filterField: ['text', 'headline', 'author'],
    filterLabel: 'Post text contains',
    filterHint: 'Only keep posts whose text matches',
    urlPart: '/search',
    // "Use the tab I'm on" reads an engine's results or LinkedIn's own post search.
    matchesTab: (url) =>
      /^https:\/\/([\w-]+\.)?linkedin\.com\/search\/results\/content/.test(url) ||
      /^https?:\/\/(?:[\w-]+\.)?google\.[a-z.]+\/search\b/.test(url) ||
      /^https?:\/\/(?:[\w-]+\.)?duckduckgo\.com\//.test(url),
    // One URL per intent group is built in tasks.js, where the window in days is known.
    buildUrl: (term) => postSearchUrl(String(term).trim(), 10),
    buildTerm: (category, city) =>
      ['site:linkedin.com/posts', category, city].filter(Boolean).join(' ').trim(),
    noun: 'posts',
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

/** How this source phrases "category + city" as one search string. */
export function buildTerm(id, category, city) {
  const source = sourceFor(id);
  return source.buildTerm(String(category || '').trim(), String(city || '').trim());
}

export function buildUrl(id, term, point) {
  const source = sourceFor(id);
  // A point is meaningless where the grid does not apply.
  return source.buildUrl(term, source.supportsGrid ? point : null);
}
