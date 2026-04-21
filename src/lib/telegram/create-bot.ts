/**
 * Drive @BotFather through /newbot. Given a logged-in gramjs client
 * and a handle, returns the token + bot username + chosen creature.
 * Retries username collisions by appending a random suffix and
 * rerolling the creature on the last attempt.
 *
 * The conversation:
 *   user: /newbot
 *   bot:  "Alright, a new bot. How are we going to call it?"
 *   user: Wobblefinch — your ScienceSwarm claw
 *   bot:  "Good. Now let's choose a username..."
 *   user: wobblefinch_alice_bot
 *   bot:  "Done! ... Use this token to access the HTTP API: <TOKEN>"
 *
 * We read replies by polling `client.getMessages(botUsername, { limit: N })`
 * — simpler than subscribing to updates, and the whole dance completes
 * in under 2 seconds so polling latency is fine.
 */

import { Api, type TelegramClient } from "telegram";
import { parseBotFatherReply } from "./botfather-parser";
import { BOTFATHER_USERNAME } from "./constants";
import {
  randomCreature,
  creatureDisplayName,
  creatureUsername,
} from "./creature-names";

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

const BOTFATHER_NUMERIC_ID = "93372553";

async function getMyId(client: TelegramClient): Promise<string> {
  const me = await client.getMe();
  // gramjs returns an Api.User with an id; cast through unknown to
  // extract without pulling in the full Api namespace types.
  const id = (me as unknown as { id: { toString(): string } }).id;
  return id.toString();
}

async function resolveBotFatherFromDialogs(
  client: TelegramClient,
): Promise<Api.User | null> {
  const dialogs = await client.getDialogs({ limit: 50 });
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!(entity instanceof Api.User)) continue;
    const username = entity.username?.toLowerCase();
    if (username === BOTFATHER_USERNAME.toLowerCase()) {
      return entity;
    }
    if (String(entity.id) === BOTFATHER_NUMERIC_ID) {
      return entity;
    }
  }
  return null;
}

/**
 * Resolve the BotFather peer for a brand-new Telegram account that
 * has never interacted with BotFather before.
 *
 * Primary path: call `contacts.ResolveUsername` directly so a fresh
 * account with no local cache still receives a full `Api.User`
 * carrying BotFather's access_hash.
 *
 * Fallback path: some frozen / heavily restricted Telegram accounts
 * reject username lookup with surprising errors like
 * `USERNAME_NOT_OCCUPIED` or `FROZEN_METHOD_INVALID` even though the
 * user already has a BotFather chat in their dialog list. In that
 * case we reuse the cached dialog entity instead of failing the whole
 * onboarding flow.
 */
async function resolveBotFatherEntity(
  client: TelegramClient,
): Promise<Api.User> {
  let resolved;
  let resolveError: Error | null = null;
  try {
    resolved = await client.invoke(
      new Api.contacts.ResolveUsername({ username: BOTFATHER_USERNAME }),
    );
  } catch (err) {
    resolveError = err as Error;
    try {
      const cached = await resolveBotFatherFromDialogs(client);
      if (cached) {
        return cached;
      }
    } catch {
      // Ignore fallback probe errors; we'll surface the original
      // username-resolution failure below with extra guidance.
    }
    const message = resolveError.message || String(resolveError);
    const cachedDialogHint =
      /USERNAME_NOT_OCCUPIED|FROZEN_METHOD_INVALID/i.test(message)
        ? ` This Telegram account appears to block username lookup. Open a BotFather chat manually in Telegram once, then retry so ScienceSwarm can reuse the cached dialog.`
        : "";
    throw new Error(
      `contacts.ResolveUsername("${BOTFATHER_USERNAME}") failed: ${message}. ` +
        `If the message mentions FLOOD_WAIT, Telegram is rate-limiting this account — wait the indicated seconds or use a different account.${cachedDialogHint} ` +
        `Otherwise BotFather may be temporarily unavailable on Telegram's side.`,
    );
  }

  const user = resolved.users.find(
    (u): u is Api.User => u instanceof Api.User,
  );
  if (!user) {
    throw new Error(
      `contacts.ResolveUsername("${BOTFATHER_USERNAME}") returned no User. ` +
        `This should never happen for a real Telegram bot. ` +
        `users[]=${JSON.stringify(resolved.users.map((u) => u.className))}`,
    );
  }
  return user;
}

