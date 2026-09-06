import test from 'node:test';
import assert from 'node:assert/strict';

import { extractEmails, normaliseUrl, mapWithConcurrency } from '../src/lib/email.js';

test('normaliseUrl adds a scheme and rejects junk', () => {
  assert.equal(normaliseUrl('example.com'), 'https://example.com/');
  assert.equal(normaliseUrl('http://shop.test/a'), 'http://shop.test/a');
  assert.equal(normaliseUrl(''), '');
  assert.equal(normaliseUrl('javascript:alert(1)'), '');
});

test('extractEmails reads mailto links and plain copy', () => {
  const html = `<a href="mailto:info@clinic.com?subject=Hi">Mail us</a>
    <p>Or write to reception@clinic.com</p>`;
  assert.deepEqual(extractEmails(html, 'clinic.com').sort(), ['info@clinic.com', 'reception@clinic.com']);
});

test('extractEmails drops asset filenames that look like addresses', () => {
  const html = '<img src="logo@2x.png"><span>sprite@3x.webp</span> real@shop.test';
  assert.deepEqual(extractEmails(html, 'shop.test'), ['real@shop.test']);
});

test('extractEmails drops third-party platform addresses', () => {
  const html = 'a@sentry.io b@wixpress.com c@example.com d@schema.org owner@bakery.test';
  assert.deepEqual(extractEmails(html, 'bakery.test'), ['owner@bakery.test']);
});

test('extractEmails ranks the site’s own domain above free mailboxes', () => {
  const html = 'backup@gmail.com info@bakery.test';
  assert.equal(extractEmails(html, 'www.bakery.test')[0], 'info@bakery.test');
});

test('extractEmails prefers role addresses and demotes no-reply', () => {
  const html = 'no-reply@shop.test personal.name@shop.test contact@shop.test';
  const [first, ...rest] = extractEmails(html, 'shop.test');
  assert.equal(first, 'contact@shop.test');
  assert.equal(rest[rest.length - 1], 'no-reply@shop.test');
});

test('extractEmails copes with empty input', () => {
  assert.deepEqual(extractEmails('', 'x.test'), []);
  assert.deepEqual(extractEmails(null), []);
});

test('mapWithConcurrency visits every item and honours the ceiling', async () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const seen = [];
  let live = 0;
  let peak = 0;

  await mapWithConcurrency(items, 4, async (item) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    seen.push(item);
    live -= 1;
  });

  assert.deepEqual(seen.sort((a, b) => a - b), items);
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('mapWithConcurrency handles an empty list', async () => {
  let calls = 0;
  await mapWithConcurrency([], 4, async () => {
    calls += 1;
  });
  assert.equal(calls, 0);
});
