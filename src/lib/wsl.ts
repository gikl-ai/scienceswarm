import os from "node:os";

export function isWslEnvironment(options?: {
  platform?: NodeJS.Platform;
  release?: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const platform = options?.platform ?? process.platform;
  if (platform !== "linux") return false;

  const env = options?.env ?? process.env;
  if (env.WSL_INTEROP || env.WSL_DISTRO_NAME) {
    return true;
  }

  const release = (options?.release ?? os.release()).toLowerCase();
  return release.includes("microsoft");
}

export function isMountedWindowsPath(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().replace(/\\/g, "/");
  return /^\/mnt\/[a-z](?:\/|$)/i.test(normalized);
}
