import test from 'node:test';
import assert from 'node:assert/strict';

// parse.js is a classic content script that publishes itself on globalThis;
// importing it for its side effect is how we reach the functions from Node.
await import('../src/lib/parse.js');
const P = globalThis.MLSParse;

test('norm collapses the exotic spaces Maps emits', () => {
  assert.equal(P.norm('  Cafe  Mocha   '), 'Cafe Mocha');
  assert.equal(P.norm(null), '');
});

test('nameKey ignores case and punctuation when matching a business', () => {
  assert.equal(P.nameKey("Joe's Pizza & Bar"), P.nameKey('joes pizza and bar').replace('and', ''));
  assert.equal(P.nameKey('Dr. A. Kumar Dental'), 'drakumardental');
});

test('looksLikePhone separates numbers from review counts and hours', () => {
  assert.equal(P.looksLikePhone('044 2345 6789'), true);
  assert.equal(P.looksLikePhone('+91 98765 43210'), true);
  assert.equal(P.looksLikePhone('(555) 123-4567'), true);
  assert.equal(P.looksLikePhone('1,234 reviews'), false);
  assert.equal(P.looksLikePhone('Open 24 hours'), false);
  assert.equal(P.looksLikePhone('4.5'), false);
  assert.equal(P.looksLikePhone('₹200–400'), false);
  assert.equal(P.looksLikePhone(''), false);
});

test('parseRatingLabel reads the star aria-label', () => {
  assert.deepEqual(P.parseRatingLabel('4.5 stars 1,284 Reviews'), { rating: '4.5', reviews: '1284' });
  assert.deepEqual(P.parseRatingLabel('5.0 stars 3 Reviews'), { rating: '5.0', reviews: '3' });
  assert.deepEqual(P.parseRatingLabel('No reviews'), { rating: '', reviews: '' });
});

test('parseCardParts splits a card into category, address and phone', () => {
  assert.deepEqual(
    P.parseCardParts(['Dental clinic', '12, Anna Nagar', 'Open ⋅ Closes 9 pm', '044 2345 6789']),
    { category: 'Dental clinic', address: '12, Anna Nagar', phone: '044 2345 6789' }
  );
});

test('parseCardParts drops stray numbers and keeps a category-only card', () => {
  assert.deepEqual(P.parseCardParts(['4.6', '(212)', 'Coffee shop']), {
    category: 'Coffee shop',
    address: '',
    phone: '',
  });
});

test('parseCardParts takes a non-street address when no street hint is present', () => {
  const out = P.parseCardParts(['Law firm', 'Marine Drive']);
  assert.equal(out.category, 'Law firm');
  assert.equal(out.address, 'Marine Drive');
});

test('deriveArea returns the segment before the searched city', () => {
  assert.equal(
    P.deriveArea('12, 2nd Ave, Anna Nagar, Chennai, Tamil Nadu 600040, India', 'Chennai'),
    'Anna Nagar'
  );
  assert.equal(
    P.deriveArea('221B Baker St, Marylebone, London NW1 6XE, United Kingdom', 'London'),
    'Marylebone'
  );
});

test('deriveArea still answers when the city is absent or unmatched', () => {
  assert.equal(P.deriveArea('5 Main St, Springfield, IL 62701, United States', ''), 'Springfield');
  assert.equal(P.deriveArea('5 Main St, Springfield, IL 62701', 'Nowhere'), 'Springfield');
});

test('deriveArea handles a one-segment address and empty input', () => {
  assert.equal(P.deriveArea('Anna Nagar', 'Chennai'), 'Anna Nagar');
  assert.equal(P.deriveArea('', 'Chennai'), '');
  assert.equal(P.deriveArea('India', 'Chennai'), '');
});

test('deriveArea matches a city glued to its postcode', () => {
  assert.equal(P.deriveArea('9 High St, Camden, London 600040, India', 'London'), 'Camden');
});

test('phoneFromItemId unwraps the call button attribute', () => {
  assert.equal(P.phoneFromItemId('phone:tel:+919876543210'), '+919876543210');
  assert.equal(P.phoneFromItemId('address'), '');
  assert.equal(P.phoneFromItemId(null), '');
});
