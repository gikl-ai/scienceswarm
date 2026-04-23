interface LlmTimeoutOptions {
  defaultMs: number;
  envVar: string;
  stage: string;
}

export async function withLlmTimeout<T>(
  promise: Promise<T>,
  options: LlmTimeoutOptions,
): Promise<T> {
  const timeoutMs = getConfiguredTimeoutMs(options.envVar, options.defaultMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Current coldstart LLM/ripple calls do not accept AbortSignal. The
      // timeout bounds UI/API progress, but cannot cancel provider work that
      // has already started.
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${options.stage} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getConfiguredTimeoutMs(envVar: string, defaultMs: number): number {
  const raw = process.env[envVar];
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultMs;
  }
  return Math.max(100, Math.floor(parsed));
}