async function sendAndWait(
  client: TelegramClient,
  botFatherPeer: Api.User,
  text: string,
  predicate: (reply: string) => boolean,
  myId: string,
  timeoutMs = 8000,
): Promise<string> {
  // Snapshot the latest message id BEFORE sending so we never parse
  // our own prompt as if it were a reply.
  //
  // We pass the pre-resolved Api.User (from resolveBotFatherEntity)
  // as the peer. gramjs accepts an Api.User directly and uses its
  // embedded access_hash to build an InputPeerUser without ever
  // calling getInputEntity — which is exactly what we want on a
  // fresh account whose local cache doesn't know BotFather.
  const before = await client.getMessages(botFatherPeer, { limit: 1 });
  const lastSeenId = before[0]?.id ?? 0;
  await client.sendMessage(botFatherPeer, { message: text });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await client.getMessages(botFatherPeer, { limit: 5 });
    for (const msg of msgs) {
      if (msg.id <= lastSeenId) continue;
      const senderId = msg.senderId?.toString();
      if (senderId === myId) continue;
      const body = msg.message ?? "";
      if (predicate(body)) return body;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Timed out waiting for BotFather reply (last sent: "${text}")`,
  );
}

export interface CreateBotResult {
  token: string;
  username: string;
  creature: string;
  displayName: string;
}

export async function createBotViaBotFather(
  client: TelegramClient,
  handle: string,
): Promise<CreateBotResult> {
  const myId = await getMyId(client);
  // Resolve the BotFather peer exactly once, up front, with the
  // @username → numeric-id fallback ladder. Every subsequent
  // getMessages/sendMessage call uses the resolved entity, so we
  // never hit contacts.ResolveUsername on the hot path.
  const botFatherPeer = await resolveBotFatherEntity(client);
  const creature = randomCreature();
  const displayName = creatureDisplayName(creature);

  // Step 1: /newbot
  await sendAndWait(
    client,
    botFatherPeer,
    "/newbot",
    (reply) => parseBotFatherReply(reply).state === "needs-name",
    myId,
  );

  // Step 2: send display name (committed to BotFather — we cannot
  // change `creature` after this point without desyncing the
  // already-submitted display name).
  await sendAndWait(
    client,
    botFatherPeer,
    displayName,
    (reply) => parseBotFatherReply(reply).state === "needs-username",
    myId,
  );

  // Step 3: username — retry on collision up to 5 times. First attempt
  // uses the bare `<creature>_<handle>_bot`; later attempts append a
  // random suffix. We deliberately do NOT reroll the creature on later
  // attempts: displayName is already committed to BotFather, so a
  // different creature in the username would produce a headline
  // ("Wobblefinch") that doesn't match the username prefix
  // ("snarflepuff_..."), which would be confusing in the UI.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = attempt === 0 ? "" : randomSuffix();
    const username = creatureUsername(creature, handle, suffix);
    const reply = await sendAndWait(
      client,
      botFatherPeer,
      username,
      (r) => {
        const st = parseBotFatherReply(r).state;
        return (
          st === "done" || st === "username-taken" || st === "username-invalid"
        );
      },
      myId,
    );
    const parsed = parseBotFatherReply(reply);
    if (parsed.state === "done") {
      return {
        token: parsed.token,
        username: parsed.username,
        creature,
        displayName,
      };
    }
    if (parsed.state === "username-taken") continue;
    if (parsed.state === "username-invalid") {
      throw new Error(`BotFather rejected username "${username}" as invalid.`);
    }
  }
  throw new Error(
    "Exhausted retries for bot username — all candidates were taken.",
  );
}
