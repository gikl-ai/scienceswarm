#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

export function isFastTest(filePath) {
  return /(^|\/)[^/]+\.(test|spec)\.[cm]?[tj]sx?$/.test(filePath);
}

export function isSourceFile(filePath) {
  return (
    /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(filePath) &&
    !filePath.endsWith(".d.ts") &&
    !isFastTest(filePath)
  );
}

export function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

export function run(command, args) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

export function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

export function changedFiles() {
  const event = readEvent();
  const baseSha = event.pull_request?.base?.sha ?? process.env.GITHUB_BASE_SHA;
  const headSha = event.pull_request?.head?.sha ?? process.env.GITHUB_SHA ?? "HEAD";

  if (!baseSha) {
    console.log("No pull request base SHA found; running fast suite.");
    run("npm", ["run", "test:fast"]);
    return [];
  }

  return output("git", [
    "diff",
    "--name-only",
    "--diff-filter=ACMRT",
    `${baseSha}...${headSha}`,
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function main() {
  const files = changedFiles();
  const changedTests = files.filter(isFastTest);
  const changedSources = files.filter(isSourceFile);

  console.log(`Changed test files: ${changedTests.length}`);
  console.log(`Changed source files: ${changedSources.length}`);

  if (changedTests.length === 0 && changedSources.length === 0) {
    console.log("No changed source or test files need related Vitest coverage.");
    process.exit(0);
  }

  if (changedTests.length > 0) {
    run("npx", [
      "vitest",
      "run",
      "--config",
      "vitest.fast.config.ts",
      "--passWithNoTests",
      ...changedTests,
    ]);
  }

  if (changedSources.length > 0) {
    run("npx", [
      "vitest",
      "related",
      "--run",
      "--config",
      "vitest.fast.config.ts",
      "--passWithNoTests",
      ...changedSources,
    ]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
