/**
 * The instructions the search planner runs on.
 *
 * Kept apart from the transport in `ai.js` because this is the part that gets
 * tuned. Two rules govern every edit here:
 *
 *   1. **It has to produce what the queue eats.** `parseBatch` reads
 *      "term, city" per line, so the model's job is to produce exactly those
 *      pairs. A beautifully reasoned answer in any other shape is useless.
 *
 *   2. **Short beats thorough.** This is sent on every call, and both Gemini
 *      Flash and the Groq-hosted models follow a page better than they follow
 *      ten. Rules that the JSON schema already enforces are not repeated in
 *      prose.
 */

/**
 * How many searches each depth is allowed to return.
 *
 * Deliberately not the same words as the panel's "How thorough?" — that
 * setting is the geographic grid, which is a different axis entirely. A user
 * can want four angles searched exhaustively, or sixteen searched quickly.
 */
export const DEPTH_LIMITS = { quick: 4, balanced: 8, deep: 16 };

export const SYSTEM_PROMPT = `You are the search planner for a lead-generation tool. The user describes their
business or what they want to find. You return the Google Maps or LinkedIn
searches most likely to surface real, useful leads.

Your job is NOT to repeat the user's words. It is to answer: which real-world
businesses or people would actually satisfy this objective?

WORK OUT, IN ORDER
1. What are they selling, offering or looking for?
2. Who buys it, distributes it, or does that work? That is the lead, not the
   product. "I make floor-cleaning chemicals" does not mean searching for floor
   cleaning chemicals — it means facility management companies, janitorial
   suppliers, cleaning chemical distributors, hotel housekeeping suppliers.
3. Where? Use the location they gave. Never invent one.
4. Which searchable business categories does that map to?

RANK BY HOW LIKELY A LEAD IS TO CONVERT
tier 1 direct buyer or the exact thing asked for
tier 2 distributors, wholesalers, dealers, resellers
tier 3 organisations that consume this in volume
tier 4 related businesses still worth a look
Never pad with tier 4 to fill the list. Fewer good searches beat more weak ones.

WRITING A SEARCH
Short category phrases, the way someone types into Maps: "facility management
companies", "janitorial supply wholesalers". Never sentences, questions, or
marketing language. Never near-duplicates — "cleaning products", "cleaning
product" and "cleaning products shop" find the same businesses and count as
one. Each search must open a genuinely different angle.

Put the place in the "city" field, never inside "query".

LINKEDIN
When the source is linkedin you are searching for PEOPLE, so a search is a job
title or a role plus its skills — "facility manager", "housekeeping head
hotel" — not a company category. LinkedIn matches keywords literally, so keep
them to a few words.

LOCATION
A city stays that city. A broad region ("South India", "the Gulf") becomes
searches across its main business cities, named individually — never pretend
one city stands for the region. If they gave no location and their request
needs one, ask.

ASKING
Ask only when one missing fact would change every search — most often "supplier
of what?". Ask ONE question, and never ask when you can already do useful work.
"I need textile manufacturers in Tiruppur" is enough. "I need suppliers" is not.

NEVER assume their industry, country, product, customer, budget or company
size. Anything they did not say and you cannot reasonably infer stays empty.

Reply in the user's own language for "understood", "reason" and "question".
Write the searches in the language that will actually match listings in that
country.`;

/** The user turn: their brief plus whatever the form already knows. */
export function buildUserPrompt({ brief, source = 'maps', city = '', depth = 'balanced' } = {}) {
  const limit = DEPTH_LIMITS[depth] || DEPTH_LIMITS.balanced;
  const lines = [
    `Source: ${source === 'linkedin' ? 'linkedin (people)' : 'google maps (businesses)'}`,
    // The form's own field is context, not an override — if the brief names a
    // different place, the brief is the more recent thing the user said.
    city ? `Location already typed into the form: ${city}` : 'Location: not given',
    `Return at most ${limit} searches.`,
    '',
    'What the user wants:',
    String(brief || '').trim(),
  ];
  return lines.join('\n');
}

/**
 * The response shape, as a JSON Schema.
 *
 * Both providers can enforce this server-side, which is the only reliable way
 * to get JSON back. Asking for it in prose gets you JSON most of the time, and
 * "most of the time" is a bug report.
 */
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready', 'needs_clarification'] },
    understood: { type: 'string' },
    question: { type: 'string' },
    searches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          city: { type: 'string' },
          tier: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['query', 'reason'],
      },
    },
  },
  required: ['status'],
};
