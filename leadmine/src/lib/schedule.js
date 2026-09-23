/** Run a saved search on a clock. */

export const SCHEDULE_KEY = 'mls.schedule';
export const ALARM_NAME = 'leadmine-scheduled-run';

export const DEFAULT_SCHEDULE = {
  enabled: false,
  time: '08:30',
  days: 'weekdays', // 'daily' | 'weekdays'
  config: null,
  label: '',
  lastRunAt: 0,
};

/** "HH:MM", or null when it is not a time. */
export function parseTime(value) {
  const m = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? { hours: Number(m[1]), minutes: Number(m[2]) } : null;
}

/** The next moment the schedule should fire, strictly after `now`. */
export function nextRunAt(schedule, now = Date.now()) {
  const time = parseTime(schedule && schedule.time);
  if (!time) return null;
  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(time.hours, time.minutes);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  if (schedule.days === 'weekdays') {
    while (at.getDay() === 0 || at.getDay() === 6) at.setDate(at.getDate() + 1);
  }
  return at.getTime();
}

/** Whether a scheduled time has passed with no run for it. */
export function missedRun(schedule, now = Date.now()) {
  if (!schedule || !schedule.enabled) return false;
  const since = schedule.lastRunAt || schedule.since;
  if (!since) return false;
  const due = nextRunAt(schedule, since);
  return Boolean(due && due <= now);
}

/** The config a scheduled run actually uses: the saved search, unattended. */
export function scheduledConfig(saved) {
  if (!saved) return null;
  return {
    ...saved,
    useCurrentTab: false,
    background: true,
    // Only what is new since the last run: that is what a morning report is.
    skipSeen: true,
    rememberSeen: true,
  };
}

/** Why a saved search cannot run unattended, or ''. */
export function cannotSchedule(config) {
  if (!config) return 'Set up a search first, then turn this on.';
  if (config.useCurrentTab) return 'A search that reads the tab you are on cannot run on its own. Untick “Use the tab I’m on” first.';
  if (!String(config.category || '').trim() && !String(config.batch || '').trim()) return 'Type what to search for first.';
  return '';
}

/** "Weekdays at 08:30 — dentists, Chennai (Google Maps)". */
export function describeSchedule(schedule) {
  if (!schedule || !schedule.enabled || !schedule.config) return '';
  const c = schedule.config;
  const what = c.batch ? `${c.batch.split('\n').filter(Boolean).length} searches` : [c.category, c.city].filter(Boolean).join(', ');
  const where = { maps: 'Google Maps', linkedin: 'LinkedIn', web: 'Public web', posts: 'Posts' }[c.source] || c.source;
  return `${schedule.days === 'weekdays' ? 'Weekdays' : 'Every day'} at ${schedule.time} — ${what} (${where})`;
}
