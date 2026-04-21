import { getCurrentLlmRuntimeEnv } from "@/lib/runtime-saved-env";

export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isStrictLocalOnlyEnabled(
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv,
): boolean {
  if (!env) {
    return getCurrentLlmRuntimeEnv(process.env).strictLocalOnly;
  }
  return isTruthyEnvFlag(env.SCIENCESWARM_STRICT_LOCAL_ONLY);
}
