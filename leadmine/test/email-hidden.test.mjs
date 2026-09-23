/**
 * Addresses a business publishes and a plain regex cannot see.
 *
 * Every case here is a way real small-business sites hide an email from
 * scrapers while still showing it to a visitor: Cloudflare's obfuscation,
 * HTML entities, "[at]" spellings, and JSON-LD. Plus the second look — a real
 * tab — for sites that answer a bare request with a 403 or an empty shell.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeCfEmail,
  decodeEntities,
  deobfuscate,
  extractEmails,
  extractStructured,
  pageText,
  looksBlocked,
  findEmailForSite,
} from '../src/lib/email.js';

/** Encode an address the way Cloudflare does: a key byte, then every byte XORed with it. */
function cfEncode(email, key = 0x5a) {
  const hex = (n) => n.toString(16).padStart(2, '0');
  return hex(key) + [...email].map((c) => hex(c.charCodeAt(0) ^ key)).join('');
}

test('Cloudflare-protected addresses decode back to the real one', () => {
  const hex = cfEncode('info@brightsmile.in');
  assert.equal(decodeCfEmail(hex), 'info@brightsmile.in');
  assert.equal(decodeCfEmail('zz'), '', 'not hex');
  assert.equal(decodeCfEmail('5a1b'), '', 'decodes to something that is not an address');
});

test('both Cloudflare spellings are found in a page', () => {
  const html =
    `<a href="/cdn-cgi/l/email-protection#${cfEncode('sales@acme.co.in')}">[email&#160;protected]</a>` +
    `<span class="__cf_email__" data-cfemail="${cfEncode('hr@acme.co.in', 0x21)}">[email protected]</span>`;
  const emails = extractEmails(html, 'acme.co.in');
  assert.ok(emails.includes('sales@acme.co.in'));
  assert.ok(emails.includes('hr@acme.co.in'));
});

test('entities hiding the @ are decoded before the regex runs', () => {
  assert.equal(decodeEntities('info&#64;shop.in'), 'info@shop.in');
  assert.equal(decodeEntities('info&#x40;shop&period;in'), 'info@shop.in');
  assert.deepEqual(extractEmails('<p>Write to info&#64;shop.in</p>', 'shop.in'), ['info@shop.in']);
});

test('[at] and (dot) spellings are read, plain English is not', () => {
  const found = deobfuscate(
    'Mail info [at] acme [dot] co [dot] in, or sales(at)acme(dot)com. ' +
      'We meet at the office at noon. Contact hello at acme dot com.'
  );
  assert.ok(found.includes('info@acme.co.in'));
  assert.ok(found.includes('sales@acme.com'));
  assert.ok(found.includes('hello@acme.com'), 'a role word before "at … dot" is an address');
  assert.ok(!found.some((e) => e.startsWith('office@') || e.startsWith('meet@')), 'ordinary words are not');
});

