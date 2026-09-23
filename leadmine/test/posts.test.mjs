/**
 * The Posts source's arithmetic and judgement, without a browser.
 *
 * Every id below is a real LinkedIn post id, read off a real post URL, with
 * the date LinkedIn itself showed for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  postIdFrom,
  postedAtFromId,
  postUrlFor,
  contactsIn,
  classifyPost,
  topicWords,
  annotatePost,
  narrowPosts,
  postVerdict,
  postQueries,
  postSearchUrl,
  engineWindowDays,
} from '../src/lib/posts.js';

// The title parser runs in the content script, so it lives in parse.js.
await import('../src/lib/parse.js');
const { parsePostTitle } = globalThis.MLSParse;

const DAY = 86400000;

test('a post id decodes to the moment LinkedIn says the post was made', () => {
  assert.equal(new Date(postedAtFromId('7500139413100740609')).toISOString(), '2026-08-31T10:36:21.935Z');
  assert.equal(new Date(postedAtFromId('7488467598196527109')).toISOString(), '2026-07-30T05:36:44.410Z');
});

test('anything that is not a post id decodes to nothing, never to a wrong date', () => {
  assert.equal(postedAtFromId(''), null);
  assert.equal(postedAtFromId('12345'), null, 'too short to be an id');
  assert.equal(postedAtFromId('1000000000000000000'), null, 'decodes to before LinkedIn used these ids');
  assert.equal(postedAtFromId('9999999999999999999'), null, 'decodes to the future');
  assert.equal(postedAtFromId('abc'), null);
});

test('the id is found in every URL shape a post is linked by', () => {
  const id = '7502588916743708672';
  for (const url of [
    `https://www.linkedin.com/posts/sarala-geriga-352940243_urgenthiring-corporatetrainer-activity-${id}-b0d4`,
    `https://in.linkedin.com/posts/sarala_x-activity-${id}-b0d4?utm_source=share`,
    `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
    `https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A${id}`,
    `https://www.linkedin.com/posts/acme_title-ugcPost-${id}-AbCd`,
    `https://www.linkedin.com/feed/update/urn:li:share:${id}`,
  ]) {
    assert.equal(postIdFrom(url), id, url);
  }
  assert.equal(postIdFrom('https://www.linkedin.com/in/priya-sharma'), '', 'a profile is not a post');
  assert.equal(postIdFrom('https://x.test/%E0%A4%A'), '', 'a malformed escape does not throw');
  assert.equal(postUrlFor(id), `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`);
});

test('the author and the text come out of every title shape', () => {
  assert.deepEqual(parsePostTitle('Urgent SAP FI trainer requirement | Shreya Wagh'), {
    author: 'Shreya Wagh',
    text: 'Urgent SAP FI trainer requirement',
  });
  assert.deepEqual(parsePostTitle('Shreya Wagh on LinkedIn: Urgent SAP FI trainer requirement'), {
    author: 'Shreya Wagh',
    text: 'Urgent SAP FI trainer requirement',
  });
  assert.deepEqual(parsePostTitle("Shreya Wagh's Post - LinkedIn"), { author: 'Shreya Wagh', text: '' });
  assert.deepEqual(parsePostTitle('🚨 Urgent requirement | Shreya Wagh posted on the topic | LinkedIn'), {
    author: 'Shreya Wagh',
    text: '🚨 Urgent requirement',
  });
  // The post's own " | " punctuation, with a long tail, is not an author.
  const long = parsePostTitle('Trainer needed | Location: Pune, Mode: Onsite, Duration: two months starting next week');
  assert.equal(long.author, '');
});

test('contacts are read out of post text, and nothing else is', () => {
  const { emails, phones } = contactsIn(
    'mail vandanatbgi@gmail.comto us or call 8146785224, +91-98765 43210, +971 50 123 4567. ' +
      'Post 7502588916743708672, on 2026-09-13, fee 50000, ₹8,000 per day. Email: TA7069@SFJBS.com.'
  );
  assert.deepEqual(emails, ['vandanatbgi@gmail.com', 'ta7069@sfjbs.com']);
  assert.deepEqual(phones, ['8146785224', '+91-98765 43210', '+971 50 123 4567']);
  // Real TLDs that start like the glued ones are left alone.
  assert.deepEqual(contactsIn('hr@acme.company and a@b.network').emails, ['hr@acme.company', 'a@b.network']);
});

test('a requirement is DEMAND, and says why', () => {
  const r = classifyPost(
    '🚨 URGENT CORPORATE TRAINER REQUIREMENT – PUNE. We are urgently looking for experienced Corporate ' +
      'Trainers. Commercials: ₹8,000 Per Day. Share your updated profile.',
    { topic: 'corporate trainer' }
  );
  assert.equal(r.intent, 'DEMAND');
  assert.ok(r.score >= 70, String(r.score));
  for (const label of ['looking for', 'requirement', 'urgent', 'share your profile', 'commercials']) {
    assert.ok(r.signals.includes(label), label);
  }
});

test('a trainer selling themselves is not a lead, even using the buyer’s words', () => {
  const r = classifyPost(
    'I am a certified corporate trainer, available for corporate training sessions. ' +
      'If you require soft skills training, DM me.',
    { topic: 'corporate trainer' }
  );
  assert.equal(r.intent, 'SUPPLY');
});

test('a job seeker "looking for" work is not a buyer', () => {
  assert.equal(classifyPost('Looking for new opportunities as a corporate trainer #opentowork').intent, 'SUPPLY');
});

test('a thank-you post after a session is RECAP', () => {
  const r = classifyPost('Successfully conducted a 3-day corporate training at Acme. Thank you for the opportunity!');
  assert.equal(r.intent, 'RECAP');
});

test('an institute advertising a course is SUPPLY', () => {
  assert.equal(classifyPost('New batch starts Monday! Enroll now, limited seats. Join our Power BI course.').intent, 'SUPPLY');
});

test('"need to" is not a need', () => {
  assert.equal(classifyPost('I need to thank everyone who came to the workshop').intent, 'OTHER');
});

test('a post that never mentions the topic is marked off topic and ranked down', () => {
  const on = classifyPost('SAP FI trainer required urgently', { topic: 'SAP FI trainer' });
  const off = classifyPost('Plumber required urgently', { topic: 'SAP FI trainer' });
  assert.ok(off.signals.includes('off topic'));
  assert.ok(on.score > off.score);
  // "trainer" finds "training": a stem, not a whole word.
  assert.equal(classifyPost('Corporate training requirement', { topic: 'corporate trainer' }).relevant, true);
  assert.deepEqual(topicWords('site:linkedin.com/posts corporate trainer in Chennai'), ['corporate', 'trainer', 'chennai']);
});

test('annotating a post dates it from its id and reads its contacts', () => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  const row = annotatePost(
    {
      postUrl: 'https://www.linkedin.com/posts/x_activity-7502588916743708672-b0d4',
      text: 'Corporate trainer requirement. Share your profile: hr@acme.test / 88617 81909',
    },
    { now, topic: 'corporate trainer' }
  );
  assert.equal(row.postId, '7502588916743708672');
  assert.equal(row.postedAt, '2026-09-07T04:49:49.113Z');
  assert.equal(row.ageDays, 2.8);
  assert.equal(row.intent, 'DEMAND');
  assert.equal(row.emails, 'hr@acme.test');
  assert.equal(row.phones, '88617 81909');
  // Annotating twice changes nothing.
  assert.deepEqual(annotatePost(row, { now, topic: 'corporate trainer' }), row);
});

const post = (daysAgo, now, extra = {}) => ({
  postedAt: new Date(now - daysAgo * DAY).toISOString(),
  intent: 'DEMAND',
  author: `a${daysAgo}`,
  text: `post ${daysAgo} with enough words to fingerprint it properly`,
  ...extra,
});

test('posts older than the window are set aside, with the reason', () => {
  const now = Date.now();
  const { kept, dropped } = narrowPosts([post(2, now), post(9.9, now), post(10.1, now), post(40, now)], { days: 10, now });
  assert.equal(kept.length, 2);
  assert.deepEqual(dropped.map((r) => r.setAside), ['older than 10 days', 'older than 10 days']);
});

test('only requirement posts are kept unless asked otherwise, and none are deleted', () => {
  const now = Date.now();
  const rows = [post(1, now), post(2, now, { intent: 'SUPPLY' }), post(3, now, { intent: 'RECAP' })];
  const strict = narrowPosts(rows, { now });
  assert.equal(strict.kept.length, 1);
  assert.equal(strict.dropped.length, 2);
  assert.match(strict.dropped[0].setAside, /not a requirement post \(supply\)/);
  assert.equal(narrowPosts(rows, { now, intentOnly: false }).kept.length, 3);
});

test('a repost of the same text by the same author is folded into the newer copy', () => {
  const now = Date.now();
  const text = 'Urgent requirement for a corporate trainer in Pune, share your profile';
  const { kept, dropped } = narrowPosts(
    [post(5, now, { author: 'Sarala', text }), post(1, now, { author: 'Sarala', text })],
    { now }
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].postedAt, new Date(now - DAY).toISOString(), 'the newer copy is the one kept');
  assert.equal(dropped[0].setAside, 'a copy of a newer post');
});

test('a post with no decodable date is set aside rather than trusted', () => {
  const { kept, dropped } = narrowPosts([{ intent: 'DEMAND', text: 'x' }]);
  assert.equal(kept.length, 0);
  assert.equal(dropped[0].setAside, 'no post date');
});

test('each search becomes one engine query per intent group, restricted to posts', () => {
  const queries = postQueries('corporate trainer', 'Chennai');
  assert.equal(queries.length, 2);
  for (const q of queries) {
    assert.match(q, /^site:linkedin\.com\/posts corporate trainer Chennai \(/);
    assert.ok(q.split(/\s+/).length <= 32, 'Google ignores words past the 32nd');
  }
  assert.deepEqual(postQueries('trainer', ''), postQueries('trainer'));
});

test('the engine window is a little wider than asked for, and the URL carries it', () => {
  assert.equal(engineWindowDays(10), 12);
  assert.equal(engineWindowDays(0), 12, 'nothing asked for means the default');
  const url = new URL(postSearchUrl('site:linkedin.com/posts trainer', 7));
  assert.equal(url.hostname, 'www.google.com');
  assert.equal(url.searchParams.get('tbs'), 'qdr:d9');
  assert.equal(url.searchParams.get('filter'), '0');
  assert.equal(url.searchParams.get('q'), 'site:linkedin.com/posts trainer');
});

test('a row is judged on its own as it arrives, and a stale verdict is never inherited', () => {
  const now = Date.now();
  assert.equal(postVerdict(post(1, now), { now }), '');
  assert.equal(postVerdict(post(12, now), { now }), 'older than 10 days');
  assert.equal(postVerdict(post(1, now, { intent: 'OTHER' }), { now }), 'not a requirement post (other)');
  assert.equal(postVerdict(post(1, now, { intent: 'OTHER' }), { now, intentOnly: false }), '');
  // Set aside while its text was a one-line title, kept once the whole post
  // arrived: the old reason must not ride along.
  const { kept } = narrowPosts([post(1, now, { setAside: 'not a requirement post (other)' })], { now });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].setAside, undefined);
});
