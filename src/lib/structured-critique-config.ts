import { isPlaceholderValue } from "@/lib/setup/placeholder-detection";
import {
  getScienceSwarmStructuredCritiqueBaseUrl,
  isBuiltInScienceSwarmCritiqueUrl,
} from "@/lib/scienceswarm-auth";

const DEFAULT_CLIENT_LABEL = "scienceswarm";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export type StructuredCritiqueAuthMode = "user_session" | "service_token";

export type StructuredCritiqueConfig = {
  baseUrl: string;
  token: string | null;
  clientLabel: string;
  timeoutMs: number;
  authMode: StructuredCritiqueAuthMode;
};

export class StructuredCritiqueConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredCritiqueConfigError";
  }
}

function readConfiguredEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  if (isPlaceholderValue(value).isPlaceholder) return null;
  return value;
}

export function getStructuredCritiqueTimeoutMs(): number {
  const timeoutMs = Number(process.env.STRUCTURED_CRITIQUE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
}

function normalizeServiceBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new StructuredCritiqueConfigError(
      "Reasoning Audit live analysis override is invalid. `STRUCTURED_CRITIQUE_SERVICE_URL` must be a valid hosted critique URL ending in `/v1`.",
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new StructuredCritiqueConfigError(
      "Reasoning Audit live analysis override is invalid. `STRUCTURED_CRITIQUE_SERVICE_URL` must use http or https.",
    );
  }

  const normalized = baseUrl.replace(/\/+$/, "");
  if (!normalized.endsWith("/v1")) {
    throw new StructuredCritiqueConfigError(
      "Reasoning Audit live analysis override is invalid. `STRUCTURED_CRITIQUE_SERVICE_URL` must end in `/v1`.",
    );
  }

  return normalized;
}

export function getStructuredCritiqueConfigStatus(): {
  available: boolean;
  missingKeys: string[];
} {
  const baseUrl = getScienceSwarmStructuredCritiqueBaseUrl();
  const token = readConfiguredEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN");
  const normalizedBaseUrl = tryNormalizeServiceBaseUrl(baseUrl);

  if (!normalizedBaseUrl) {
    return {
      available: false,
      missingKeys: ["STRUCTURED_CRITIQUE_SERVICE_URL"],
    };
  }

  if (!isBuiltInScienceSwarmCritiqueUrl(normalizedBaseUrl) && !token) {
    return {
      available: false,
      missingKeys: ["STRUCTURED_CRITIQUE_SERVICE_TOKEN"],
    };
  }

  return {
    available: true,
    missingKeys: [],
  };
}

export function getStructuredCritiqueConfig(): StructuredCritiqueConfig {
  const baseUrl = getScienceSwarmStructuredCritiqueBaseUrl();
  const token = readConfiguredEnv("STRUCTURED_CRITIQUE_SERVICE_TOKEN");
  const normalizedBaseUrl = normalizeServiceBaseUrl(baseUrl);

  if (!isBuiltInScienceSwarmCritiqueUrl(normalizedBaseUrl) && !token) {
    throw new StructuredCritiqueConfigError(
      "Reasoning Audit external override is incomplete. Non-ScienceSwarm critique URLs require `STRUCTURED_CRITIQUE_SERVICE_TOKEN`.",
    );
  }

  return {
    baseUrl: normalizedBaseUrl,
    token,
    clientLabel:
      process.env.STRUCTURED_CRITIQUE_SERVICE_CLIENT?.trim() || DEFAULT_CLIENT_LABEL,
    timeoutMs: getStructuredCritiqueTimeoutMs(),
    authMode: token ? "service_token" : "user_session",
  };
}

function tryNormalizeServiceBaseUrl(baseUrl: string): string | null {
  try {
    return normalizeServiceBaseUrl(baseUrl);
  } catch {
    return null;
  }
}
