#!/usr/bin/env -S node --experimental-strip-types

/**
 * check-design-drift.ts — scans the codebase for design-system drift.
 *
 * Modes:
 *   --warn  (default)  non-zero exit only on critical violations
 *   --error            any violation exits non-zero (enable after migration)
 *
 * What it looks for:
 *   1. Raw hex literals in .ts/.tsx/.css outside tokens/
 *   2. Tailwind color utilities referencing built-in palettes (bg-zinc-*,
 *      text-gray-*, border-blue-*, etc.) — these should be tokens.
 *   3. Banned font family strings (Geist, Inter, Roboto, Arial).
 *   4. Raw shadcn imports from application code (should use ss-* wrappers).
 *
 * Prints a grouped report. Each finding shows file:line + suggested fix.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Finding = { file: string; line: number; rule: string; text: string; hint: string };

const mode = process.argv.includes("--error") ? "error" : "warn";

const root = resolve(new URL("..", import.meta.url).pathname);

function gitLsFiles(): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

const BANNED_TAILWIND_COLORS = new Set([
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose", "slate", "gray", "zinc", "neutral", "stone",
]);

const RAW_HEX = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;
const TAILWIND_COLOR = /\b(bg|text|border|ring|divide|fill|stroke|placeholder|outline|decoration|shadow|from|via|to)-([a-z]+)-(50|[1-9]00)\b/;
const TAILWIND_COLOR_G = new RegExp(TAILWIND_COLOR.source, "g");
const BANNED_FONTS = /\b(Geist|Inter|Roboto|Arial|--font-geist)\b/;
const SHADCN_IMPORT = /from\s+["']@\/components\/ui\/([a-z0-9-]+)["']/;

const findings: Finding[] = [];

for (const f of gitLsFiles()) {
  if (f.startsWith("src/styles/tokens/")) continue;
  if (f === "scripts/check-design-drift.ts") continue;  // self-match on regex literals
  if (!/\.(ts|tsx|css|mjs)$/.test(f)) continue;

  // Raw shadcn wrappers are allowed to reference tailwind/hex colors
  // internally; only check them for banned fonts and raw-shadcn-import.
  const skipColorChecks =
    f.startsWith("src/components/ui/") && !f.includes("/ss-");
  // The banned-font check is a critical rule and would self-flag on this
  // script's own regex definition. Restrict it to shipping app code under
  // src/ — scripts/, tests/, docs are out of scope.
  const checkFonts = f.startsWith("src/");

  let body: string;
  try {
    body = readFileSync(resolve(root, f), "utf8");
  } catch {
    continue;
  }
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // skip comment-only violation mentions
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;

    if (!skipColorChecks && RAW_HEX.test(line)) {
      findings.push({
        file: f,
        line: i + 1,
        rule: "raw-hex",
        text: line.match(RAW_HEX)?.[0] ?? "",
        hint: "use a token from src/styles/tokens/semantic.css (var(--*))",
      });
    }
    if (!skipColorChecks) {
      // Scan every tailwind utility on the line, not just the first —
      // `className="bg-white text-zinc-500"` would otherwise miss the
      // second match.
      for (const tw of line.matchAll(TAILWIND_COLOR_G)) {
        if (BANNED_TAILWIND_COLORS.has(tw[2])) {
          findings.push({
            file: f,
            line: i + 1,
            rule: "raw-tailwind-color",
            text: tw[0],
            hint: `replace with a semantic utility (bg-raised, text-dim, border-rule, etc.)`,
          });
        }
      }
    }
    if (checkFonts && BANNED_FONTS.test(line)) {
      findings.push({
        file: f,
        line: i + 1,
        rule: "banned-font",
        text: line.match(BANNED_FONTS)?.[0] ?? "",
        hint: "fonts are set in src/app/layout.tsx — use var(--font-sans)/var(--font-mono)",
      });
    }
    // Application code should not import raw shadcn directly.
    // Layer 0 shadcn files live at src/components/ui/<name>.tsx,
    // Layer 1 wrappers at src/components/ui/ss-<name>.tsx.
    if (!f.startsWith("src/components/ui/")) {
      const m = line.match(SHADCN_IMPORT);
      if (m && !m[1].startsWith("ss-")) {
        findings.push({
          file: f,
          line: i + 1,
          rule: "raw-shadcn-import",
          text: m[0],
          hint: `import the ss-${m[1]} wrapper instead`,
        });
      }
    }
  }
}

if (findings.length === 0) {
  console.log("design-drift: clean (no violations found)");
  process.exit(0);
}

const byRule = new Map<string, Finding[]>();
for (const f of findings) {
  if (!byRule.has(f.rule)) byRule.set(f.rule, []);
  byRule.get(f.rule)!.push(f);
}

console.log(`\ndesign-drift: ${findings.length} finding(s) [${mode} mode]\n`);
for (const [rule, list] of byRule) {
  console.log(`── ${rule} (${list.length}) ────────────────────────────`);
  const sample = list.slice(0, 12);
  for (const f of sample) {
    console.log(`  ${f.file}:${f.line}  ${f.text}`);
  }
  if (list.length > sample.length) {
    console.log(`  … and ${list.length - sample.length} more`);
  }
  console.log(`  hint: ${list[0].hint}\n`);
}

// In warn mode, only exit non-zero on banned-font (critical) or
// raw-shadcn-import (architectural) violations. raw-hex and
// raw-tailwind-color are migration debt, reported but non-blocking
// until the migration PR completes.
const critical = findings.filter(
  (f) => f.rule === "banned-font" || f.rule === "raw-shadcn-import",
);

if (mode === "error" && findings.length > 0) {
  process.exit(1);
}
if (mode === "warn" && critical.length > 0) {
  console.log(`\n${critical.length} critical violation(s) — exiting 1.`);
  process.exit(1);
}
console.log(`\nnon-critical only — exiting 0 (run with --error to enforce).`);
process.exit(0);
