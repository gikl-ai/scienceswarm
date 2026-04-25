import { isPlaceholderValue } from "@/lib/setup/placeholder-detection";

const SCIENCESWARM_CLOUD_ORIGIN = "https://scienceswarm.ai";
const SCIENCESWARM_CLOUD_API_BASE_URL = `${SCIENCESWARM_CLOUD_ORIGIN}/api/v1`;
const SCIENCESWARM_CLERK_PUBLISHABLE_KEY =
  "pk_live_Y2xlcmsuc2NpZW5jZXN3YXJtLmFpJA";
const SCIENCESWARM_SIGN_IN_URL = `${SCIENCESWARM_CLOUD_ORIGIN}/sign-in`;
const SCIENCESWARM_LOCAL_AUTH_BRIDGE_URL =
  `${SCIENCESWARM_CLOUD_ORIGIN}/auth/local-bridge`;

export const SCIENCESWARM_LOCAL_AUTH_TOKEN_MESSAGE_TYPE =
  "scienceswarm.local-auth.success";
export const SCIENCESWARM_LOCAL_AUTH_ERROR_MESSAGE_TYPE =
  "scienceswarm.local-auth.error";

export const SCIENCESWARM_CRITIQUE_SIGN_IN_REQUIRED_MESSAGE =
  "Create a free account at scienceswarm.ai and sign in to use the Cloud Reasoning API.";
export const SCIENCESWARM_CRITIQUE_SESSION_EXPIRED_MESSAGE =
  "Your ScienceSwarm session expired. Sign in again to continue using the Cloud Reasoning API.";
export const SCIENCESWARM_CRITIQUE_CLOUD_DISCLAIMER =
  "Cloud Reasoning sends your PDF or pasted text to ScienceSwarm's cloud API. It does not run on the local model.";
export const SCIENCESWARM_CRITIQUE_FRONTIER_MODELS_DISCLAIMER =
  "Cloud Reasoning uses ScienceSwarm-selected frontier models from Google, Anthropic, and OpenAI. During the beta period, ScienceSwarm is covering that access for free.";

function readConfiguredOverride(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (isPlaceholderValue(value).isPlaceholder) return null;
  return value;
}

export function getScienceSwarmCloudOrigin(): string {
  return SCIENCESWARM_CLOUD_ORIGIN;
}

export function getScienceSwarmSignInUrl(): string {
  return SCIENCESWARM_SIGN_IN_URL;
}

export function getScienceSwarmLocalAuthBridgeUrl(): string {
  return SCIENCESWARM_LOCAL_AUTH_BRIDGE_URL;
}

export function getScienceSwarmStructuredCritiqueBaseUrl(): string {
  return (
    readConfiguredOverride("STRUCTURED_CRITIQUE_SERVICE_URL") ||
    SCIENCESWARM_CLOUD_API_BASE_URL
  );
}

export function getScienceSwarmClerkPublishableKey(): string {
  return (
    readConfiguredOverride("NEXT_PUBLIC_SCIENCESWARM_CLERK_PUBLISHABLE_KEY") ||
    SCIENCESWARM_CLERK_PUBLISHABLE_KEY
  );
}

export function isBuiltInScienceSwarmCritiqueUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "") === SCIENCESWARM_CLOUD_API_BASE_URL;
}

export function isScienceSwarmHostedOrigin(origin: string): boolean {
  return origin.replace(/\/+$/, "") === SCIENCESWARM_CLOUD_ORIGIN;
}

export function isSupportedScienceSwarmLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function normalizeSupportedScienceSwarmLocalOrigin(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !isSupportedScienceSwarmLocalOrigin(trimmed)) {
    return null;
  }

  return new URL(trimmed).origin;
}

export function getScienceSwarmLocalRequestOrigin(request: Request): string {
  const originHeader = normalizeSupportedScienceSwarmLocalOrigin(
    request.headers.get("origin"),
  );
  if (originHeader) {
    return originHeader;
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
  const host = forwardedHost || request.headers.get("host")?.trim();
  if (host) {
    const protocol =
      request.headers.get("x-forwarded-proto")?.trim() ||
      new URL(request.url).protocol.replace(/:$/, "");
    const hostOrigin = normalizeSupportedScienceSwarmLocalOrigin(
      `${protocol}://${host}`,
    );
    if (hostOrigin) {
      return hostOrigin;
    }
  }

  const refererOrigin = (() => {
    const referer = request.headers.get("referer")?.trim();
    if (!referer) return null;
    try {
      return normalizeSupportedScienceSwarmLocalOrigin(
        new URL(referer).origin,
      );
    } catch {
      return null;
    }
  })();
  if (refererOrigin) {
    return refererOrigin;
  }

  return new URL(request.url).origin;
}

export function getStructuredCritiqueAuthMessage(
  hasSession: boolean,
): string {
  return hasSession
    ? SCIENCESWARM_CRITIQUE_SESSION_EXPIRED_MESSAGE
    : SCIENCESWARM_CRITIQUE_SIGN_IN_REQUIRED_MESSAGE;
}
