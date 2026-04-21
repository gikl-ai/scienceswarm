/**
 * telegram-bot task:
 *
 *   1. If the user pasted a bot token or `.env` already has one,
 *      validate it with the Bot API and reuse it. Pasted tokens with
 *      no `TELEGRAM_USER_ID` claim ownership through a one-time
 *      `/start <nonce>` deeplink; already-saved bots finish by pairing
 *      the current Telegram account through OpenClaw.
 *   2. Otherwise, when a phone was provided, run the fresh install:
 *      sendCode(phone) → wait for /api/setup/telegram-code →
 *      submitCode → drive BotFather → save token + creature to .env.
 *   3. Wire the bot token into OpenClaw via
 *      `openclaw channels add --channel telegram --token <token>` and
 *      restart the
 *      gateway service so it actually listens on the new bot after
 *      the setup request exits. Without this step the token sits in
 *      `.env` but the OpenClaw gateway never picks it up, and the bot
 *      is visible in Telegram but completely silent.
 */

import * as path from "node:path";
import { promises as fs } from "node:fs";

import {
  resolveOpenClawMode,
  runOpenClaw,
  spawnOpenClaw,
  writeGatewayPid,
} from "@/lib/openclaw/runner";
import {
  approveTelegramPairingRequest,
  listPendingTelegramPairingRequests,
  preapproveTelegramUserId as preapproveTelegramUserIdInOpenClaw,
  selectLatestPendingTelegramPairing,
  type PendingTelegramPairingRequest,
} from "@/lib/openclaw/telegram-link";
import { creatureDisplayName } from "@/lib/telegram/creature-names";
import {
  buildStartDeeplink,
  deleteWebhook,
  generateNonce,
  getMe,
  getUpdates,
  getWebhookInfo,
  TelegramBotApiError,
  type TelegramUpdate,
} from "@/lib/telegram/bot-api";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
} from "@/lib/setup/env-writer";
import { getOpenClawPort } from "@/lib/config/ports";

import type { InstallTask, TaskYield } from "./types";

/**
 * Resolvers for in-flight code submissions, keyed by sessionId. The
 * /api/setup/telegram-code route looks up the sessionId here and
 * calls the resolver to unblock the paused bootstrap generator.
 *
 * Why this lives on `globalThis`: in `next dev --webpack` (which is
 * what `./start.sh` runs), route handlers are compiled into separate
 * webpack chunks, and module-level state like a plain `new Map()`
 * does NOT reliably survive across chunks. The bootstrap route's
 * view of `pendingCodes` and the telegram-code route's view can end
 * up as two different Map instances — `set` in the bootstrap chunk
 * invisible to `get` in the telegram-code chunk — which surfaces
 * as "No pending session" on every code submission. Pinning the
 * Map to `globalThis` makes it genuinely process-wide and deduped
 * across chunks. Same pattern Next.js docs recommend for Prisma
 * clients and WebSocket servers in dev mode. In production
 * (`next start`) both strategies work; `globalThis` just also
 * survives dev-mode HMR without changing the public contract.
 */
const GLOBAL_KEY = "__scienceswarmTelegramPendingCodes" as const;
const globalForCodes = globalThis as typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, (code: string) => void>;
};
export const pendingCodes: Map<string, (code: string) => void> =
  globalForCodes[GLOBAL_KEY] ?? (globalForCodes[GLOBAL_KEY] = new Map());

interface WireBotIntoOpenClawOptions {
  pairingExpected?: boolean;
}

