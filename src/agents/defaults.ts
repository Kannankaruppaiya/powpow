// Defaults for agent metadata when upstream does not supply them.
// Model uses Groq's free API with Llama 3.1 8B.
export const DEFAULT_PROVIDER = "groq";
export const DEFAULT_MODEL = "llama-3.1-8b-instant";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 8192;
