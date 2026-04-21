/**
 * Shared Ollama constants.
 *
 * Single source of truth so the server-side probe in
 * `/api/setup/status` and the client-side OllamaSection component
 * cannot drift on which local model the setup flow nudges users
 * toward.
 */

/** Single source of truth for the recommended local model. */
export const OLLAMA_RECOMMENDED_MODEL = "gemma4";

export interface OllamaLocalModelOption {
  value: string;
  label: string;
  description: string;
}

/** First-class local model choices exposed in Settings. */
export const OLLAMA_LOCAL_MODEL_OPTIONS: OllamaLocalModelOption[] = [
  {
    value: "gemma4",
    label: "gemma4 (recommended)",
    description: "Default local Gemma path.",
  },
  {
    value: "gemma4:26b",
    label: "gemma4:26b",
    description: "Larger local Gemma option for high-memory laptops.",
  },
];
