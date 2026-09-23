/**
 * The search planner's transport.
 *
 * The user describes their business in their own words; this turns that into
 * the concrete searches the queue runs. Two providers are supported because
 * they fail differently — Gemini's free tier has a daily cap, Groq's has a
 * per-minute one — and having the other to switch to is worth the small amount
 * of code that costs.
 *
 * Everything here is written against the providers' own machine-readable
 * specs rather than from memory, because guessing at this cost several rounds
 * of "unexpected model name format":
 *
 *   - Gemini: the v1beta discovery document
 *     (generativelanguage.googleapis.com/$discovery/rest?version=v1beta), which
 *     is the authority on field names, the Schema dialect and the enums.
 *   - Groq: their own TypeScript SDK, which is generated from their OpenAPI
 *     spec (github.com/groq/groq-typescript).
 *
 * Four things are deliberate:
 *
 *   1. **The key never leaves the browser.** It lives in chrome.storage.local,
 *      goes out in a request header, and is kept out of `readConfig()` so it
 *      cannot reach the service worker, a saved job, or an exported file. It
 *      is never put in a URL — query strings end up in logs and history.
 *
 *   2. **Model names are never guessed.** Both providers list their own
 *      models; the panel offers that list. Every model failure so far came
 *      from a name typed or remembered rather than read from the provider.
 *
 *   3. **JSON is enforced by the API, not requested in prose.** Gemini gets a
 *      responseSchema in *its* dialect (uppercase type enums — an OpenAPI
 *      subset, not JSON Schema); Groq gets JSON mode plus the shape in the
 *      prompt, since its endpoint takes standard JSON Schema only on some
 *      models.
 *
 *   4. **The model's output is untrusted input.** Everything that comes back
 *      is re-checked here: shape, length, duplicates, count. A planner that
 *      returns forty near-identical searches would quietly turn a five-minute
 *      run into an hour.
 */

import { SYSTEM_PROMPT, RESPONSE_SCHEMA, DEPTH_LIMITS, buildUserPrompt } from './plan-prompt.js';

/**
 * Gemini's `Schema` is an OpenAPI 3.0 subset, not JSON Schema: `type` is an
 * uppercase enum, and a list of allowed values needs `format: "enum"` on a
 * STRING. Sending lowercase `"object"` is rejected. The schema is written once
 * as ordinary JSON Schema and converted here, so Groq and the prompt can keep
 * using the standard form.
 */
const GEMINI_TYPES = {
  string: 'STRING', number: 'NUMBER', integer: 'INTEGER',
  boolean: 'BOOLEAN', array: 'ARRAY', object: 'OBJECT', null: 'NULL',
};

export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  if (schema.type) out.type = GEMINI_TYPES[schema.type] || String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) {
    // An enum is only valid on a STRING, and only with format "enum".
    out.type = 'STRING';
    out.format = 'enum';
    out.enum = schema.enum.map(String);
  }
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(value);
    }
    // Field order is part of the contract: it is the order the model fills
    // them in, and "status" before "searches" is what makes a refusal cheap.
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (Array.isArray(schema.required)) out.required = [...schema.required];
  return out;
}

const GEMINI_SCHEMA = toGeminiSchema(RESPONSE_SCHEMA);

/** Why a candidate came back with no text. The enum is from the spec. */
const GEMINI_STOPPED = {
  MAX_TOKENS: 'The planner ran out of room before it finished. Try a shorter description.',
  SAFETY: 'Gemini declined to answer this one. Try describing the business differently.',
  PROHIBITED_CONTENT: 'Gemini declined to answer this one. Try describing the business differently.',
  BLOCKLIST: 'Gemini declined to answer this one. Try describing the business differently.',
  SPII: 'Gemini declined to answer this one — it read the description as personal data.',
  RECITATION: 'Gemini stopped itself repeating source material. Try rewording the description.',
  MALFORMED_RESPONSE: 'The planner returned something unreadable. Try again.',
};

