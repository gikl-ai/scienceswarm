/**
 * Two-step gramjs sign-in wrapper.
 *
 * Step 1: `sendCode(phone)` opens a client, calls `client.start`, and
 * returns a `sessionId` once gramjs has asked for the phone code.
 * The call is paused inside a Promise that resolves when step 2 feeds
 * a code into it.
 *
 * Step 2: `submitCode(sessionId, code)` resumes step 1, finishes the
 * login, and returns the connected client + session string for
 * persistence.
 *
 * Sessions live in process memory. If the server restarts between
 * step 1 and step 2, the user has to re-enter their phone. This is
 * acceptable for a 1-minute interactive flow.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

import { getTelegramApiId, getTelegramApiHash } from "./constants";

interface PendingSession {
  client: TelegramClient;
  codeResolver: (value: string) => void;
  signInComplete: Promise<void>;
  getStartError: () => Error | null;
}

const sessions = new Map<string, PendingSession>();

function newId(): string {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

/**
 * Start a sign-in flow. Returns a `sessionId` the caller uses to submit
 * the code in a subsequent call.
 */
export async function sendCode(phone: string): Promise<{ sessionId: string }> {
  const apiId = getTelegramApiId();
  const apiHash = getTelegramApiHash();
  if (apiId === 0 || apiHash.length === 0) {
    throw new Error(
      "ScienceSwarm Telegram credentials not configured. See scripts/register-telegram-app.md.",
    );
  }

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
    deviceModel: "ScienceSwarm",
    appVersion: "1.0.0",
  });

  const sessionId = newId();
  let codeResolver!: (value: string) => void;
  const codePromise = new Promise<string>((r) => (codeResolver = r));

  // Kick off the login but do not await it yet — it will block inside
  // phoneCode() until step 2 calls submitCode(). Attach a `.catch` so
  // an abandoned flow (user never submits the code, or gramjs times
  // out / the network drops) doesn't surface as an unhandled promise
  // rejection. The error is stored on the pending session so
  // `submitCode` can re-throw it to the caller when the flow resumes.
  let startError: Error | null = null;
  const signInComplete = client
    .start({
      phoneNumber: async () => phone,
      phoneCode: async () => codePromise,
      onError: (err) => {
        startError = err instanceof Error ? err : new Error(String(err));
        throw err;
      },
    })
    .catch((err: unknown) => {
      startError = err instanceof Error ? err : new Error(String(err));
    });

  sessions.set(sessionId, {
    client,
    codeResolver,
    signInComplete,
    getStartError: () => startError,
  });

  // Brief yield so gramjs has a chance to dispatch the auth.sendCode
  // RPC before we return. The SMS is already on its way by the time
  // the caller gets the sessionId.
  await new Promise((r) => setTimeout(r, 50));

  return { sessionId };
}

export interface SignInResult {
  client: TelegramClient;
  sessionString: string;
}

export async function submitCode(
  sessionId: string,
  code: string,
): Promise<SignInResult> {
  const pending = sessions.get(sessionId);
  if (!pending) {
    throw new Error(`Unknown session ${sessionId}. Request a new code.`);
  }
  pending.codeResolver(code);
  await pending.signInComplete;
  // If gramjs rejected the start chain (bad code, network drop,
  // timeout) we stored the error on the pending session rather than
  // letting the rejection escape. Re-throw it here so the caller
  // sees the actual reason.
  const startError = pending.getStartError();
  if (startError) {
    sessions.delete(sessionId);
    throw startError;
  }
  const sessionString = (pending.client.session as StringSession).save();
  sessions.delete(sessionId);
  return { client: pending.client, sessionString };
}

export async function abortSession(sessionId: string): Promise<void> {
  const pending = sessions.get(sessionId);
  if (!pending) return;
  try {
    await pending.client.disconnect();
  } catch {
    // ignore
  }
  sessions.delete(sessionId);
}
