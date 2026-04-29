// Shared constants for the /setup secret-redaction flow.
//
// This module is intentionally dependency-free — no `node:fs`, no
// env-writer imports, no validators — so it's safe to pull into the
// client component (`src/app/setup/page.tsx`). The server-side
// `config-status.ts` re-exports these same values so API routes and
// tests can keep importing from a single place.

/**
 * The only `.env` keys the Phase 1 `/setup` UI reads back for
 * pre-fill. Omitting unrelated keys from `GET /api/setup/status`
 * keeps the endpoint tightly scoped to the actual form and avoids
 * accidentally echoing future secrets just because they exist on
 * disk.
 */
export const SETUP_ENV_KEYS = [
  "OPENAI_API_KEY",
  "SCIENCESWARM_DIR",
  "SCIENCESWARM_USER_HANDLE",
  "BRAIN_ROOT",
  "BRAIN_PRESET",
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_ID",
  "GITHUB_SECRET",
  // Added in PR B stage B1 — the upcoming /setup UI sections
  // (brain profile, LLM provider toggle, OpenClaw/Ollama) need these
  // keys to round-trip through GET /api/setup/status for pre-fill.
  // None of them are secrets, so they stay out of SECRET_ENV_KEYS.
  "BRAIN_PROFILE_NAME",
  "BRAIN_PROFILE_FIELD",
  "BRAIN_PROFILE_INSTITUTION",
  "LLM_PROVIDER",
  "OLLAMA_MODEL",
  "AGENT_BACKEND",
] as const;

export type SetupEnvKey = (typeof SETUP_ENV_KEYS)[number];

/**
 * Keys that must never be echoed over the wire by the /setup status
 * endpoint. The server replaces each value with
 * `REDACTED_SECRET_SENTINEL` before serialising the response; the
 * client matches the sentinel to render a "currently set — leave
 * blank to keep" helper and to leave the input empty rather than
 * round-tripping the sentinel literal back to the server.
 *
 * Add a key here if `.env` can plausibly store its value and
 * that value would compromise something if exfiltrated.
 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set<string>([
  "OPENAI_API_KEY",
  "GITHUB_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "GBRAIN_OPENAI_KEY",
  "NEXTAUTH_SECRET",
  "OPENCLAW_INTERNAL_API_KEY",
  "OPENCLAW_TOKEN",
  "JIRA_API_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "STRUCTURED_CRITIQUE_SERVICE_TOKEN",
  "BRAVE_API_KEY",
  "DEEPGRAM_OWNER_API_KEY",
]);

/**
 * The exact value placed in `ConfigStatus.rawValues` when a secret
 * key is present with a non-empty value. The UI matches this sentinel
 * to render the "set — leave blank to keep" hint without needing to
 * know the real value. Any future change to this token must be
 * mirrored in `src/app/setup/page.tsx` so the hint keeps firing.
 */
export const REDACTED_SECRET_SENTINEL = "<configured>";
