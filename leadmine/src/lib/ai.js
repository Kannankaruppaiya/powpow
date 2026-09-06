/**
 * The search planner's transport.
 *
 * The user describes their business in their own words; this turns that into
 * the concrete searches the queue runs. Two providers are supported because
 * they fail differently — Gemini's free tier has a daily cap, Groq's has a
 * per-minute one — and having the other to switch to is worth the small amount
 * of code that costs.
 *
 * Three things are deliberate here:
 *
 *   1. **The key never leaves the browser.** It lives in chrome.storage.local,
 *      goes out in a request header, and is kept out of `readConfig()` so it
 *      cannot reach the service worker, a saved job, or an exported file. It
 *      is never put in a URL — query strings end up in logs and history.
 *
 *   2. **JSON is enforced by the API, not requested in prose.** Gemini gets a
 *      responseSchema, Groq gets JSON mode. Asking politely for JSON works
 *      most of the time, and "most of the time" is a bug report.
 *
 *   3. **The model's output is untrusted input.** Everything that comes back
 *      is re-checked here: shape, length, duplicates, count. A planner that
 *      returns forty near-identical searches would quietly turn a five-minute
 *      run into an hour.
 */

import { SYSTEM_PROMPT, RESPONSE_SCHEMA, DEPTH_LIMITS, buildUserPrompt } from './plan-prompt.js';

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'Starts with AIza',

    request(model, key, system, user) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:generateContent`,
        // A header, not ?key= — a URL carrying a secret gets logged by
        // everything it passes through.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: {
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        },
      };
    },

    text(json) {
      const parts = ((json.candidates || [])[0] || {}).content || {};
      return (parts.parts || []).map((p) => p.text || '').join('');
    },
  },

  groq: {
    id: 'groq',
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'Starts with gsk_',

    request(model, key, system, user) {
      return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: {
          model,
          temperature: 0.3,
          // JSON mode here is shape-only, so the schema has to be described in
          // the prompt as well; Gemini enforces it server-side and does not.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${system}\n\n${SCHEMA_HINT}` },
            { role: 'user', content: user },
          ],
        },
      };
    },

    text(json) {
      return (((json.choices || [])[0] || {}).message || {}).content || '';
    },
  },
};

const SCHEMA_HINT = `Reply with JSON only, in this exact shape:
{"status":"ready","understood":"one short sentence back to them",
 "searches":[{"query":"facility management companies","city":"Chennai","tier":1,
              "reason":"why this finds real leads"}]}
If one missing fact would change every search:
{"status":"needs_clarification","question":"the single question"}`;

export const DEFAULT_PROVIDER = 'gemini';

export function providerFor(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

/* --------------------------------------------------------------- helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull the JSON object out of whatever came back.
 *
 * JSON mode makes this the common path, not the only one: a model can still
 * wrap the object in a ```json fence or add a sentence before it, and losing a
 * good plan to a stray backtick is a bad trade.
 */
export function parseJsonish(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced ? fenced[1] : null, raw].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Fall through to the widest brace pair, which survives a preamble.
      const start = candidate.indexOf('{');
      const end = candidate.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(candidate.slice(start, end + 1));
        } catch {
          /* try the next candidate */
        }
      }
    }
  }
  return null;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'in', 'near', 'me', 'for', 'and', 'of', 'my']);

/**
 * A key that collapses searches which would find the same businesses.
 *
 * "cleaning products", "Cleaning Product" and "products cleaning" are one
 * search wearing three hats; running all three triples the time for nothing.
 * Words are singularised and sorted, so word order and plurals stop mattering.
 */
export function searchKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .sort()
    .join(' ');
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Re-check the model's answer before anyone acts on it.
 *
 * Everything past this point is treated as data the user typed, so this is
 * where a hallucinated forty-item plan or an empty "ready" gets caught.
 */
