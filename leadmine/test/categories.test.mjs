import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMON_CATEGORIES,
  parseCategoryFilter,
  matchesCategory,
  filterByCategory,
  observedCategories,
  suggestionsFor,
} from '../src/lib/categories.js';

/** What "wholesale store, Chennai" actually returned on a live run. */
const WHOLESALE_RUN = [
  { name: 'BULKBIZZ WHOLESALE', category: 'Furniture wholesaler' },
  { name: 'MAHALAXMI STORES', category: 'Wholesale market' },
  { name: 'NAVIN STORES', category: 'Wholesale market' },
  { name: 'Balaji Traders', category: 'Wholesale Food Store' },
  { name: 'Wholesale Mandi', category: 'Produce market' },
  { name: 'Amjath Mobiles', category: 'Cell phone accessory store' },
  { name: 'Subbulakshmi', category: 'Wholesale grocer' },
  { name: 'M J WHOLESALE SHOP', category: 'General store' },
  { name: 'M.A.Ethirajulu', category: 'Home goods store' },
  { name: 'Burma Traders', category: 'Clothing wholesale market place' },
];

test('an empty filter keeps everything, which is the old behaviour', () => {
  for (const blank of ['', '   ', null, undefined]) {
    const { kept, dropped } = filterByCategory(WHOLESALE_RUN, blank);
    assert.equal(kept.length, WHOLESALE_RUN.length, `"${blank}" should not filter`);
    assert.equal(dropped.length, 0);
  }
});

test('one word narrows a mixed result set to what was wanted', () => {
  const { kept, dropped } = filterByCategory(WHOLESALE_RUN, 'wholesale');
  assert.deepEqual(
    kept.map((r) => r.category),
    ['Furniture wholesaler', 'Wholesale market', 'Wholesale market', 'Wholesale Food Store', 'Wholesale grocer', 'Clothing wholesale market place']
  );
  assert.ok(dropped.some((r) => r.category === 'Cell phone accessory store'));
});

test('matching is by substring, because nobody knows Google’s exact labels', () => {
  // "wholesale" has to catch "Furniture wholesaler" or the field is useless.
  assert.equal(matchesCategory('Furniture wholesaler', ['wholesale']), true);
  assert.equal(matchesCategory('WHOLESALE MARKET', ['wholesale']), true, 'case-insensitive');
  assert.equal(matchesCategory('Produce market', ['wholesale']), false);
});

test('commas mean "any of these"', () => {
  const { kept } = filterByCategory(WHOLESALE_RUN, 'produce, general store');
  assert.deepEqual(kept.map((r) => r.name), ['Wholesale Mandi', 'M J WHOLESALE SHOP']);
});

test('spacing and empty terms in the input are forgiven', () => {
  assert.deepEqual(parseCategoryFilter('  Wholesale Market , , produce  '), [
    'wholesale market',
    'produce',
  ]);
  assert.deepEqual(parseCategoryFilter(''), []);
});

test('an unlabelled listing is dropped when a filter is set', () => {
  // It cannot be shown to match, and keeping it would defeat the narrowing.
  const rows = [{ name: 'No category', category: '' }, { name: 'Yes', category: 'Wholesale market' }];
  const { kept, dropped } = filterByCategory(rows, 'wholesale');
  assert.deepEqual(kept.map((r) => r.name), ['Yes']);
  assert.equal(dropped.length, 1);
});

test('a different field can be filtered, for sources without categories', () => {
  const people = [
    { name: 'Priya', headline: 'Corporate Java Trainer at Zion' },
    { name: 'Raj', headline: 'Backend Engineer at Globex' },
  ];
  const { kept } = filterByCategory(people, 'trainer', 'headline');
  assert.deepEqual(kept.map((r) => r.name), ['Priya']);
});

test('observedCategories ranks by how often each appeared', () => {
  const seen = observedCategories(WHOLESALE_RUN);
  assert.equal(seen[0], 'Wholesale market', 'the two-listing category leads');
  assert.ok(!seen.includes(''), 'blanks are not suggestions');
});

test('suggestions put what the run found ahead of the standing list', () => {
  const out = suggestionsFor(WHOLESALE_RUN);
  const firstStanding = out.findIndex((c) => COMMON_CATEGORIES.includes(c) && !observedCategories(WHOLESALE_RUN).includes(c));
  assert.equal(out[0], 'Wholesale market');
  assert.ok(firstStanding > 5, 'the observed ones come first');
  assert.equal(new Set(out).size, out.length, 'no duplicates between the two lists');
});

test('suggestions still work before any run has happened', () => {
  const out = suggestionsFor([]);
  assert.deepEqual(out, COMMON_CATEGORIES);
});

test('a person is filtered on everything their card says, not just the headline', () => {
  // The live case: LinkedIn's best result for "kotlin trainer" carried the
  // word Trainer only in its "Current:" line. Filtering the headline alone
  // set the single most relevant person aside.
  const people = [
    {
      name: 'Shishupalsingh Bhati',
      headline: 'Software Developer @Invisible| JAVA | KOTLIN | DSA |',
      summary: 'Current: Kotlin Coding Specialist - AI Trainer at Invisible Technologies',
      company: 'Invisible Technologies',
    },
    { name: 'Someone Else', headline: 'Product Manager', summary: '', company: 'Acme' },
  ];

  const fields = ['headline', 'summary', 'company'];
  const { kept, dropped } = filterByCategory(people, 'trainer', fields);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, 'Shishupalsingh Bhati');
  assert.equal(dropped.length, 1);

  // The headline alone is what used to be matched, and it loses them.
  assert.equal(filterByCategory(people, 'trainer', 'headline').kept.length, 0);

  // A term in any one of the fields is enough.
  assert.equal(filterByCategory(people, 'invisible', fields).kept.length, 1);
  assert.equal(filterByCategory(people, 'kotlin', fields).kept.length, 1);
});
