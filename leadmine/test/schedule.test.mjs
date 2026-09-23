import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTime, nextRunAt, scheduledConfig, cannotSchedule, describeSchedule, missedRun } from '../src/lib/schedule.js';

// Friday 2026-09-25 09:00 local.
const FRIDAY_9 = new Date(2026, 8, 25, 9, 0).getTime();

test('times are read as HH:MM and nothing else', () => {
  assert.deepEqual(parseTime('08:30'), { hours: 8, minutes: 30 });
  assert.deepEqual(parseTime('7:05'), { hours: 7, minutes: 5 });
  assert.equal(parseTime('25:00'), null);
  assert.equal(parseTime('8.30'), null);
});

test('the next run is later today, or tomorrow once the time has passed', () => {
  const later = new Date(nextRunAt({ time: '17:00', days: 'daily' }, FRIDAY_9));
  assert.equal(later.getDate(), 25);
  assert.equal(later.getHours(), 17);
  const tomorrow = new Date(nextRunAt({ time: '08:30', days: 'daily' }, FRIDAY_9));
  assert.equal(tomorrow.getDate(), 26, 'Saturday, on a daily schedule');
});

test('a weekday schedule skips the weekend', () => {
  const next = new Date(nextRunAt({ time: '08:30', days: 'weekdays' }, FRIDAY_9));
  assert.equal(next.getDay(), 1, 'Monday');
  assert.equal(next.getDate(), 28);
});

test('a scheduled run is unattended and only brings what is new', () => {
  const config = scheduledConfig({ source: 'posts', category: 'sap trainer', useCurrentTab: true, skipSeen: false });
  assert.equal(config.useCurrentTab, false);
  assert.equal(config.background, true);
  assert.equal(config.skipSeen, true);
  assert.equal(config.category, 'sap trainer');
});

test('what cannot be scheduled says why', () => {
  assert.match(cannotSchedule(null), /Set up a search/);
  assert.match(cannotSchedule({ useCurrentTab: true, category: 'x' }), /tab you are on/);
  assert.match(cannotSchedule({ category: ' ' }), /what to search for/);
  assert.equal(cannotSchedule({ category: 'dentists' }), '');
  assert.equal(cannotSchedule({ batch: 'a, b' }), '');
});

test('the schedule describes itself in a line', () => {
  assert.equal(
    describeSchedule({ enabled: true, time: '08:30', days: 'weekdays', config: { source: 'posts', category: 'sap trainer', city: 'Chennai' } }),
    'Weekdays at 08:30 — sap trainer, Chennai (Posts)'
  );
  assert.equal(describeSchedule({ enabled: false }), '');
});

test('a time that passed while Chrome was closed is caught up, once', () => {
  const schedule = { enabled: true, time: '08:30', days: 'daily', since: FRIDAY_9 };
  const saturdayNoon = new Date(2026, 8, 26, 12).getTime();
  assert.equal(missedRun(schedule, FRIDAY_9 + 60000), false, 'nothing due yet');
  assert.equal(missedRun(schedule, saturdayNoon), true, 'Saturday 08:30 was missed');
  assert.equal(missedRun({ ...schedule, lastRunAt: saturdayNoon - 3600000 }, saturdayNoon), false, 'it ran');
  assert.equal(missedRun({ ...schedule, since: 0, lastRunAt: 0 }, saturdayNoon), false, 'switching it on never fires at once');
  assert.equal(missedRun({ ...schedule, enabled: false }, saturdayNoon), false);
});
