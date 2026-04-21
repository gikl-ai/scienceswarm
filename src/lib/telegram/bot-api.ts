import { randomBytes } from "node:crypto";

export interface TelegramBotUser {
  id: number;
  username?: string;
  first_name: string;
}

export interface TelegramWebhookInfo {
  url: string;
  pending_update_count?: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    from?: {
      id?: number;
    };
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export class TelegramBotApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = "TelegramBotApiError";
  }

  get unauthorized(): boolean {
    return this.errorCode === 401;
  }

  get conflict(): boolean {
    return this.errorCode === 409;
  }
}

function methodUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function requestBotApi<T>(
  token: string,
  method: string,
  params?: Record<
    string,
    string | number | boolean | readonly string[] | undefined
  >,
): Promise<T> {
  const url = new URL(methodUrl(token, method));
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(
      key,
      Array.isArray(value) ? JSON.stringify(value) : String(value),
    );
  }

  const response = await fetch(url);
  let body: TelegramApiResponse<T>;
  try {
    body = (await response.json()) as TelegramApiResponse<T>;
  } catch {
    throw new TelegramBotApiError(
      `Telegram Bot API ${method} returned HTTP ${response.status}`,
      response.status,
    );
  }

  if (!response.ok || !body.ok) {
    throw new TelegramBotApiError(
      body.description ??
        `Telegram Bot API ${method} failed with HTTP ${response.status}`,
      body.error_code ?? response.status,
    );
  }
  if (body.result === undefined) {
    throw new TelegramBotApiError(
      `Telegram Bot API ${method} returned no result`,
      body.error_code,
    );
  }
  return body.result;
}

export async function getMe(token: string): Promise<TelegramBotUser> {
  return requestBotApi<TelegramBotUser>(token, "getMe");
}

export async function getWebhookInfo(
  token: string,
): Promise<TelegramWebhookInfo> {
  return requestBotApi<TelegramWebhookInfo>(token, "getWebhookInfo");
}

export async function deleteWebhook(
  token: string,
  dropPendingUpdates = false,
): Promise<void> {
  await requestBotApi<boolean>(token, "deleteWebhook", {
    drop_pending_updates: dropPendingUpdates,
  });
}

export async function getUpdates(
  token: string,
  params: {
    offset?: number;
    timeout?: number;
    allowed_updates?: readonly string[];
  } = {},
): Promise<TelegramUpdate[]> {
  return requestBotApi<TelegramUpdate[]>(token, "getUpdates", {
    ...params,
  });
}

export function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function buildStartDeeplink(botUsername: string, nonce: string): string {
  const username = botUsername.replace(/^@/, "");
  const url = new URL(`https://t.me/${username}`);
  url.searchParams.set("start", nonce);
  return url.toString();
}
