/** Follow-ups, the do-not-contact list, and the cold-email export. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addWorkingDays,
  statusPatch,
  isDue,
  parseSuppressionLine,
  parseSuppressionText,
  suppressionKeys,
  suppressionChecker,
  suppressionEntriesFor,
  splitName,
  sequencerRows,
  SEQUENCER_COLUMNS,
} from '../src/lib/crm.js';

// Friday 2026-09-25, noon local.
const FRIDAY = new Date(2026, 8, 25, 12);

test('working days skip the weekend', () => {
  assert.equal(addWorkingDays(FRIDAY, 1), '2026-09-28', 'Friday + 1 is Monday');
  assert.equal(addWorkingDays(FRIDAY, 3), '2026-09-30');
  assert.equal(addWorkingDays(FRIDAY, 5), '2026-10-02');
});

test('contacting starts the clock; follow-ups move it; the last one ends it', () => {
  const first = statusPatch({}, 'contacted', FRIDAY);
  assert.equal(first.touches, 1);
  assert.equal(first.followUpOn, '2026-09-30', 'three working days');

  const second = statusPatch({ touches: 1 }, 'followed_up', FRIDAY);
  assert.equal(second.touches, 2);
  assert.equal(second.followUpOn, '2026-10-02', 'five more');

  const third = statusPatch({ touches: 2 }, 'followed_up', FRIDAY);
  assert.equal(third.touches, 3);
  assert.equal(third.followUpOn, null, 'three unanswered emails is where the pursuit stops');

  assert.equal(statusPatch({ touches: 1, followUpOn: 'x' }, 'replied', FRIDAY).followUpOn, null, 'nobody chases a reply');
  assert.equal(statusPatch({}, 'do_not_contact', FRIDAY).suppressed, true);
});

test('a follow-up is due on its day, not before, and never once closed', () => {
  assert.equal(isDue({ status: 'contacted', followUpOn: '2026-09-30' }, '2026-09-29'), false);
  assert.equal(isDue({ status: 'contacted', followUpOn: '2026-09-30' }, '2026-09-30'), true);
  assert.equal(isDue({ status: 'contacted', followUpOn: '2026-09-30' }, '2026-10-05'), true, 'overdue is still due');
  assert.equal(isDue({ status: 'not_interested', followUpOn: '2026-09-30' }, '2026-10-05'), false);
  assert.equal(isDue(null), false);
});

test('each kind of do-not-contact line is understood', () => {
  assert.deepEqual(parseSuppressionLine('Priya@Acme.in'), { value: 'email:priya@acme.in', kind: 'email', label: 'Priya@Acme.in' });
  assert.equal(parseSuppressionLine('acme.in').value, 'domain:acme.in');
  assert.equal(parseSuppressionLine('https://www.acme.in/about').value, 'domain:acme.in');
  assert.equal(parseSuppressionLine('https://www.linkedin.com/in/Priya-R/').value, 'profile:priya-r');
  assert.equal(parseSuppressionLine('+91 98765 43210').value, 'phone:9876543210');
  assert.equal(parseSuppressionLine('# a comment'), null);
  assert.match(parseSuppressionLine('gmail.com').error, /shared mailbox domain/, 'suppressing gmail.com would suppress everyone');
  assert.match(parseSuppressionLine('call me maybe').error, /not an email/);
});

test('a pasted list is split, deduplicated, and its errors reported', () => {
  const { entries, errors } = parseSuppressionText('a@x.in\na@x.in\nx.in\n\nnonsense\n');
  assert.deepEqual(entries.map((e) => e.value), ['email:a@x.in', 'domain:x.in']);
  assert.equal(errors.length, 1);
});

test('an opt-out follows the person across every way they can reappear', () => {
  const list = [
    { value: 'email:priya@acme.in' },
    { value: 'domain:blocked.in' },
    { value: 'profile:arun-k' },
    { value: 'phone:9876543210' },
  ];
  const blocked = suppressionChecker(list);
  assert.equal(blocked({ email: 'PRIYA@acme.in' }), true, 'case does not matter');
  assert.equal(blocked({ email: 'anyone@blocked.in' }), true, 'a whole domain');
  assert.equal(blocked({ website: 'https://www.blocked.in/' }), true, 'the business’s own site');
  assert.equal(blocked({ profileUrl: 'https://in.linkedin.com/in/Arun-K?x=1' }), true);
  assert.equal(blocked({ authorUrl: 'https://www.linkedin.com/in/arun-k/' }), true, 'as a post author too');
  assert.equal(blocked({ phone: '098765 43210' }), true, 'the same phone, written differently');
  assert.equal(blocked({ emails: 'x@y.in; priya@acme.in' }), true, 'an address written in a post');
  assert.equal(blocked({ name: 'x' }, { personEmail: 'priya@acme.in' }), true, 'an address a finder found');
  assert.equal(blocked({ name: 'x' }, { status: 'do_not_contact' }), true);
  assert.equal(blocked({ email: 'someone@gmail.com' }), false);
});

test('a free-mail address never suppresses its whole domain', () => {
  assert.ok(!suppressionKeys({ email: 'a@gmail.com' }).includes('domain:gmail.com'));
  assert.ok(suppressionKeys({ email: 'a@acme.in' }).includes('domain:acme.in'));
});

test('marking a lead do-not-contact lists its address, profile and phone', () => {
  const entries = suppressionEntriesFor(
    { email: 'info@acme.in', phone: '+91 98765 43210', profileUrl: 'https://www.linkedin.com/in/ravi' },
    {}
  );
  assert.deepEqual(entries.map((e) => e.value), ['email:info@acme.in', 'profile:ravi', 'phone:9876543210']);
});

test('names split for a merge tag, with titles and brackets dropped', () => {
  assert.deepEqual(splitName('Dr. Priya Raman'), { first: 'Priya', last: 'Raman' });
  assert.deepEqual(splitName('Ravi Kumar (Founder)'), { first: 'Ravi', last: 'Kumar' });
  assert.deepEqual(splitName(''), { first: '', last: '' });
});

test('the cold-email file holds only leads it is right to write to', () => {
  const records = [
    { key: 'b1', source: 'maps', name: 'Acme Training', email: 'info@acme.in', website: 'https://acme.in', phone: '+91 1', city: 'Chennai' },
    { key: 'b2', source: 'maps', name: 'No Email Co' },
    { key: 'b3', source: 'maps', name: 'Bounce Co', email: 'x@nomx.in', emailStatus: 'no-mx' },
    { key: 'b4', source: 'maps', name: 'Poor Fit', email: 'hi@poor.in' },
    { key: 'b5', source: 'maps', name: 'Opted Out', email: 'hi@out.in' },
    { key: 'b6', source: 'maps', name: 'Closed', email: 'hi@closed.in' },
    { key: 'p1', source: 'linkedin', name: 'Priya Raman', headline: 'Head of L&D', company: 'Acme Training', profileUrl: 'https://www.linkedin.com/in/priya' },
    { key: 'b7', source: 'maps', name: 'Duplicate', email: 'INFO@acme.in' },
  ];
  const notes = new Map([
    ['b1', { verdict: 'fit', reason: 'Trains SAP teams.', decisionMaker: 'Ravi Kumar (Founder)' }],
    ['b4', { verdict: 'fit', feedback: 'bad' }],
    ['b6', { status: 'not_interested' }],
    ['p1', { personEmail: 'priya@acme.in', firstName: 'Priya', lastName: 'Raman' }],
  ]);
  const rows = sequencerRows(records, notes, {
    isSuppressed: suppressionChecker([{ value: 'email:hi@out.in' }]),
  });
  assert.deepEqual(rows.map((r) => r.email), ['info@acme.in', 'priya@acme.in']);
  const [biz, person] = rows;
  assert.equal(biz.first_name, 'Ravi', 'the decision maker the site named');
  assert.equal(biz.company, 'Acme Training');
  assert.equal(biz.reason, 'Trains SAP teams.');
  assert.equal(person.title, 'Head of L&D');
  assert.equal(person.linkedin_url, 'https://www.linkedin.com/in/priya');
  assert.deepEqual(SEQUENCER_COLUMNS.slice(0, 3).map((c) => c.label), ['email', 'first_name', 'last_name']);
});
