import * as path from "node:path";
import { promises as fs } from "node:fs";

import {
  resolveOpenClawMode,
  runOpenClaw,
} from "@/lib/openclaw/runner";

export interface PendingTelegramPairingRequest {
  id: string;
  code: string;
  createdAt?: string;
  lastSeenAt?: string;
  meta?: {
    username?: string;
    firstName?: string;
    lastName?: string;
    accountId?: string;
  };
}

export interface TelegramPreapprovalResult {
  allowlistReady: boolean;
  warning: string | null;
}

interface TelegramAllowFromWriteResult {
  configReady: boolean;
  legacyStoreReady: boolean;
}

function parseOpenClawAllowFromOutput(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // Treat unparsable output as empty and let the next write normalize it.
  }
  return [];
}

async function readTelegramAllowFromConfig(): Promise<string[]> {
  const result = await runOpenClaw(
    ["config", "get", "channels.telegram.allowFrom"],
    { timeoutMs: 10_000 },
  );
  if (!result.ok) return [];
  return parseOpenClawAllowFromOutput(result.stdout);
}

async function writeLegacyTelegramAllowFrom(
  telegramUserId: string,
): Promise<boolean> {
  const mode = resolveOpenClawMode();
  if (mode.kind !== "state-dir") return false;

  const credsDir = path.join(mode.stateDir, "credentials");
  const allowFromPath = path.join(credsDir, "telegram-default-allowFrom.json");

  await fs.mkdir(credsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(credsDir, 0o700);

  let existing: { version?: number; allowFrom?: unknown } = {};
  try {
    const raw = await fs.readFile(allowFromPath, "utf8");
    existing = JSON.parse(raw) as typeof existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      existing = {};
    }
  }

  const current = Array.isArray(existing.allowFrom) ? existing.allowFrom : [];
  const merged = new Set<string>(
    current.filter((value): value is string => typeof value === "string"),
  );
  merged.add(telegramUserId);

  await fs.writeFile(
    allowFromPath,
    JSON.stringify(
      {
        version: 1,
        allowFrom: Array.from(merged),
      },
      null,
      2,
    ) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return true;
}

async function writeTelegramAllowFrom(
  telegramUserId: string,
): Promise<TelegramAllowFromWriteResult> {
  const legacyStoreReady = await writeLegacyTelegramAllowFrom(telegramUserId);
  const existingConfigAllowFrom = await readTelegramAllowFromConfig();
  const merged = new Set<string>(existingConfigAllowFrom);
  merged.add(telegramUserId);

  const configResult = await runOpenClaw(
    [
      "config",
      "set",
      "channels.telegram.allowFrom",
      JSON.stringify(Array.from(merged)),
      "--strict-json",
    ],
    { timeoutMs: 10_000 },
  );

  return {
    configReady: configResult.ok,
    legacyStoreReady,
  };
}

export async function preapproveTelegramUserId(
  telegramUserId: string,
): Promise<TelegramPreapprovalResult> {
  try {
    const preapproved = await writeTelegramAllowFrom(telegramUserId);
    if (preapproved.configReady) {
      const dmPolicyResult = await runOpenClaw(
        ["config", "set", "channels.telegram.dmPolicy", "allowlist"],
        { timeoutMs: 10_000 },
      );
      if (dmPolicyResult.ok) {
        return {
          allowlistReady: true,
          warning: null,
        };
      }
      return {
        allowlistReady: false,
        warning:
          "Warning: saved your Telegram user id but could not switch OpenClaw to allowlist mode. You'll see the pairing prompt on your first message; approve yourself from the terminal.",
      };
    }

    if (preapproved.legacyStoreReady) {
      return {
        allowlistReady: false,
        warning:
          "Warning: saved your Telegram user id to OpenClaw's legacy allowlist but could not update channels.telegram.allowFrom. OpenClaw may still ask for pairing on your first message.",
      };
    }

    return {
      allowlistReady: false,
      warning:
        "Warning: could not pre-approve your Telegram user id in OpenClaw. You'll see OpenClaw's pairing prompt on your first message; follow its terminal command to approve yourself.",
    };
  } catch (error) {
    return {
      allowlistReady: false,
      warning: `Warning: could not pre-approve your Telegram user id. ${(error as Error).message}`,
    };
  }
}

export function parsePendingTelegramPairingRequests(
  stdout: string,
): PendingTelegramPairingRequest[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];
    return parsed.requests.filter(
      (value): value is PendingTelegramPairingRequest =>
        typeof value === "object"
        && value !== null
        && typeof (value as { id?: unknown }).id === "string"
        && typeof (value as { code?: unknown }).code === "string",
    );
  } catch {
    return [];
  }
}

function pendingTelegramPairingTimestamp(
  request: PendingTelegramPairingRequest,
): number {
  const latest =
    Date.parse(request.lastSeenAt ?? "")
    || Date.parse(request.createdAt ?? "");
  return Number.isFinite(latest) ? latest : 0;
}

export function selectLatestPendingTelegramPairing(
  requests: PendingTelegramPairingRequest[],
): PendingTelegramPairingRequest | null {
  if (requests.length === 0) return null;
  return requests.reduce((latest, candidate) =>
    pendingTelegramPairingTimestamp(candidate)
    >= pendingTelegramPairingTimestamp(latest)
      ? candidate
      : latest,
  );
}

export async function listPendingTelegramPairingRequests(
  options: { timeoutMs?: number } = {},
): Promise<PendingTelegramPairingRequest[]> {
  const result = await runOpenClaw(
    ["pairing", "list", "--channel", "telegram", "--json"],
    { timeoutMs: options.timeoutMs ?? 10_000 },
  );
  if (!result.ok) return [];
  return parsePendingTelegramPairingRequests(result.stdout);
}

export async function approveTelegramPairingRequest(
  request: PendingTelegramPairingRequest,
): Promise<boolean> {
  const args = ["pairing", "approve", "telegram", request.code];
  const accountId =
    typeof request.meta?.accountId === "string"
      ? request.meta.accountId.trim()
      : "";
  if (accountId) {
    args.push("--account", accountId);
  }
  const result = await runOpenClaw(args, { timeoutMs: 10_000 });
  return result.ok;
}