async function persistBotMetadata(
  repoRoot: string,
  values: {
    token?: string | null;
    username?: string | null;
    creature?: string | null;
    userId?: string | null;
  },
): Promise<void> {
  const envPath = path.join(repoRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const doc = parseEnvFile(existing);
  const updates: Record<string, string | null> = {};
  if (values.token !== undefined) updates.TELEGRAM_BOT_TOKEN = values.token;
  if (values.username !== undefined) updates.TELEGRAM_BOT_USERNAME = values.username;
  if (values.creature !== undefined) updates.TELEGRAM_BOT_CREATURE = values.creature;
  if (values.userId !== undefined) updates.TELEGRAM_USER_ID = values.userId;
  const merged = mergeEnvValues(doc, updates);
  await writeEnvFileAtomic(envPath, serializeEnvDocument(merged));
}

async function clearBotMetadata(repoRoot: string): Promise<void> {
  await persistBotMetadata(repoRoot, {
    token: null,
    username: null,
    creature: null,
    userId: null,
  });
}

interface PersistedTelegramBotMetadata {
  token: string | null;
  username: string | null;
  creature: string | null;
  userId: string | null;
}

function readEnvValue(
  doc: ReturnType<typeof parseEnvFile>,
  key: string,
): string | null {
  for (const line of doc.lines) {
    if (line.type !== "entry" || line.key !== key) continue;
    const trimmed = line.value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

async function readPersistedBotMetadata(
  repoRoot: string,
): Promise<PersistedTelegramBotMetadata> {
  const envPath = path.join(repoRoot, ".env");
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const doc = parseEnvFile(existing);
  return {
    token: readEnvValue(doc, "TELEGRAM_BOT_TOKEN"),
    username: readEnvValue(doc, "TELEGRAM_BOT_USERNAME"),
    creature: readEnvValue(doc, "TELEGRAM_BOT_CREATURE"),
    userId: readEnvValue(doc, "TELEGRAM_USER_ID"),
  };
}

function formatBotSuccessDetail(
  username: string | null,
  creature: string | null,
): string {
  if (!username) return "Existing Telegram bot available in OpenClaw profile.";
  const displayName = creature
    ? creatureDisplayName(creature)
    : "Existing Telegram bot";
  return `${displayName} — https://t.me/${username}`;
}

function nextUpdateOffset(
  updates: TelegramUpdate[],
  fallback?: number,
): number | undefined {
  if (updates.length === 0) return fallback;
  const maxSeen = updates.reduce(
    (max, update) => Math.max(max, update.update_id),
    updates[0]?.update_id ?? 0,
  );
  return maxSeen + 1;
}

function findNonceClaimUserId(
  updates: TelegramUpdate[],
  nonce: string,
): string | null {
  const expected = `/start ${nonce}`;
  for (const update of updates) {
    const text = update.message?.text?.trim();
    const userId = update.message?.from?.id;
    if (text === expected && userId !== undefined && userId !== null) {
      return String(userId);
    }
  }
  return null;
}

async function prepareBotApiPolling(token: string): Promise<number | undefined> {
  const webhook = await getWebhookInfo(token);
  if (webhook.url.trim()) {
    await deleteWebhook(token, true);
  }
  const pending = await getUpdates(token, {
    timeout: 0,
    allowed_updates: ["message"],
  });
  return nextUpdateOffset(pending);
}

async function* claimTelegramUserId(
  token: string,
  botUsername: string,
  initialOffset: number | undefined,
): AsyncGenerator<TaskYield, string | null, unknown> {
  const nonce = generateNonce();
  const deeplink = buildStartDeeplink(botUsername, nonce);
  yield {
    status: "waiting-for-input",
    needs: "telegram-nonce-claim",
    nonceClaim: {
      deeplink,
      botUsername,
    },
    detail: "Open Telegram to finish connecting your bot.",
  };

  const deadline = Date.now() + 5 * 60 * 1000;
  let offset = initialOffset;
  while (Date.now() < deadline) {
    const updates = await getUpdates(token, {
      offset,
      timeout: 30,
      allowed_updates: ["message"],
    });
    const userId = findNonceClaimUserId(updates, nonce);
    if (userId) return userId;
    offset = nextUpdateOffset(updates, offset);
  }
  return null;
}

function telegramBotApiErrorMessage(err: unknown): string {
  if (err instanceof TelegramBotApiError && err.conflict) {
    return "Another process is still polling this bot token. Stop the old install and retry.";
  }
  if (err instanceof TelegramBotApiError && err.unauthorized) {
    return "Telegram bot token is no longer valid. Start over with a fresh install or paste a new token.";
  }
  return (err as Error).message;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function* preapproveTelegramUserId(
  telegramUserId: string,
  options: { warnStillPairing?: boolean } = {},
): AsyncGenerator<TaskYield, boolean, unknown> {
  const preapproval = await preapproveTelegramUserIdInOpenClaw(telegramUserId);
  if (preapproval.warning) {
    yield {
      status: "running",
      detail: preapproval.warning,
    };
  }

  const allowlistReady = preapproval.allowlistReady;
  if (!allowlistReady && options.warnStillPairing !== false) {
    yield {
      status: "running",
      detail:
        "Warning: OpenClaw will stay in pairing mode until your first Telegram message is approved.",
    };
  }
  return allowlistReady;
}

async function* waitForTelegramPairingRequest(
  botUsername: string,
): AsyncGenerator<TaskYield, PendingTelegramPairingRequest | null, unknown> {
  yield {
    status: "waiting-for-input",
    needs: "telegram-nonce-claim",
    nonceClaim: {
      deeplink: `https://t.me/${botUsername}`,
      botUsername,
    },
    detail:
      "Open Telegram, tap Start in the bot chat, and keep this page open while OpenClaw finishes pairing your account.",
  };

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const pairingRequest = selectLatestPendingTelegramPairing(
      await listPendingTelegramPairingRequests(),
    );
    if (pairingRequest) return pairingRequest;
    await sleep(2_000);
  }
  return null;
}

/**
 * Wire a freshly-created Telegram bot into OpenClaw's own config and
 * restart the gateway so the next incoming message from the user is
 * routed through OpenClaw instead of landing in a silent void.
 *
 * Why this step exists: saving `TELEGRAM_BOT_TOKEN` to ScienceSwarm's
 * `.env` only configures ScienceSwarm's code, not the OpenClaw gateway
 * that actually connects to Telegram. OpenClaw reads
 * `channels.telegram.botToken` from its OWN `openclaw.json`, and it
 * needs a fresh gateway process to pick up changes. Without both
 * writes plus the restart, a brand-new user sees the bot in Telegram
 * ("mistbun_seiji_bot"), hits Start, and the bot never replies.
 * Reported from dogfood of docs/install-guide PR.
 *
 * Access control: we also pre-populate `channels.telegram.dmPolicy`
 * to `allowlist` and add the user's OWN Telegram user ID to
 * `channels.telegram.allowFrom`. This skips OpenClaw's pairing dance
 * ("Your Telegram user id: XXX; ask the bot owner to approve with:
 * openclaw pairing approve telegram YYY") which would otherwise
 * require the user to go back to the terminal and run a manual
 * command. Since the install user IS the bot owner AND the sole
 * intended user, automatic pre-approval is both correct and the
 * strictly-more-secure choice compared to `open` (anyone can DM).
 *
 * Failure policy: every sub-step yields a warning instead of
 * failing the whole task. The bot exists in Telegram either way, and
 * a user who hits a restart bug can recover by running
 * `./start.sh` again.
 */
async function* wireBotIntoOpenClaw(
  token: string,
  telegramUserId: string | null,
  options: WireBotIntoOpenClawOptions = {},
): AsyncGenerator<TaskYield, void, unknown> {
  yield { status: "running", detail: "Telling OpenClaw about the new bot…" };

  // Register the bot via `openclaw channels add`, NOT `openclaw config
  // set channels.telegram.botToken`. The `config set` path silently
  // accepts the write but never lands the token in OpenClaw's active
  // channel state — a live `openclaw channels list` shows
  // "token=none" after that write, and the gateway has nothing to
  // connect to. `channels add --channel telegram --token <token>` is
  // the blessed API that actually persists the bot credential into
  // OpenClaw's credential store and enables the channel in one shot.
  const tokenResult = await runOpenClaw(
    ["channels", "add", "--channel", "telegram", "--token", token],
    { timeoutMs: 15_000 },
  );
  if (!tokenResult.ok) {
    yield {
      status: "running",
      // Do not surface raw stderr: the failing command includes the
      // bot token as an argv value, and some OpenClaw failures echo
      // the attempted command line back into stderr.
      detail:
        "Warning: could not register the Telegram bot with OpenClaw (channels add). Check OpenClaw logs to finish wiring the bot.",
    };
    return;
  }

  // Pre-approve the install user's own Telegram account so the first
  // message they send to the new bot gets an answer instead of the
  // "OpenClaw: access not configured / Your Telegram user id: XXX /
  // Pairing code: YYY / Ask the bot owner to approve with ..."
  // prompt. New OpenClaw builds require the explicit config allowlist;
  // we also keep the legacy credentials store in state-dir mode.
  if (telegramUserId) {
    yield* preapproveTelegramUserId(telegramUserId);
  } else if (options.pairingExpected) {
    yield {
      status: "running",
      detail:
        "OpenClaw is ready for Telegram pairing. Tap Start in Telegram to finish connecting this bot.",
    };
  } else {
    yield {
      status: "running",
      detail:
        "Warning: could not resolve your Telegram user id for allowFrom pre-approval. You'll see OpenClaw's pairing prompt on your first message; follow its terminal command to approve yourself.",
    };
  }

  // Restart the gateway so it re-reads openclaw.json and starts the
  // Telegram channel. Prefer OpenClaw's service manager instead of
  // `gateway run`: the setup route is request-scoped, and a child
  // process launched from it can disappear when the request/dev server
  // lifecycle ends. Installing the service through the wrapper persists
  // OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH into launchd/systemd.
  yield {
    status: "running",
    detail: "Restarting OpenClaw gateway to pick up the bot token…",
  };
  await runOpenClaw(["gateway", "stop"], { timeoutMs: 10_000 });

  const port = getOpenClawPort();
  const installResult = await runOpenClaw(
    ["gateway", "install", "--force", "--port", String(port)],
    { timeoutMs: 30_000 },
  );
  if (installResult.ok) {
    const startResult = await runOpenClaw(["gateway", "start"], {
      timeoutMs: 30_000,
    });
    if (startResult.ok) return;

    yield {
      status: "running",
      detail:
        "Warning: OpenClaw gateway service was installed but did not start; trying a detached fallback.",
    };
  } else {
    const startResult = await runOpenClaw(["gateway", "start"], {
      timeoutMs: 15_000,
    });
    if (startResult.ok) return;

    yield {
      status: "running",
      detail:
        "Warning: could not install/start the OpenClaw gateway service; trying a detached fallback.",
    };
  }

  // Last resort for environments without a working service manager.
  // This is weaker than the service path but still lets developers
  // recover from non-launchd/non-systemd shells.
  try {
    const child = spawnOpenClaw(
      ["gateway", "run", "--port", String(port), "--bind", "loopback"],
      { detached: true, stdio: "ignore" },
    );
    if (typeof child.pid === "number") {
      writeGatewayPid(child.pid);
    }
    child.unref();
  } catch (err) {
    yield {
      status: "running",
      detail: `Warning: could not restart gateway. ${(err as Error).message}`,
    };
  }
}

export const telegramBotTask: InstallTask = {
  id: "telegram-bot",
  async *run(input) {
    const persistedBot = await readPersistedBotMetadata(input.repoRoot);
    const openClawMode = resolveOpenClawMode();
    const allowPersistedBotReuse = input.telegramMode !== "fresh";
    const reusableToken =
      input.existingBot?.token
      ?? (allowPersistedBotReuse ? persistedBot.token : null);
    const canUsePersistedBotMetadata =
      allowPersistedBotReuse
      && (!input.existingBot?.token || input.existingBot.token === persistedBot.token);

    if (reusableToken) {
      yield {
        status: "running",
        detail: input.existingBot?.token
          ? "Validating existing Telegram bot token…"
          : "Validating saved Telegram bot token…",
      };

      let botMe: Awaited<ReturnType<typeof getMe>>;
      try {
        botMe = await getMe(reusableToken);
      } catch (err) {
        if (
          err instanceof TelegramBotApiError &&
          err.unauthorized &&
          canUsePersistedBotMetadata
        ) {
          await clearBotMetadata(input.repoRoot).catch(() => {});
        }
        yield {
          status: "failed",
          error: telegramBotApiErrorMessage(err),
        };
        return;
      }

      const botUsername = botMe.username ?? persistedBot.username;
      if (!botUsername) {
        yield {
          status: "failed",
          error:
            "Telegram accepted the bot token, but did not return a bot username.",
        };
        return;
      }
      const botCreature = canUsePersistedBotMetadata
        ? persistedBot.creature
        : null;

      try {
        await persistBotMetadata(input.repoRoot, {
          token: reusableToken,
          username: botUsername,
          creature: botCreature ?? null,
          userId: canUsePersistedBotMetadata
            ? (persistedBot.userId ?? undefined)
            : null,
        });
      } catch (err) {
        yield {
          status: "failed",
          error: `Failed to save Telegram metadata: ${(err as Error).message}`,
        };
        return;
      }

      if (openClawMode.kind === "profile") {
        yield {
          status: "running",
          detail: `Using existing OpenClaw profile "${openClawMode.profile}" for Telegram.`,
        };
        yield {
          status: "succeeded",
          detail: formatBotSuccessDetail(botUsername, botCreature),
        };
        return;
      }

      let telegramUserId = canUsePersistedBotMetadata
        ? persistedBot.userId
        : null;
      if (!telegramUserId) {
        if (!canUsePersistedBotMetadata) {
          let offset: number | undefined;
          try {
            yield {
              status: "running",
              detail: "Preparing your existing bot for the Telegram claim…",
            };
            offset = await prepareBotApiPolling(reusableToken);
            telegramUserId = await (yield* claimTelegramUserId(
              reusableToken,
              botUsername,
              offset,
            ));
          } catch (err) {
            yield {
              status: "failed",
              error: telegramBotApiErrorMessage(err),
            };
            return;
          }
          if (!telegramUserId) {
            yield {
              status: "failed",
              error:
                "Timed out waiting for Telegram to receive your /start message. Open the bot link and retry setup.",
            };
            return;
          }
        }
      }

      if (telegramUserId) {
        try {
          await persistBotMetadata(input.repoRoot, {
            token: reusableToken,
            username: botUsername,
            creature: botCreature ?? null,
            userId: telegramUserId,
          });
        } catch (err) {
          yield {
            status: "failed",
            error: `Failed to save Telegram metadata: ${(err as Error).message}`,
          };
          return;
        }
      }

      yield { status: "running", detail: "Reusing existing Telegram bot token…" };
      yield* wireBotIntoOpenClaw(reusableToken, telegramUserId, {
        pairingExpected: canUsePersistedBotMetadata && !telegramUserId,
      });

      if (!telegramUserId && canUsePersistedBotMetadata) {
        const pairingRequest = await (yield* waitForTelegramPairingRequest(
          botUsername,
        ));
        if (!pairingRequest) {
          yield {
            status: "failed",
            error:
              "Timed out waiting for OpenClaw to see your Telegram Start message. Open the bot chat, tap Start, and retry.",
          };
          return;
        }

        yield {
          status: "running",
          detail: "Approving your Telegram account in OpenClaw…",
        };
        const approved = await approveTelegramPairingRequest(pairingRequest);
        if (!approved) {
          yield {
            status: "failed",
            error:
              "OpenClaw saw your Telegram message but could not finish pairing automatically. Retry from Settings.",
          };
          return;
        }

        // OpenClaw pairing JSON uses `id` for the Telegram user id; `meta.accountId`
        // is the OpenClaw account slot (for example "default"), not the Telegram id.
        telegramUserId = pairingRequest.id;
        yield* preapproveTelegramUserId(telegramUserId, {
          warnStillPairing: false,
        });
        try {
          await persistBotMetadata(input.repoRoot, {
            token: reusableToken,
            username: botUsername,
            creature: botCreature ?? null,
            userId: telegramUserId,
          });
        } catch (err) {
          yield {
            status: "failed",
            error: `Failed to save Telegram metadata: ${(err as Error).message}`,
          };
          return;
        }
      }

      yield {
        status: "succeeded",
        detail: formatBotSuccessDetail(botUsername, botCreature),
      };
      return;
    }

    if (!input.phone) {
      yield {
        status: "skipped",
        detail: "No phone or saved Telegram bot — skip Telegram bot setup.",
      };
      return;
    }

    const { telegramCredentialsConfigured } = await import(
      "@/lib/telegram/constants"
    );
    if (!telegramCredentialsConfigured()) {
      yield {
        status: "failed",
        error:
          "ScienceSwarm Telegram credentials not configured. See scripts/register-telegram-app.md.",
      };
      return;
    }

    const { sendCode, submitCode, abortSession } = await import(
      "@/lib/telegram/sign-in"
    );

    let signed:
      | {
          sessionString: string;
          client: {
            getMe(): Promise<unknown>;
            disconnect(): Promise<void>;
          };
        }
      | null = null;
    let telegramUserId: string | null =
      input.telegramMode === "fresh" ? null : persistedBot.userId;

    yield {
      status: "running",
      detail: "Sending SMS code…",
    };
    let sessionId: string;
    try {
      ({ sessionId } = await sendCode(input.phone ?? ""));
    } catch (err) {
      yield {
        status: "failed",
        error: `sendCode failed: ${(err as Error).message}`,
      };
      return;
    }

    yield {
      status: "waiting-for-input",
      needs: "telegram-code",
      sessionId,
      detail: "Enter the code sent to your phone",
    };

    const code = await new Promise<string>((resolve) => {
      pendingCodes.set(sessionId, resolve);
    });
    pendingCodes.delete(sessionId);

    yield { status: "running", detail: "Signing in…" };
    try {
      signed = await submitCode(sessionId, code);
    } catch (err) {
      await abortSession(sessionId);
      yield {
        status: "failed",
        error: `submitCode failed: ${(err as Error).message}`,
      };
      return;
    }

    if (!signed) return;

    const { TelegramSessionStore } = await import("@/lib/telegram/session-store");
    const store = new TelegramSessionStore();
    try {
      await store.save(signed.sessionString);
    } catch (err) {
      // Non-fatal: we still have the in-memory client to proceed.
      yield {
        status: "running",
        detail: `Session save warning: ${(err as Error).message}`,
      };
    }

    // Capture the install user's own Telegram user id. We persist it
    // into `.env` so future onboarding reruns can reuse the existing
    // bot without hitting BotFather or even repeating SMS login.
    try {
      const me = (await signed.client.getMe()) as { id?: unknown };
      if (me && me.id !== undefined && me.id !== null) {
        telegramUserId = String(me.id);
      }
    } catch {
      // Non-fatal. wireBotIntoOpenClaw will yield a warning and fall
      // back to pairing-mode instructions for the user.
    }

    let botToken: string;
    let botUsername: string;
    let botCreature: string;
    let botDisplayName: string;
    yield { status: "running", detail: "Creating bot via @BotFather…" };
    try {
      const { createBotViaBotFather } = await import(
        "@/lib/telegram/create-bot"
      );
      const createdBot = await createBotViaBotFather(
        signed.client as never,
        input.handle,
      );
      botToken = createdBot.token;
      botUsername = createdBot.username;
      botCreature = createdBot.creature;
      botDisplayName = createdBot.displayName;
    } catch (err) {
      yield {
        status: "failed",
        error: `BotFather automation failed: ${(err as Error).message}`,
      };
      try {
        await signed?.client.disconnect();
      } catch {
        // ignore
      }
      return;
    }

    try {
      await persistBotMetadata(
        input.repoRoot,
        {
          token: botToken ?? undefined,
          username: botUsername ?? undefined,
          creature: botCreature ?? undefined,
          userId: telegramUserId ?? undefined,
        },
      );
    } catch (err) {
      yield {
        status: "failed",
        error: `Failed to save Telegram metadata: ${(err as Error).message}`,
      };
      try {
        await signed?.client.disconnect();
      } catch {
        // ignore
      }
      return;
    }

    try {
      await signed?.client.disconnect();
    } catch {
      // ignore
    }

    // Wire the token into OpenClaw's own config + pre-approve the
    // install user in allowFrom + restart the gateway so the bot
    // actually responds to Telegram messages from the user. Sub-step
    // failures are yielded as warnings only — the bot exists either
    // way, and users can recover with ./start.sh.
    yield* wireBotIntoOpenClaw(botToken, telegramUserId);

    yield {
      status: "succeeded",
      detail: `${botDisplayName} — https://t.me/${botUsername}`,
    };
  },
};
