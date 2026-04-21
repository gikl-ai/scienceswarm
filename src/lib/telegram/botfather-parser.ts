/**
 * Pure parser for @BotFather replies during the /newbot conversation.
 * Every branch is a text-match — BotFather's wording is stable and
 * well-documented (https://core.telegram.org/bots/tutorial).
 *
 * If BotFather ever changes a phrase, these patterns need updating.
 * The parser is tested against a fixed corpus in
 * tests/setup/botfather-parser.test.ts so regressions surface fast.
 */

export type BotFatherState =
  | { state: "needs-name" }
  | { state: "needs-username" }
  | { state: "username-taken" }
  | { state: "username-invalid" }
  | { state: "done"; token: string; username: string }
  | { state: "unknown" };

// Telegram bot tokens are `<numeric id>:<25+ base64url-ish chars>`.
// The ID part is typically 8-10 digits but we accept 6-15 to be safe.
const TOKEN_PATTERN = /\b(\d{6,15}:[A-Za-z0-9_-]{20,})\b/;
// Match every t.me/<username> mention in the reply — BotFather's
// success message sometimes contains multiple links (support link,
// docs, the new bot itself). We pick the first one whose username
// ends in `bot` (Telegram requires bot usernames to end in `bot`),
// which is the newly-created bot rather than @BotFather or any other
// organizational link.
const USERNAME_GLOBAL_PATTERN = /t\.me\/([A-Za-z0-9_]+)/g;

function extractBotUsername(text: string): string | null {
  const matches = [...text.matchAll(USERNAME_GLOBAL_PATTERN)];
  if (matches.length === 0) return null;
  const botMatch = matches.find(
    (m) => m[1] && m[1].toLowerCase().endsWith("bot"),
  );
  return botMatch ? botMatch[1] : null;
}

export function parseBotFatherReply(text: string): BotFatherState {
  const normalized = text.toLowerCase();

  if (
    /how are we going to call it|choose a name for your bot/.test(normalized)
  ) {
    return { state: "needs-name" };
  }
  if (/choose a username/.test(normalized) && /end in .?bot/.test(normalized)) {
    return { state: "needs-username" };
  }
  if (/already taken/.test(normalized)) {
    return { state: "username-taken" };
  }
  if (/username must end in .?bot|sorry.*username/.test(normalized)) {
    return { state: "username-invalid" };
  }

  const tokenMatch = TOKEN_PATTERN.exec(text);
  const username = extractBotUsername(text);
  if (
    tokenMatch &&
    username &&
    /done.*new bot|congratulations/.test(normalized)
  ) {
    return { state: "done", token: tokenMatch[1], username };
  }
  return { state: "unknown" };
}
