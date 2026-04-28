#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DESKTOP_SIGNING_TARGETS = ["macos", "windows", "linux"];

const TARGET_ALIASES = new Map([
  ["darwin", "macos"],
  ["mac", "macos"],
  ["macos", "macos"],
  ["osx", "macos"],
  ["win32", "windows"],
  ["windows", "windows"],
  ["windows_nt", "windows"],
  ["linux", "linux"],
]);

export const DESKTOP_SIGNING_REQUIREMENTS = {
  macos: [
    {
      name: "Apple Developer account",
      variables: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
    },
    {
      name: "macOS signing certificate",
      anyOf: [
        ["CSC_LINK", "CSC_KEY_PASSWORD"],
        ["MAC_CSC_LINK", "MAC_CSC_KEY_PASSWORD"],
      ],
    },
  ],
  windows: [
    {
      name: "Windows signing certificate",
      anyOf: [
        ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
        ["CSC_LINK", "CSC_KEY_PASSWORD"],
      ],
    },
  ],
  linux: [],
};

export function isTruthyEnvValue(value) {
  return /^(1|true|yes|on|required)$/i.test(String(value ?? "").trim());
}

export function normalizeDesktopSigningTarget(rawTarget) {
  const target = String(rawTarget ?? "").trim().toLowerCase();
  if (target.startsWith("macos-")) return "macos";
  if (target.startsWith("windows-")) return "windows";
  if (target.startsWith("ubuntu-")) return "linux";
  return TARGET_ALIASES.get(target) ?? null;
}

export function resolveDesktopSigningTarget(env = process.env, platform = process.platform) {
  const explicitTarget = normalizeDesktopSigningTarget(env.SCIENCESWARM_DESKTOP_SIGNING_TARGET);
  if (explicitTarget) {
    return explicitTarget;
  }

  const runnerTarget = normalizeDesktopSigningTarget(env.RUNNER_OS);
  if (runnerTarget) {
    return runnerTarget;
  }

  return normalizeDesktopSigningTarget(platform);
}

function missingVariablesForGroup(group, env) {
  return group.filter((name) => !String(env[name] ?? "").trim());
}

export function getMissingDesktopSigningRequirements(target, env = process.env) {
  const normalizedTarget = normalizeDesktopSigningTarget(target);
  if (!normalizedTarget) {
    throw new Error(`Unsupported desktop signing target: ${target}`);
  }

  const missing = [];
  for (const requirement of DESKTOP_SIGNING_REQUIREMENTS[normalizedTarget]) {
    if (requirement.variables) {
      const variables = missingVariablesForGroup(requirement.variables, env);
      if (variables.length > 0) {
        missing.push({
          name: requirement.name,
          variables,
        });
      }
      continue;
    }

    const satisfied = requirement.anyOf.some((group) =>
      missingVariablesForGroup(group, env).length === 0,
    );
    if (!satisfied) {
      missing.push({
        name: requirement.name,
        variables: requirement.anyOf.map((group) => group.join(" + ")),
      });
    }
  }

  return missing;
}

export function checkDesktopSigningEnv(options = {}) {
  const env = options.env ?? process.env;
  const target = options.target ?? resolveDesktopSigningTarget(env, options.platform);
  const requireSigning = isTruthyEnvValue(env.SCIENCESWARM_REQUIRE_DESKTOP_SIGNING);

  if (!target) {
    return {
      ok: true,
      reason: "unsupported-platform",
      requireSigning,
      target: null,
      missing: [],
    };
  }

  const missing = getMissingDesktopSigningRequirements(target, env);
  return {
    ok: !requireSigning || missing.length === 0,
    reason: requireSigning ? "required" : "optional",
    requireSigning,
    target,
    missing,
  };
}

export function formatDesktopSigningEnvResult(result) {
  if (!result.target) {
    return "Desktop signing check skipped: unsupported platform.";
  }

  if (!result.requireSigning) {
    return `Desktop signing check optional for ${result.target}; unsigned installer builds are allowed.`;
  }

  if (result.ok) {
    return `Desktop signing environment ready for ${result.target}.`;
  }

  const missingLines = result.missing.map((requirement) =>
    `- ${requirement.name}: ${requirement.variables.join(" or ")}`,
  );
  return [
    `Desktop signing is required for ${result.target}, but required secrets are missing.`,
    ...missingLines,
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDesktopSigningEnv();
  const message = formatDesktopSigningEnvResult(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
