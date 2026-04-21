/**
 * ScienceSwarm Telegram application credentials.
 *
 * These are a single shared pair registered once at
 * https://my.telegram.org by the maintainer (see
 * scripts/register-telegram-app.md). Baking them into open-source is
 * standard practice for Telegram clients — users can override via
 * env vars if they'd rather not share.
 *
 * If Telegram ever revokes this app for abuse, users can recover by
 * registering their own and exporting `SCIENCESWARM_TELEGRAM_API_ID` /
 * `SCIENCESWARM_TELEGRAM_API_HASH` in their environment.
 */

const API_ID_OVERRIDE = process.env.SCIENCESWARM_TELEGRAM_API_ID;
const API_HASH_OVERRIDE = process.env.SCIENCESWARM_TELEGRAM_API_HASH;

// Registered at my.telegram.org by the maintainer on 2026-04-14 for
// the ScienceSwarm Telegram bot-creation flow.
const DEFAULT_API_ID = 33937183;
const DEFAULT_API_HASH = "86a4d3a3e01aef35de450171fadc4bf6";

export function getTelegramApiId(): number {
  if (API_ID_OVERRIDE && Number(API_ID_OVERRIDE) > 0) {
    return Number(API_ID_OVERRIDE);
  }
  return DEFAULT_API_ID;
}

export function getTelegramApiHash(): string {
  if (API_HASH_OVERRIDE && API_HASH_OVERRIDE.trim().length > 0) {
    return API_HASH_OVERRIDE.trim();
  }
  return DEFAULT_API_HASH;
}

export function telegramCredentialsConfigured(): boolean {
  return getTelegramApiId() > 0 && getTelegramApiHash().length > 0;
}

export const BOTFATHER_USERNAME = "BotFather";
