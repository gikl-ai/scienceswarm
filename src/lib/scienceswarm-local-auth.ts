import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  getScienceSwarmSignInUrl,
  getScienceSwarmLocalAuthBridgeUrl,
  isSupportedScienceSwarmLocalOrigin,
} from "@/lib/scienceswarm-auth";
import { getScienceSwarmDataRoot } from "@/lib/scienceswarm-paths";

export const SCIENCESWARM_LOCAL_AUTH_COOKIE = "scienceswarm_local_auth";
export const SCIENCESWARM_LOCAL_AUTH_TXN_COOKIE = "scienceswarm_local_auth_txn";

const LOCAL_AUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const FALLBACK_TOKEN_MAX_AGE_SECONDS = 60 * 60;
const MINIMUM_TOKEN_TTL_SECONDS = 30;

type ScienceSwarmLocalAuthCookiePayload = {
  expiresAt: string;
  issuedAt: string;
  token: string;
};

type ScienceSwarmLocalAuthStatePayload = {
  expiresAt: string;
  issuedAt: string;
  localOrigin: string;
  nonce: string;
  returnPath?: string;
};

type SignedCookiePayload =
  | ScienceSwarmLocalAuthCookiePayload
  | ScienceSwarmLocalAuthStatePayload;

function getScienceSwarmLocalAuthRoot(): string {
  return path.join(getScienceSwarmDataRoot(), "auth");
}

function getScienceSwarmLocalAuthSecretPath(): string {
  return path.join(getScienceSwarmLocalAuthRoot(), "local-auth-secret");
}

async function readOrCreateLocalAuthSecret(): Promise<Buffer> {
  const secretPath = getScienceSwarmLocalAuthSecretPath();
  try {
    const contents = await fs.readFile(secretPath, "utf8");
    const trimmed = contents.trim();
    if (!trimmed) {
      throw new Error("empty local auth secret");
    }
    return Buffer.from(trimmed, "base64url");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(getScienceSwarmLocalAuthRoot(), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32);
  await fs.writeFile(secretPath, secret.toString("base64url"), {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(secretPath, 0o600);
  return secret;
}

function signCookiePayload(payload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function parseCookieHeader(
  cookieHeader: string | null,
  cookieName: string,
): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== cookieName) continue;
    return valueParts.join("=");
  }
  return null;
}

async function encodeSignedCookie<T extends SignedCookiePayload>(
  payload: T,
): Promise<string> {
  const secret = await readOrCreateLocalAuthSecret();
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signature = signCookiePayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

async function decodeSignedCookie<T extends SignedCookiePayload>(
  value: string | null | undefined,
): Promise<T | null> {
  if (!value) return null;
  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) return null;

  const secret = await readOrCreateLocalAuthSecret();
  const expected = Buffer.from(signCookiePayload(encodedPayload, secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  try {
    const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}

function tokenExpiresAtToMaxAge(expiresAt: string): number {
  const expiresAtMs = readExpiresAt(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return FALLBACK_TOKEN_MAX_AGE_SECONDS;
  return Math.max(
    MINIMUM_TOKEN_TTL_SECONDS,
    Math.floor((expiresAtMs - Date.now()) / 1000),
  );
}

export function buildScienceSwarmLocalAuthCookieOptions(expiresAt: string): {
  httpOnly: true;
  maxAge: number;
  path: "/";
  sameSite: "lax";
  secure: boolean;
} {
  return {
    httpOnly: true,
    maxAge: tokenExpiresAtToMaxAge(expiresAt),
    path: "/",
    sameSite: "lax",
    secure: false,
  };
}

export function buildScienceSwarmCookieClearOptions(): {
  httpOnly: true;
  maxAge: 0;
  path: "/";
  sameSite: "lax";
  secure: boolean;
} {
  return {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: false,
  };
}

function readExpiresAt(expiresAt: string): number {
  return new Date(expiresAt).getTime();
}

export async function createScienceSwarmLocalAuthState(input: {
  localOrigin: string;
  returnPath?: string | null;
}): Promise<string> {
  if (!isSupportedScienceSwarmLocalOrigin(input.localOrigin)) {
    throw new Error("ScienceSwarm local sign-in only supports localhost origins.");
  }

  return encodeSignedCookie<ScienceSwarmLocalAuthStatePayload>({
    expiresAt: new Date(
      Date.now() + LOCAL_AUTH_STATE_MAX_AGE_SECONDS * 1000,
    ).toISOString(),
    issuedAt: new Date().toISOString(),
    localOrigin: input.localOrigin,
    nonce: randomBytes(24).toString("base64url"),
    ...(input.returnPath ? { returnPath: input.returnPath } : {}),
  });
}

export async function createScienceSwarmLocalAuthCookieValue(input: {
  expiresAt: string;
  token: string;
}): Promise<string> {
  return encodeSignedCookie<ScienceSwarmLocalAuthCookiePayload>({
    expiresAt: input.expiresAt,
    issuedAt: new Date().toISOString(),
    token: input.token,
  });
}

export async function readScienceSwarmLocalAuthState(
  state: string,
): Promise<ScienceSwarmLocalAuthStatePayload | null> {
  const payload = await decodeSignedCookie<ScienceSwarmLocalAuthStatePayload>(
    state,
  );
  if (!payload) return null;
  if (!isSupportedScienceSwarmLocalOrigin(payload.localOrigin)) {
    return null;
  }
  const expiresAtMs = readExpiresAt(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return null;
  }
  return payload;
}

export async function readScienceSwarmLocalAuthFromRequest(
  request: Request,
): Promise<ScienceSwarmLocalAuthCookiePayload | null> {
  const payload = await decodeSignedCookie<ScienceSwarmLocalAuthCookiePayload>(
    parseCookieHeader(request.headers.get("cookie"), SCIENCESWARM_LOCAL_AUTH_COOKIE),
  );
  if (!payload) return null;
  const expiresAtMs = readExpiresAt(payload.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return null;
  }
  return payload;
}

export async function getScienceSwarmLocalAuthorizationFromRequest(
  request: Request,
): Promise<string | null> {
  const payload = await readScienceSwarmLocalAuthFromRequest(request);
  if (!payload) return null;
  return `Bearer ${payload.token}`;
}

export function buildScienceSwarmLocalBridgeUrl(input: {
  localOrigin: string;
  state: string;
}): string {
  if (!isSupportedScienceSwarmLocalOrigin(input.localOrigin)) {
    throw new Error("ScienceSwarm local sign-in only supports localhost origins.");
  }

  const url = new URL(getScienceSwarmLocalAuthBridgeUrl());
  url.searchParams.set("origin", input.localOrigin);
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function buildScienceSwarmLocalSignInUrl(input: {
  localOrigin: string;
  state: string;
}): string {
  const bridgeUrl = buildScienceSwarmLocalBridgeUrl(input);
  const url = new URL(getScienceSwarmSignInUrl());
  url.searchParams.set("redirect_url", bridgeUrl);
  return url.toString();
}

export function readScienceSwarmJwtExpiry(token: string): string | null {
  const segments = token.split(".");
  if (segments.length < 2) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(segments[1] || "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}