export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    // AI Studio has issued both shapes; a key of either is a Gemini key.
    keyHint: 'starts with AIza or AQ.',
    keyLooks: /^(AIza|AQ\.)/,

    /** GET v1beta/models — the provider's own list, so nothing is guessed. */
    modelsRequest(key) {
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
        headers: { 'x-goog-api-key': key },
      };
    },

    parseModels(json) {
      return (json.models || [])
        // Only models that can answer this call at all. The list also carries
        // embedding and legacy text models, which cannot.
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({
          // Names come back as "models/gemini-2.5-flash"; the URL adds that.
          id: String(m.name || '').replace(/^models\//, ''),
          label: m.displayName || String(m.name || '').replace(/^models\//, ''),
        }))
        .filter((m) => m.id);
    },

    request(model, key, system, user) {
      return {
        // The path parameter is `models/{model}` and the spec constrains it to
        // ^models/[^/]+$ — a name with a slash in it is the "unexpected model
        // name format" error, not a missing model.
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          model
        )}:generateContent`,
        // A header, not ?key= — a URL carrying a secret gets logged by
        // everything it passes through.
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: {
          // camelCase is the canonical JSON name in the discovery document.
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
          },
        },
      };
    },

    /**
     * The answer, or why there isn't one.
     *
     * A blocked or truncated response is a well-formed 200 with no text in it.
     * Reading only `candidates[0].content.parts` turns every one of those into
     * "returned something unreadable", which sends the user looking in the
     * wrong place.
     */
    read(json) {
      const blocked = (json.promptFeedback || {}).blockReason;
      if (blocked) {
        return { error: GEMINI_STOPPED[blocked] || `Gemini blocked the request (${blocked}).` };
      }
      const candidate = (json.candidates || [])[0];
      if (!candidate) return { error: 'Gemini returned no answer at all. Try again.' };

      const text = ((candidate.content || {}).parts || []).map((p) => p.text || '').join('');
      if (text.trim()) return { text };

      const reason = candidate.finishReason || '';
      return {
        error:
          GEMINI_STOPPED[reason] ||
          `Gemini returned an empty answer${reason ? ` (${reason})` : ''}. Try again.`,
      };
    },
  },

  groq: {
    id: 'groq',
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'starts with gsk_',
    keyLooks: /^gsk_/,

    modelsRequest(key) {
      return {
        url: 'https://api.groq.com/openai/v1/models',
        headers: { authorization: `Bearer ${key}` },
      };
    },

    parseModels(json) {
      return (json.data || [])
        .map((m) => ({ id: String(m.id || ''), label: String(m.id || '') }))
        // Groq's model list carries no capability field — their own SDK types
        // it as id/created/object/owned_by and nothing else — so the id is the
        // only signal for which of these can hold a conversation at all.
        .filter((m) => m.id && !/whisper|tts|guard|^distil/i.test(m.id));
    },

    request(model, key, system, user) {
      return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: {
          model,
          temperature: 0.3,
          // json_object, not json_schema: the schema form is only accepted on
          // some of Groq's models, and a planner that fails on the model the
          // user picked is worse than one that states the shape in the prompt.
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: `${system}\n\n${SCHEMA_HINT}` },
            { role: 'user', content: user },
          ],
        },
      };
    },

    read(json) {
      const choice = (json.choices || [])[0];
      if (!choice) return { error: 'Groq returned no answer at all. Try again.' };
      const text = (choice.message || {}).content || '';
      if (text.trim()) return { text };
      return {
        error:
          choice.finish_reason === 'length'
            ? 'The planner ran out of room before it finished. Try a shorter description.'
            : `Groq returned an empty answer${choice.finish_reason ? ` (${choice.finish_reason})` : ''}. Try again.`,
      };
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
 * The model id to actually send.
 *
 * A model box sitting under a key box collects things that are not model
 * names. Rather than pass whatever is in it to the API and relay
 * "unexpected model name format" back, anything that cannot be a model id is
 * ignored and the provider's default is used — which is what the user wanted
 * from a box they never meant to fill.
 */
export function cleanModel(name, fallback) {
  const value = String(name || '')
    .trim()
    // "models/gemini-2.5-flash" is how the docs write it; the path adds its own.
    .replace(/^models\//, '');
  if (!value || value.length > 80) return fallback;
  // An API key pasted into the model box is the case this exists for, and it
  // is the one thing no model id can be.
  if (wrongProviderFor(value)) return fallback;
  // Model ids are one token: letters, digits and separators. Groq namespaces
  // some of its own with a slash, so that is allowed too.
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ? value : fallback;
}

/**
 * A key that plainly belongs to the other provider.
 *
 * Both keys are opaque strings in a password box, so pasting one under the
 * wrong provider is easy and the API's own answer for it ("invalid argument")
 * says nothing about the actual mistake.
 */
export function wrongProviderFor(key) {
  const value = String(key || '').trim();
  for (const conf of Object.values(PROVIDERS)) {
    if (conf.keyLooks.test(value)) return conf;
  }
  return null;
}

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
function httpError(status, body, model) {
  if (status === 400 && /api key not valid/i.test(body)) {
    return new Error('That API key was rejected. Check it in More options.');
  }
  if (status === 401 || status === 403) {
    return new Error('That API key was rejected. Check it in More options.');
  }
  if (model && (status === 404 || /model/i.test(body))) {
    return new Error(
      `The provider rejected the model "${model}". Pick another under More options.`
    );
  }
  if (status === 404) return new Error('That endpoint was not found for this provider.');
  if (status === 429) {
    return new Error('The provider is rate-limiting this key. Wait a minute, or switch provider.');
  }
  if (status >= 500) return new Error('The provider is having trouble. Try again in a moment.');
  // The body can echo the request, so it is truncated rather than shown whole.
  return new Error(`The planner failed (HTTP ${status}). ${clip(body, 160)}`);
}

/**
 * The models this key can actually use, straight from the provider.
 *
 * This exists so that no model name is ever typed or remembered. Every model
 * failure in this feature so far came from a name that was not read from the
 * provider's own list.
 */
export async function listModels({
  provider = DEFAULT_PROVIDER,
  apiKey = '',
  timeout = 20000,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
} = {}) {
  const key = String(apiKey).trim();
  if (!key) throw new Error('Add an API key first.');
  if (!fetchImpl) throw new Error('This browser cannot reach the planner.');

  const conf = providerFor(provider);
  const wrong = wrongProviderFor(key);
  if (wrong && wrong.id !== conf.id) throw mismatchError(wrong, conf);

  const req = conf.modelsRequest(key);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;

  let response;
  try {
    response = await fetchImpl(req.url, {
      method: 'GET',
      headers: req.headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (err) {
    throw err && err.name === 'AbortError'
      ? new Error('Listing models took too long. Try again.')
      : new Error('Could not reach the provider. Check your connection.');
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    throw httpError(response.status, await response.text().catch(() => ''), '');
  }

  const models = conf.parseModels((await response.json().catch(() => null)) || {});
  if (!models.length) throw new Error('The provider listed no usable models for this key.');
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function mismatchError(belongsTo, conf) {
  return new Error(
    `That looks like a ${belongsTo.label} key, but ${conf.label} is selected. Switch provider, or paste a ${conf.label} key.`
  );
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
  const key = String(apiKey).trim();

  const belongsTo = wrongProviderFor(key);
  if (belongsTo && belongsTo.id !== conf.id) throw mismatchError(belongsTo, conf);

  const wanted = cleanModel(model, conf.defaultModel);
  const req = conf.request(
    wanted,
    key,
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
      lastError = httpError(response.status, body, wanted);
      // Only a transient status is worth a second attempt; a rejected key
      // will be rejected just as fast the second time.
      if (response.status === 429 || response.status >= 500) continue;
      throw lastError;
    }

    const json = await response.json().catch(() => null);
    const { text, error } = conf.read(json || {});
    if (error) {
      // A refusal is the provider's final answer, not a hiccup — retrying it
      // just spends another request to be told the same thing.
      lastError = new Error(error);
      if (!/try again/i.test(error)) throw lastError;
      continue;
    }

    const plan = parseJsonish(text);
    if (!plan) {
      lastError = new Error('The planner returned something unreadable. Try again.');
      continue;
    }
    return normalisePlan(plan, { depth, city });
  }

  throw lastError || new Error('The planner failed.');
}
