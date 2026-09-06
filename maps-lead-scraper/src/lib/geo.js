/**
 * Geographic grid search.
 *
 * Google caps a single Maps search at roughly 120 results regardless of how
 * many businesses match. The way past that is to stop asking one question and
 * start asking many: split the city into a grid of viewports and run the same
 * search centred on each cell, then dedupe the union.
 *
 * Everything here is pure maths on the Web Mercator projection Maps uses, so
 * it needs no geocoding service and no API key — the centre and zoom come
 * straight out of the Maps URL after the first search.
 */

/** Metres per pixel at zoom 0 on the equator, for a 256px tile. */
const EQUATOR_MPP = 156543.03392804097;
const EARTH_RADIUS_M = 6378137;
const MAX_LAT = 85.05112878; // Web Mercator cuts off at the poles

const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Pull the map centre out of a Maps URL.
 * "https://www.google.com/maps/search/cafes/@13.0827,80.2707,12z" ->
 *   { lat: 13.0827, lng: 80.2707, zoom: 12 }
 */
export function parseMapUrl(url) {
  const m = String(url || '').match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)([zmy])/);
  if (!m) return null;
  const [, lat, lng, value, unit] = m;
  // Maps sometimes writes an altitude in metres ("...,1500m") instead of a
  // zoom level; convert it to the equivalent zoom so callers see one unit.
  const zoom = unit === 'z' ? Number(value) : altitudeToZoom(Number(value), Number(lat));
  return { lat: Number(lat), lng: Number(lng), zoom };
}

function altitudeToZoom(metres, lat) {
  if (!(metres > 0)) return 12;
  const mpp = metres / 1000; // rough: the altitude spans about 1000px of map
  return Math.log2((EQUATOR_MPP * Math.cos(toRad(lat))) / mpp);
}

/** Metres covered by one screen pixel at this latitude and zoom. */
export function metresPerPixel(lat, zoom) {
  return (EQUATOR_MPP * Math.cos(toRad(clampLat(lat)))) / 2 ** zoom;
}

/** Move a point by a distance in metres. */
export function offsetLatLng(lat, lng, northM, eastM) {
  const dLat = (northM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = (eastM / (EARTH_RADIUS_M * Math.cos(toRad(clampLat(lat))))) * (180 / Math.PI);
  return { lat: clampLat(lat + dLat), lng: lng + dLng };
}

/** Great-circle distance in metres, used to keep grids honest in the tests. */
export function distanceMetres(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * How wide an area the map shows, in metres, for a given viewport.
 *
 * This is what lets the grid size itself: a search that lands at z=11 covers a
 * much bigger city than one that lands at z=14, and the grid should cover
 * exactly what the user was looking at.
 */
export function viewportSpanMetres({ lat, zoom }, viewport = { width: 1200, height: 900 }) {
  const mpp = metresPerPixel(lat, zoom);
  return { width: mpp * viewport.width, height: mpp * viewport.height };
}

/**
 * Build a grid of search points covering `spanM` metres around a centre.
 *
 * `steps` is the number of cells per side, so 3 gives 9 searches and 5 gives
 * 25. Each cell gets its own zoom, computed so one cell fills the viewport —
 * that is what makes Maps return results local to the cell rather than
 * repeating the same city-wide top 120.
 */
export function buildGrid({ lat, lng, spanM, steps = 3, viewport = { width: 1200, height: 900 } }) {
  const n = Math.max(1, Math.round(steps));
  if (n === 1) {
    return [{ lat, lng, zoom: zoomForSpan(lat, spanM.width, viewport.width), row: 0, col: 0 }];
  }

  const cellW = spanM.width / n;
  const cellH = spanM.height / n;
  // One zoom for the whole grid keeps every cell's coverage identical.
  const zoom = zoomForSpan(lat, Math.max(cellW, cellH), Math.max(viewport.width, viewport.height));

  const points = [];
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      // Cell centres: -(n-1)/2 … +(n-1)/2 cell widths from the middle.
      const north = (row - (n - 1) / 2) * cellH;
      const east = (col - (n - 1) / 2) * cellW;
      const point = offsetLatLng(lat, lng, north, east);
      points.push({ ...point, zoom, row, col });
    }
  }
  return points;
}

/** The zoom at which `spanM` metres fill `pixels` pixels. */
export function zoomForSpan(lat, spanM, pixels) {
  const mpp = spanM / pixels;
  const zoom = Math.log2((EQUATOR_MPP * Math.cos(toRad(clampLat(lat)))) / mpp);
  // Maps ignores anything outside this range, and beyond ~17 the search starts
  // returning almost nothing.
  return Math.round(Math.max(3, Math.min(17, zoom)) * 10) / 10;
}

/**
 * A Maps search URL centred on a point.
 *
 * hl=en pins the language, because several fields are parsed out of English
 * aria-label prefixes.
 */
export function buildSearchUrl(term, point) {
  const query = encodeURIComponent(String(term).trim());
  if (!point) return `https://www.google.com/maps/search/${query}?hl=en`;
  const { lat, lng, zoom } = point;
  return `https://www.google.com/maps/search/${query}/@${lat.toFixed(6)},${lng.toFixed(6)},${zoom}z?hl=en`;
}

/**
 * Grid presets, phrased as the trade-off the user actually cares about:
 * how many searches am I willing to sit through?
 */
export const GRID_PRESETS = {
  off: { steps: 1, label: 'Off — one search (~120 results)' },
  light: { steps: 2, label: 'Light — 4 searches' },
  balanced: { steps: 3, label: 'Balanced — 9 searches' },
  thorough: { steps: 4, label: 'Thorough — 16 searches' },
  exhaustive: { steps: 5, label: 'Exhaustive — 25 searches' },
};

export function gridSteps(preset) {
  return (GRID_PRESETS[preset] || GRID_PRESETS.balanced).steps;
}
