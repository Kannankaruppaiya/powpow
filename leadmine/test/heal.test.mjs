/**
 * Self-healing selectors.
 *
 * The scoring is pure and takes fingerprints, so it is tested here without a
 * DOM; the DOM glue is exercised by the browser tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// heal.js is a classic content script that publishes itself on globalThis.
await import('../src/content/heal.js');
const H = globalThis.MLSHeal;

test('the similarity ratio behaves like difflib’s', () => {
  assert.equal(H.ratio('abc', 'abc'), 1);
  assert.equal(H.ratio('', ''), 1);
  assert.equal(H.ratio('abc', ''), 0);
  assert.equal(H.ratio('abcd', 'abxd'), 0.75);
  assert.equal(H.ratio(['div', 'a'], ['div', 'a']), 1, 'arrays of tags compare too');
});

const feed = {
  tag: 'div',
  attrs: { role: 'feed', class: 'm6QErb DxyBCb', 'aria-label': 'Results for dentists' },
  text: '',
  path: ['html', 'body', 'div', 'div', 'div', 'div'],
  parentTag: 'div',
  parentAttrs: { class: 'e07Vkf' },
  siblings: ['div', 'div'],
};

test('an element that changed its classes still scores high against itself', () => {
  const renamed = { ...feed, attrs: { ...feed.attrs, class: 'x9Qa2 DxyBCb' } };
  const stranger = { tag: 'div', attrs: { class: 'footer' }, text: 'Terms Privacy', path: ['html', 'body', 'footer', 'div'], parentTag: 'footer', parentAttrs: {}, siblings: ['a', 'a', 'a'] };
  assert.ok(H.score(feed, renamed) > 80, `renamed: ${H.score(feed, renamed)}`);
  assert.ok(H.score(feed, stranger) < 40, `stranger: ${H.score(feed, stranger)}`);
});

test('the best candidate is taken only when it clears the bar', () => {
  const renamed = { ...feed, attrs: { ...feed.attrs, role: 'list', class: 'x9Qa2' } };
  const weak = { tag: 'div', attrs: {}, text: '', path: ['html', 'body', 'div'], parentTag: 'body', parentAttrs: {}, siblings: [] };
  const best = H.bestMatch(feed, [{ fp: weak, el: 'weak' }, { fp: renamed, el: 'renamed' }], { threshold: 60 });
  assert.equal(best.el, 'renamed');
  assert.equal(H.bestMatch(feed, [{ fp: weak, el: 'weak' }], { threshold: 60 }), null, 'nothing close enough is nothing');
});

test('checks meant to differ can be ignored — every result link has its own href and name', () => {
  const link = { tag: 'a', attrs: { class: 'hfpxzc', href: '/maps/place/Acme', 'aria-label': 'Acme' }, text: '', path: ['div', 'a'], parentTag: 'div', parentAttrs: { class: 'Nv2PK' }, siblings: ['a', 'div'] };
  const other = { ...link, attrs: { ...link.attrs, href: '/maps/place/Zeta-Dental-Care', 'aria-label': 'Zeta Dental Care' } };
  const strict = H.score(link, other);
  const lenient = H.score(link, other, { ignore: ['href', 'aria-label', 'text'] });
  assert.ok(lenient > strict, `${lenient} > ${strict}`);
  assert.equal(lenient, 100);
});

test('nothing remembered means nothing relocated', () => {
  H._setMemory({});
  assert.equal(H.relocate('feed', { querySelectorAll: () => [] }), null);
  assert.deepEqual(H.healedList(), []);
});
