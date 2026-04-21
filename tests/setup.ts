import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

// Keys to preserve because they are often needed by Node or test runners
const PRESERVE_KEYS = new Set([
  "NODE_ENV",
  "PATH",
  "PWD",
  "HOME",
  "TMPDIR",
  "USER",
  "LANG"
]);

beforeEach(() => {
  // Clear all environment variables from the real process.env
  // to prevent leaking the local .env into tests, but keep
  // system-critical ones.
  for (const key in process.env) {
    if (!PRESERVE_KEYS.has(key)) {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  
  // Restore original env
  for (const key in process.env) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});