export function normalisePlan(raw, { depth = 'balanced', city = '' } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('The planner did not return a usable answer. Try again.');
  }

  const question = clip(raw.question, 300);
  if (raw.status === 'needs_clarification' || (!raw.searches && question)) {
    if (!question) throw new Error('The planner asked for more detail but did not say what.');
    return { status: 'needs_clarification', question, understood: clip(raw.understood, 300), searches: [] };
  }

  const limit = DEPTH_LIMITS[depth] || DEPTH_LIMITS.balanced;
  const seen = new Set();
  const searches = [];

  for (const item of Array.isArray(raw.searches) ? raw.searches : []) {
    const query = clip(item && item.query, 80);
    if (!query) continue;
    // The city is part of the identity: the same category in two cities is two
    // searches, not a duplicate.
    const where = clip((item && item.city) || city, 80);
    const key = `${searchKey(query)}|${searchKey(where)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const tier = Number(item && item.tier);
    searches.push({
      query,
      city: where,
      tier: tier >= 1 && tier <= 4 ? Math.round(tier) : 4,
      reason: clip(item && item.reason, 200),
    });
  }

  if (!searches.length) {
    throw new Error('The planner came back with no searches. Try describing the goal differently.');
  }

  // Highest-intent first, so a truncated list keeps the best of it.
  searches.sort((a, b) => a.tier - b.tier);

  return {
    status: 'ready',
    understood: clip(raw.understood, 300),
    question: '',
    searches: searches.slice(0, limit),
  };
}

/** The batch box's format: one "term, city" per line. */
export function planToBatch(searches) {
  return searches
    .map((s) => (s.city ? `${s.query}, ${s.city}` : s.query))
    .join('\n');
}

/* ------------------------------------------------------------ the request */

/** What went wrong, in words that say what to do about it. */
function httpError(status, body) {
  if (status === 400 && /api key not valid/i.test(body)) {
    return new Error('That API key was rejected. Check it in More options.');
  }
  if (status === 401 || status === 403) {
    return new Error('That API key was rejected. Check it in More options.');
  }
  if (status === 404) {
    return new Error('That model name does not exist for this provider. Check it in More options.');
  }
  if (status === 429) {
    return new Error('The provider is rate-limiting this key. Wait a minute, or switch provider.');
  }
  if (status >= 500) return new Error('The provider is having trouble. Try again in a moment.');
  // The body can echo the request, so it is truncated rather than shown whole.
  return new Error(`The planner failed (HTTP ${status}). ${clip(body, 160)}`);
}

/**
 * Plan the searches for a brief.
 *
 * `fetchImpl` and `sleepImpl` are injectable so the tests can drive every
 * failure path without a network or an API key.
 */
export async function planSearches({
  brief,
  source = 'maps',
  city = '',
  depth = 'balanced',
  provider = DEFAULT_PROVIDER,
  apiKey = '',
  model = '',
  timeout = 30000,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  sleepImpl = sleep,
} = {}) {
  const text = String(brief || '').trim();
  if (!text) throw new Error('Describe what you are looking for first.');
  if (!String(apiKey).trim()) {
    throw new Error('Add an API key in More options to use the planner.');
  }
  if (!fetchImpl) throw new Error('This browser cannot reach the planner.');

  const conf = providerFor(provider);
  const req = conf.request(
    String(model).trim() || conf.defaultModel,
    String(apiKey).trim(),
    SYSTEM_PROMPT,
    buildUserPrompt({ brief: text, source, city, depth })
  );

  let lastError = null;
  // One retry only. A second failure is a real one, and the user is waiting.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt) await sleepImpl(1500);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

    let response;
    try {
      response = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (err) {
      lastError =
        err && err.name === 'AbortError'
          ? new Error('The planner took too long. Try again.')
          : new Error('Could not reach the planner. Check your connection.');
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      lastError = httpError(response.status, body);
      // Only a transient status is worth a second attempt; a rejected key
      // will be rejected just as fast the second time.
      if (response.status === 429 || response.status >= 500) continue;
      throw lastError;
    }

    const json = await response.json().catch(() => null);
    const plan = parseJsonish(conf.text(json || {}));
    if (!plan) {
      lastError = new Error('The planner returned something unreadable. Try again.');
      continue;
    }
    return normalisePlan(plan, { depth, city });
  }

  throw lastError || new Error('The planner failed.');
}
