import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { RuntimeHostId } from "../contracts";

export const RUNTIME_MCP_TOKEN_VERSION = 1;

export const RUNTIME_MCP_TOOL_NAMES = [
  "gbrain_search",
  "gbrain_read",
  "gbrain_capture",
  "project_workspace_read",
  "artifact_import",
  "openhands_delegate",
  "provenance_log",
] as const;

export type RuntimeMcpToolName = (typeof RUNTIME_MCP_TOOL_NAMES)[number];

export interface RuntimeMcpAccessTokenClaims {
  version: typeof RUNTIME_MCP_TOKEN_VERSION;
  tokenId: string;
  projectId: string;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
  allowedTools: RuntimeMcpToolName[];
  issuedAt: string;
  expiresAt: string;
}

export interface MintRuntimeMcpAccessTokenInput {
  projectId: string;
  runtimeSessionId: string;
  hostId: RuntimeHostId | string;
  allowedTools: readonly RuntimeMcpToolName[];
  ttlMs?: number;
  now?: () => Date;
  secret?: string;
  tokenId?: string;
}

export type RuntimeMcpAccessTokenRejectReason =
  | "missing-token"
  | "malformed-token"
  | "invalid-signature"
  | "expired-token"
  | "wrong-project"
  | "wrong-session"
  | "wrong-host"
  | "tool-not-allowed";

export type RuntimeMcpAccessTokenVerification =
  | {
      ok: true;
      claims: RuntimeMcpAccessTokenClaims;
    }
  | {
      ok: false;
      reason: RuntimeMcpAccessTokenRejectReason;
      message: string;
    };

export interface VerifyRuntimeMcpAccessTokenInput {
  token?: string | null;
  projectId?: string;
  runtimeSessionId?: string;
  hostId?: RuntimeHostId | string;
  toolName?: RuntimeMcpToolName;
  now?: () => Date;
  secret?: string;
  trustedToken?: string;
}

const DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS = 5 * 60 * 1000;
const PROCESS_RUNTIME_MCP_TOKEN_SECRET = randomBytes(32).toString("base64url");

function runtimeMcpTokenSecret(secret?: string): string {
  return (
    secret
    ?? process.env.SCIENCESWARM_RUNTIME_MCP_TOKEN_SECRET
    ?? PROCESS_RUNTIME_MCP_TOKEN_SECRET
  );
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf-8"));
}

function signPayload(encodedPayload: string, secret?: string): string {
  return createHmac("sha256", runtimeMcpTokenSecret(secret))
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(rightBuffer, rightBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(rightBuffer, rightBuffer);
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function uniqueTools(
  tools: readonly RuntimeMcpToolName[],
): RuntimeMcpToolName[] {
  return Array.from(new Set(tools));
}

function isRuntimeMcpToolName(value: unknown): value is RuntimeMcpToolName {
  return typeof value === "string"
    && RUNTIME_MCP_TOOL_NAMES.includes(value as RuntimeMcpToolName);
}

function parseClaims(value: unknown): RuntimeMcpAccessTokenClaims | null {
  if (!value || typeof value !== "object") return null;
  const claims = value as Partial<RuntimeMcpAccessTokenClaims>;
  if (claims.version !== RUNTIME_MCP_TOKEN_VERSION) return null;
  if (typeof claims.tokenId !== "string" || claims.tokenId.trim() === "") return null;
  if (typeof claims.projectId !== "string" || claims.projectId.trim() === "") return null;
  if (
    typeof claims.runtimeSessionId !== "string"
    || claims.runtimeSessionId.trim() === ""
  ) {
    return null;
  }
  if (typeof claims.hostId !== "string" || claims.hostId.trim() === "") return null;
  if (!Array.isArray(claims.allowedTools) || claims.allowedTools.length === 0) {
    return null;
  }
  if (!claims.allowedTools.every(isRuntimeMcpToolName)) return null;
  if (typeof claims.issuedAt !== "string" || Number.isNaN(Date.parse(claims.issuedAt))) {
    return null;
  }
  if (
    typeof claims.expiresAt !== "string"
    || Number.isNaN(Date.parse(claims.expiresAt))
  ) {
    return null;
  }

  return {
    version: RUNTIME_MCP_TOKEN_VERSION,
    tokenId: claims.tokenId,
    projectId: claims.projectId,
    runtimeSessionId: claims.runtimeSessionId,
    hostId: claims.hostId,
    allowedTools: uniqueTools(claims.allowedTools),
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  };
}

function reject(
  reason: RuntimeMcpAccessTokenRejectReason,
  message: string,
): RuntimeMcpAccessTokenVerification {
  return { ok: false, reason, message };
}

export function mintRuntimeMcpAccessToken(
  input: MintRuntimeMcpAccessTokenInput,
): string {
  const now = input.now?.() ?? new Date();
  const ttlMs = input.ttlMs ?? DEFAULT_RUNTIME_MCP_TOKEN_TTL_MS;
  const claims: RuntimeMcpAccessTokenClaims = {
    version: RUNTIME_MCP_TOKEN_VERSION,
    tokenId: input.tokenId ?? randomBytes(16).toString("base64url"),
    projectId: input.projectId,
    runtimeSessionId: input.runtimeSessionId,
    hostId: input.hostId,
    allowedTools: uniqueTools([...input.allowedTools]),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  const encodedPayload = encodeJson(claims);
  return `${encodedPayload}.${signPayload(encodedPayload, input.secret)}`;
}

export function verifyRuntimeMcpAccessToken(
  input: VerifyRuntimeMcpAccessTokenInput,
): RuntimeMcpAccessTokenVerification {
  const token = input.token?.trim();
  if (!token) {
    return reject("missing-token", "Runtime MCP access token is required.");
  }

  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    return reject("malformed-token", "Runtime MCP access token is malformed.");
  }

  const trustedToken = input.trustedToken?.trim();
  const tokenIsTrustedEnvValue = trustedToken !== undefined
    && safeStringEqual(token, trustedToken);
  if (!tokenIsTrustedEnvValue) {
    const expectedSignature = signPayload(encodedPayload, input.secret);
    if (!safeEqual(signature, expectedSignature)) {
      return reject("invalid-signature", "Runtime MCP access token signature is invalid.");
    }
  }

  let claims: RuntimeMcpAccessTokenClaims | null = null;
  try {
    claims = parseClaims(decodeJson(encodedPayload));
  } catch {
    return reject("malformed-token", "Runtime MCP access token payload is malformed.");
  }
  if (!claims) {
    return reject("malformed-token", "Runtime MCP access token payload is invalid.");
  }

  const now = input.now?.() ?? new Date();
  if (Date.parse(claims.expiresAt) <= now.getTime()) {
    return reject("expired-token", "Runtime MCP access token has expired.");
  }
  if (input.projectId !== undefined && claims.projectId !== input.projectId) {
    return reject("wrong-project", "Runtime MCP access token is not scoped to this project.");
  }
  if (
    input.runtimeSessionId !== undefined
    && claims.runtimeSessionId !== input.runtimeSessionId
  ) {
    return reject("wrong-session", "Runtime MCP access token is not scoped to this session.");
  }
  if (input.hostId !== undefined && claims.hostId !== input.hostId) {
    return reject("wrong-host", "Runtime MCP access token is not scoped to this host.");
  }
  if (
    input.toolName !== undefined
    && !claims.allowedTools.includes(input.toolName)
  ) {
    return reject("tool-not-allowed", "Runtime MCP access token does not allow this tool.");
  }

  return { ok: true, claims };
}
