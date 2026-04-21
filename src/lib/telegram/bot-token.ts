export const TELEGRAM_BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{30,}$/;

export function isTelegramBotTokenShape(value: string): boolean {
  return TELEGRAM_BOT_TOKEN_REGEX.test(value);
}
