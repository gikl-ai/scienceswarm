/**
 * Shared Ollama constants.
 *
 * Single source of truth so the server-side probe in
 * `/api/setup/status` and the client-side OllamaSection component
 * cannot drift on which local model the setup flow nudges users
 * toward.
 */

/** Single source of truth for the recommended local model. */
export const OLLAMA_RECOMMENDED_MODEL = "gemma4:e4b";
export const OLLAMA_LOW_MEMORY_MODEL = "gemma4:e2b";
export const OLLAMA_RECOMMENDED_MODEL_ALIASES = [
  OLLAMA_RECOMMENDED_MODEL,
  "gemma4",
  "gemma4:latest",
];

export interface OllamaLocalModelOption {
  value: string;
  label: string;
  description: string;
}

/** First-class local model choices exposed in Settings. */
export const OLLAMA_LOCAL_MODEL_OPTIONS: OllamaLocalModelOption[] = [
  {
    value: OLLAMA_RECOMMENDED_MODEL,
    label: "gemma4:e4b (recommended)",
    description: "Default Gemma 4 edge model for local chat and execution.",
  },
  {
    value: OLLAMA_LOW_MEMORY_MODEL,
    label: "gemma4:e2b",
    description: "Smaller Gemma 4 edge model for low-memory machines.",
  },
  {
    value: "gemma4:26b",
    label: "gemma4:26b",
    description: "Larger local Gemma option for high-memory laptops.",
  },
];
