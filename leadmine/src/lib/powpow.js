/** Hand a finished run to PowPow. */

export const HOOK_KEY = 'mls.powpow';

export const DEFAULT_HOOK = {
  enabled: false,
  url: 'http://127.0.0.1:18789/hooks/agent',
  token: '',
  channel: 'last',
  to: '',
  // Only scheduled runs by default: a run the user started by hand has the user right there, looking at the panel.
  when: 'scheduled',
  maxLeads: 15,
};

export const CHANNELS = ['last', 'telegram', 'whatsapp', 'slack', 'discord', 'signal', 'imessage', 'msteams'];

/** Stay well inside the gateway's 256 KB body cap, and inside what a model reads well. */
const MAX_MESSAGE = 12000;

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/** One lead as a line the agent can quote. Contact details included — that is the point. */
export function leadLine(record, note = {}) {
  const verdict = note.feedback === 'good' ? 'fit' : note.feedback === 'bad' ? 'not a fit' : note.verdict ? note.verdict.replace('_', ' ') : '';
  const head =
    record.source === 'posts'
      ? `${clip(record.author || record.name, 60)} (${record.ageDays !== '' && record.ageDays !== undefined ? `${record.ageDays}d ago` : 'recent'}): "${clip(record.text, 280)}"`
      : record.source === 'linkedin' || record.source === 'web'
        ? `${clip(record.name, 60)} — ${clip(record.headline, 120)}${record.location ? ` (${clip(record.location, 40)})` : ''}`
        : `${clip(record.name, 80)} — ${clip(record.category, 50)}${record.area || record.city ? `, ${clip(record.area || record.city, 40)}` : ''}${record.rating ? ` ★${record.rating}` : ''}`;
  const contact = [
    note.personEmail || record.email || String(record.emails || '').split(';')[0],
    record.phone || String(record.phones || '').split(';')[0],
    record.postUrl || record.profileUrl || record.website || record.mapsUrl,
  ]
    .map((v) => clip(v, 120))
    .filter(Boolean)
    .join(' · ');
  const why = note.reason ? ` — ${verdict}: ${clip(note.reason, 160)}` : verdict ? ` — ${verdict}` : '';
  return `- ${head}${why}${contact ? `\n  ${contact}` : ''}`;
}

/** The prompt the agent gets. */
export function buildHookMessage({ records, notes = new Map(), config = {}, job = {}, scheduled = false, maxLeads = 15 }) {
  const source = config.source || 'maps';
  const noun = { maps: 'businesses', linkedin: 'people', web: 'people', posts: 'posts' }[source] || 'leads';
  const search = [config.category, config.city].filter(Boolean).join(' in ') || (config.batch ? 'a batch of searches' : 'a search');
  const rank = { fit: 0, maybe: 1, '': 2, no_fit: 3 };
  const verdictOf = (r) => {
    const n = notes.get(r.key) || {};
    return n.feedback === 'good' ? 'fit' : n.feedback === 'bad' ? 'no_fit' : n.verdict || '';
  };
  const list = [...(records || [])]
    .filter((r) => verdictOf(r) !== 'no_fit')
    .sort((a, b) => (rank[verdictOf(a)] ?? 2) - (rank[verdictOf(b)] ?? 2));
  const shown = list.slice(0, maxLeads);

  const header =
    `LeadMine ${scheduled ? 'scheduled run' : 'run'} finished: ${list.length} ${noun} for ${search}` +
    (job.skippedSeen ? ` (${job.skippedSeen} already seen before were left out)` : '') +
    '.';
  const body = shown.length
    ? shown.map((r) => leadLine(r, notes.get(r.key) || {})).join('\n')
    : 'Nothing new this time.';
  const ask =
    'Please send the user a short summary of these leads: how many there are, the three most ' +
    'promising and why, and anything that looks urgent (a post asking for something this week). ' +
    'Keep contact details exactly as given. Do not contact any of these leads yourself.';

  let message = `${header}\n\n${body}${list.length > shown.length ? `\n…and ${list.length - shown.length} more in LeadMine.` : ''}\n\n${ask}`;
  if (message.length > MAX_MESSAGE) message = `${message.slice(0, MAX_MESSAGE - 200)}\n…(cut)\n\n${ask}`;
  return message;
}

/** The request body for /hooks/agent. */
export function hookPayload(settings, message) {
  const payload = { message, name: 'LeadMine', deliver: true, wakeMode: 'now' };
  if (settings.channel && settings.channel !== 'last') payload.channel = settings.channel;
  if (settings.to) payload.to = String(settings.to).trim();
  return payload;
}

/** Whether a run should be sent, given the settings. */
export function shouldSend(settings, { scheduled = false } = {}) {
  if (!settings || !settings.enabled || !settings.url || !settings.token) return false;
  return settings.when === 'always' || scheduled;
}

/** POST to the gateway. */
export async function sendToPowPow(settings, message, { fetchImpl = typeof fetch === 'function' ? fetch : null, timeout = 15000 } = {}) {
  if (!fetchImpl) return { ok: false, status: 0, error: 'No network in this context.' };
  let url;
  try {
    url = new URL(settings.url);
  } catch {
    return { ok: false, status: 0, error: 'The PowPow address is not a URL.' };
  }
  // A query-string token is refused by the gateway — and it would be logged.
  url.searchParams.delete('token');

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${String(settings.token).trim()}` },
      body: JSON.stringify(hookPayload(settings, message)),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (res.ok) return { ok: true, status: res.status, error: '' };
    const why = {
      400: 'PowPow rejected the message (400). Check the channel and recipient.',
      401: 'PowPow rejected the token (401). Check hooks.token in the gateway config.',
      404: 'Nothing at that address (404). Is hooks.enabled on, and is the path /hooks/agent?',
      413: 'The message was too large for the gateway (413).',
      429: 'The gateway is refusing for now after failed attempts (429). Check the token, then wait.',
    }[res.status];
    return { ok: false, status: res.status, error: why || `PowPow answered HTTP ${res.status}.` };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error:
        err && err.name === 'AbortError'
          ? 'PowPow took too long to answer.'
          : 'Could not reach PowPow. Is the gateway running at that address?',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