test('JSON-LD gives the email, phone, people and description the business typed in', () => {
  const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@graph":[
      {"@type":"LocalBusiness","name":"Bright Smile Dental","email":"mailto:Care@BrightSmile.in",
       "telephone":"+91 44 2345 6789","description":"Family dental clinic in Adyar since 2004.",
       "founder":{"@type":"Person","name":"Dr. Priya Raman","jobTitle":"Chief Dentist"},
       "numberOfEmployees":{"@type":"QuantitativeValue","value":12}}
    ]}</script>`;
  const s = extractStructured(html);
  assert.deepEqual(s.emails, ['care@brightsmile.in']);
  assert.deepEqual(s.phones, ['+91 44 2345 6789']);
  assert.deepEqual(s.people, ['Dr. Priya Raman (Chief Dentist)']);
  assert.match(s.description, /Family dental clinic/);
  assert.equal(s.employees, '12');
  assert.equal(s.name, 'Bright Smile Dental');
  assert.ok(extractEmails(html, 'brightsmile.in').includes('care@brightsmile.in'));
});

test('broken JSON-LD is skipped, not fatal', () => {
  const s = extractStructured('<script type="application/ld+json">{nope</script>');
  assert.deepEqual(s.emails, []);
});

test('page text keeps the title and description, drops scripts and markup', () => {
  const html =
    '<html><head><title>Acme Training | Corporate courses</title>' +
    '<meta name="description" content="Corporate training for IT teams in Chennai"></head>' +
    '<body><script>var x = "secret";</script><style>.a{}</style><h1>Welcome</h1><p>We train &amp; certify.</p></body></html>';
  const text = pageText(html);
  assert.match(text, /^Acme Training \| Corporate courses/);
  assert.match(text, /Corporate training for IT teams in Chennai/);
  assert.match(text, /We train & certify\./);
  assert.ok(!text.includes('secret'), 'no script content');
  assert.ok(pageText('x'.repeat(5000), 100).length <= 100, 'capped');
});

test('a blocked or empty page is recognised as needing a real browser', () => {
  assert.equal(looksBlocked('', 200), true, 'nothing came back');
  assert.equal(looksBlocked('<html>ok</html>', 403), true, 'a firewall said no');
  assert.equal(looksBlocked('<title>Just a moment...</title>', 200), true, 'a challenge page');
  const shell = '<html><body><div id="root"></div><script src=a.js></script><script src=b.js></script><script>x</script></body></html>';
  assert.equal(looksBlocked(shell, 200), true, 'a JavaScript shell');
  const real = `<html><body><p>${'We are a real business with a real page. '.repeat(10)}</p></body></html>`;
  assert.equal(looksBlocked(real, 200), false);
});

/* ------------------------------------------------ the fetch and the tab */

function fakeFetch(pages) {
  return async (url) => {
    const page = pages[url] ?? pages[url.replace(/\/$/, '')];
    if (page === undefined) return { ok: false, status: 404, headers: new Map(), text: async () => '' };
    const { status = 200, html = '' } = typeof page === 'string' ? { html: page } : page;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'text/html' },
      text: async () => html,
    };
  };
}

test('a site that 403s a plain fetch is read from a real tab instead', async () => {
  const rendered = [];
  const result = await findEmailForSite('acme.in', {
    fetchImpl: fakeFetch({ 'https://acme.in/': { status: 403 } }),
    render: async (url) => {
      rendered.push(url);
      return '<html><title>Acme</title><body><a href="mailto:hello@acme.in">mail</a></body></html>';
    },
  });
  assert.deepEqual(rendered, ['https://acme.in/']);
  assert.equal(result.email, 'hello@acme.in');
  assert.equal(result.rendered, true);
  assert.equal(result.blocked, false);
  assert.match(result.siteText, /Acme/);
});

test('a site a plain fetch reads fine is never opened in a tab', async () => {
  let rendered = 0;
  const body = `<html><body><p>${'Real words about a real business. '.repeat(10)}</p><p>info@fine.in</p></body></html>`;
  const result = await findEmailForSite('https://fine.in', {
    fetchImpl: fakeFetch({ 'https://fine.in/': body }),
    render: async () => {
      rendered += 1;
      return '';
    },
  });
  assert.equal(rendered, 0);
  assert.equal(result.email, 'info@fine.in');
  assert.equal(result.rendered, false);
});

test('without a renderer a blocked site says so rather than pretending', async () => {
  const result = await findEmailForSite('https://walled.in', {
    fetchImpl: fakeFetch({ 'https://walled.in/': { status: 403 } }),
    followContactPage: false,
  });
  assert.equal(result.email, '');
  assert.equal(result.blocked, true);
});

test('contact links off the site are not followed', async () => {
  const seen = [];
  const home = `<html><body><p>${'words '.repeat(60)}</p><a href="https://forms.example.org/contact">Contact</a><a href="/contact-us">Contact us</a></body></html>`;
  const fetchImpl = async (url) => {
    seen.push(url);
    return fakeFetch({
      'https://site.in/': home,
      'https://site.in/contact-us': '<p>office@site.in</p>',
    })(url);
  };
  const result = await findEmailForSite('https://site.in', { fetchImpl });
  assert.equal(result.email, 'office@site.in');
  assert.ok(!seen.some((u) => u.includes('forms.example.org')), 'a third-party form is not the contact page');
});

test('a dead or missing site is not worth a tab', async () => {
  let rendered = 0;
  const render = async () => {
    rendered += 1;
    return '';
  };
  await findEmailForSite('https://gone.in', { fetchImpl: fakeFetch({}), render, followContactPage: false });
  await findEmailForSite('https://down.in', {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    render,
    followContactPage: false,
  });
  assert.equal(rendered, 0, 'a 404 and a network failure do not open tabs');
});
