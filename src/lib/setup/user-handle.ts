const USER_HANDLE_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;
const GENERATED_HANDLE_PREFIX = "researcher";

export function isValidUserHandle(value: unknown): value is string {
  return typeof value === "string" && USER_HANDLE_PATTERN.test(value);
}

export function createGeneratedUserHandle(seed = ""): string {
  const suffix = seed
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return suffix
    ? `${GENERATED_HANDLE_PREFIX}-${suffix}`
    : `${GENERATED_HANDLE_PREFIX}-local`;
}

export function createRandomUserHandle(): string {
  const random =
    globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36)}`;
  return createGeneratedUserHandle(random);
}
