/**
 * Canonical port + URL configuration for ScienceSwarm services.
 *
 * This module is pure TypeScript with no `node:` imports so it is safe to
 * consume from both server and client code. Reads are lazy via accessor
 * functions so environment overrides applied at runtime (e.g. in tests via
 * `vi.stubEnv`) are honored on every call.
 */

/**
 * Literal default ports for every ScienceSwarm-managed service.
 *
 * These values are the single source of truth for what "no configuration"
 * looks like. The `as const` assertion keeps the numeric types narrow so
 * callers can rely on the literal values at compile time.
 */
export const DEFAULT_PORTS = {
  frontend: 3001,
  openhands: 3000,
  openclaw: 18789,
  nanoclaw: 3002,
  ollama: 11434,
} as const;

/**
 * Attempt to parse a TCP port (1-65535). Returns `undefined` for missing,
 * non-numeric, or out-of-range values so callers can cascade through a
 * precedence chain (e.g. FRONTEND_PORT → PORT → default) without having
 * an invalid earlier var short-circuit to the final fallback.
 *
 * Strict: rejects inputs like `"3000abc"`, `"0"`, `"65536"`, `"-1"`, `"3.14"`
 * and other non-canonical forms that `Number.parseInt` would silently accept.
 */
function tryParsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n >= 1 && n <= 65535 ? n : undefined;
}

/**
 * Parse an environment value as a valid TCP port, or return `fallback`
 * if the value is missing, not a pure digit string, or out of range.
 */
function parsePort(value: string | undefined, fallback: number): number {
  return tryParsePort(value) ?? fallback;
}

/**
 * Read an env var, treating empty strings as unset.
 *
 * POSIX leaves an empty-string env var technically "set", but for
 * configuration purposes we want the same fallback behavior as if it were
 * missing entirely. This also matches how `vi.stubEnv(name, "")` is used in
 * tests to clear a value.
 */
function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Frontend Next.js server port.
 *
 * Precedence: `FRONTEND_PORT` > `PORT` > `DEFAULT_PORTS.frontend`.
 * The project-specific var wins over the generic Node.js convention so
 * users who already have `PORT` set globally for something else can still
 * override just this service via `FRONTEND_PORT`.
 *
 * Each var is validated independently — an invalid `FRONTEND_PORT` falls
 * through to `PORT` rather than short-circuiting to the default.
 */
export function getFrontendPort(): number {
  return (
    tryParsePort(readEnv("FRONTEND_PORT")) ??
    tryParsePort(readEnv("PORT")) ??
    DEFAULT_PORTS.frontend
  );
}

/** Public frontend URL. `APP_ORIGIN` wins over port-derived localhost URLs. */
export function getFrontendUrl(): string {
  return readEnv("APP_ORIGIN") ?? `http://localhost:${getFrontendPort()}`;
}

/** OpenHands server port. */
export function getOpenHandsPort(): number {
  return parsePort(readEnv("OPENHANDS_PORT"), DEFAULT_PORTS.openhands);
}

/** OpenHands base URL. `OPENHANDS_URL` wins over port derivation. */
export function getOpenHandsUrl(): string {
  return readEnv("OPENHANDS_URL") ?? `http://localhost:${getOpenHandsPort()}`;
}

/**
 * OpenClaw gateway port. Honors `OPENCLAW_PORT` env override, falls back
 * to `DEFAULT_PORTS.openclaw` (18789). This default is one of three drift
 * points — `start.sh` and `tests/integration/port-drift.test.ts` must
 * agree. See `src/lib/openclaw/runner.ts` for the env-var isolation
 * wrapper that forwards this port to the spawned process.
 */
export function getOpenClawPort(): number {
  return parsePort(readEnv("OPENCLAW_PORT"), DEFAULT_PORTS.openclaw);
}

/**
 * OpenClaw gateway websocket URL.
 *
 * `OPENCLAW_URL` wins over port derivation; otherwise the port is taken from
 * `OPENCLAW_PORT` with a fallback to the literal default.
 */
export function getOpenClawGatewayUrl(): string {
  return (
    readEnv("OPENCLAW_URL") ?? `ws://127.0.0.1:${getOpenClawPort()}/ws`
  );
}

/** NanoClaw service base URL. `NANOCLAW_URL` wins over `NANOCLAW_PORT`. */
export function getNanoClawUrl(): string {
  const url = readEnv("NANOCLAW_URL");
  if (url) return url;
  const port = parsePort(readEnv("NANOCLAW_PORT"), DEFAULT_PORTS.nanoclaw);
  return `http://localhost:${port}`;
}

/** Ollama service port. Honors `OLLAMA_PORT`. */
export function getOllamaPort(): number {
  return parsePort(readEnv("OLLAMA_PORT"), DEFAULT_PORTS.ollama);
}

/**
 * Ollama service base URL.
 *
 * `OLLAMA_URL` wins over port derivation; otherwise the port is taken from
 * `OLLAMA_PORT` with a fallback to the literal default.
 */
export function getOllamaUrl(): string {
  return readEnv("OLLAMA_URL") ?? `http://localhost:${getOllamaPort()}`;
}
