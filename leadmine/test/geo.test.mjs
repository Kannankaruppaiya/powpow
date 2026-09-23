import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMapUrl,
  metresPerPixel,
  offsetLatLng,
  distanceMetres,
  viewportSpanMetres,
  buildGrid,
  zoomForSpan,
  buildSearchUrl,
  gridSteps,
} from '../src/lib/geo.js';

test('parseMapUrl reads centre and zoom out of a Maps URL', () => {
  const p = parseMapUrl('https://www.google.com/maps/search/cafes/@13.0827,80.2707,12z?hl=en');
  assert.equal(p.lat, 13.0827);
  assert.equal(p.lng, 80.2707);
  assert.equal(p.zoom, 12);
});

test('parseMapUrl handles southern and western hemispheres', () => {
  const p = parseMapUrl('https://www.google.com/maps/search/x/@-33.8688,-151.2093,14z');
  assert.equal(p.lat, -33.8688);
  assert.equal(p.lng, -151.2093);
});

test('parseMapUrl converts an altitude URL into a zoom', () => {
  const p = parseMapUrl('https://www.google.com/maps/@13.08,80.27,1500m/data=!3m1');
  assert.ok(p.zoom > 3 && p.zoom < 20, `unexpected zoom ${p.zoom}`);
});

test('parseMapUrl returns null when there is no centre yet', () => {
  assert.equal(parseMapUrl('https://www.google.com/maps/search/cafes?hl=en'), null);
  assert.equal(parseMapUrl(''), null);
});

test('metresPerPixel shrinks with zoom and with latitude', () => {
  assert.ok(metresPerPixel(0, 10) > metresPerPixel(0, 11));
  // A degree of longitude is shorter near the poles.
  assert.ok(metresPerPixel(60, 12) < metresPerPixel(0, 12));
  // Sanity: ~152 m/px at the equator at zoom 10.
  assert.ok(Math.abs(metresPerPixel(0, 10) - 152.87) < 0.5);
});

test('offsetLatLng moves the requested distance', () => {
  const origin = { lat: 13.0827, lng: 80.2707 };
  const north = offsetLatLng(origin.lat, origin.lng, 5000, 0);
  const east = offsetLatLng(origin.lat, origin.lng, 0, 5000);
  assert.ok(Math.abs(distanceMetres(origin, north) - 5000) < 10);
  assert.ok(Math.abs(distanceMetres(origin, east) - 5000) < 10);
  assert.ok(north.lat > origin.lat, 'north should increase latitude');
  assert.ok(east.lng > origin.lng, 'east should increase longitude');
});

test('buildGrid returns steps² points centred on the origin', () => {
  const centre = { lat: 13.0827, lng: 80.2707 };
  const grid = buildGrid({ ...centre, spanM: { width: 12000, height: 9000 }, steps: 3 });

  assert.equal(grid.length, 9);
  const middle = grid.find((p) => p.row === 1 && p.col === 1);
  assert.ok(distanceMetres(centre, middle) < 1, 'the middle cell should sit on the centre');
});

test('buildGrid spaces cells by one cell width', () => {
  const grid = buildGrid({
    lat: 13.0827,
    lng: 80.2707,
    spanM: { width: 12000, height: 12000 },
    steps: 3,
  });
  const a = grid.find((p) => p.row === 1 && p.col === 0);
  const b = grid.find((p) => p.row === 1 && p.col === 1);
  // 12 km across 3 cells = 4 km between neighbouring centres.
  assert.ok(Math.abs(distanceMetres(a, b) - 4000) < 50, `got ${distanceMetres(a, b)}`);
});

test('buildGrid zooms in as the grid gets denser', () => {
  const base = { lat: 13.0827, lng: 80.2707, spanM: { width: 12000, height: 9000 } };
  const coarse = buildGrid({ ...base, steps: 2 })[0].zoom;
  const fine = buildGrid({ ...base, steps: 5 })[0].zoom;
  assert.ok(fine > coarse, 'smaller cells need a higher zoom');
});

test('buildGrid with one step is a single search at the original centre', () => {
  const grid = buildGrid({ lat: 1, lng: 2, spanM: { width: 5000, height: 5000 }, steps: 1 });
  assert.equal(grid.length, 1);
  assert.equal(grid[0].lat, 1);
  assert.equal(grid[0].lng, 2);
});

test('viewportSpanMetres grows as the map zooms out', () => {
  const wide = viewportSpanMetres({ lat: 13, zoom: 11 });
  const tight = viewportSpanMetres({ lat: 13, zoom: 14 });
  assert.ok(wide.width > tight.width * 5);
});

test('zoomForSpan stays inside the range Maps honours', () => {
  assert.ok(zoomForSpan(13, 40_000_000, 1200) >= 3, 'should not go below 3');
  assert.ok(zoomForSpan(13, 1, 1200) <= 17, 'should not go above 17');
});

test('buildSearchUrl pins the language and centres the map', () => {
  const url = buildSearchUrl('dentists in Chennai', { lat: 13.0827, lng: 80.2707, zoom: 14 });
  assert.ok(url.includes('/maps/search/dentists%20in%20Chennai/'));
  assert.ok(url.includes('@13.082700,80.270700,14z'));
  assert.ok(url.includes('hl=en'));
});

test('buildSearchUrl without a point is a plain search', () => {
  const url = buildSearchUrl('cafes in Austin', null);
  assert.equal(url, 'https://www.google.com/maps/search/cafes%20in%20Austin?hl=en');
});

test('gridSteps maps presets to counts and defaults safely', () => {
  assert.equal(gridSteps('off'), 1);
  assert.equal(gridSteps('exhaustive'), 5);
  assert.equal(gridSteps('nonsense'), 3);
});
