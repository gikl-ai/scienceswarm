import type { RuntimeAuthProvider } from "../contracts";

const SUBSCRIPTION_NATIVE_API_ENV_KEYS: Partial<
  Record<RuntimeAuthProvider, string[]>
> = {
  anthropic: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
  ],
  openai: [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
  ],
  "google-ai": [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
  ],
};

export function buildSubscriptionNativeCliEnv(
  provider: RuntimeAuthProvider,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of SUBSCRIPTION_NATIVE_API_ENV_KEYS[provider] ?? []) {
    delete env[key];
  }
  return env;
}
