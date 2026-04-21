#!/usr/bin/env npx tsx
/**
 * import-pdfs — Convert PDFs to markdown via Docling and import into gbrain.
 *
 * Usage:
 *   npx tsx scripts/import-pdfs.ts ~/Documents/papers
 *   npx tsx scripts/import-pdfs.ts ~/Documents/papers --skip-import
 *   npm run import-pdfs -- ~/Documents/papers
 */

import { resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import {
  checkDoclingInstalled,
  convertAndImportPdfs,
} from "../src/brain/pdf-to-markdown";

function die(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function info(message: string) {
  console.log(`  → ${message}`);
}

function success(message: string) {
  console.log(`  ✓ ${message}`);
}

function expandPath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

async function main() {
  console.log("\n  import-pdfs — Convert PDFs and import into gbrain\n");

  // Parse args
  const args = process.argv.slice(2);
  const pdfDir = args.find((a) => !a.startsWith("--"));
  const skipImport = args.includes("--skip-import");

  if (!pdfDir) {
    die(
      "Usage: npx tsx scripts/import-pdfs.ts <pdf-directory> [--skip-import]\n" +
        "  Example: npx tsx scripts/import-pdfs.ts ~/Documents/papers",
    );
  }

  const resolvedDir = expandPath(pdfDir);
  if (!existsSync(resolvedDir)) {
    die(`Directory not found: ${resolvedDir}`);
  }

  // 1. Check Docling
  info("Checking Docling installation...");
  const check = await checkDoclingInstalled();
  if (!check.ok) {
    die(
      `${check.error}\n\n` +
        "  Install Docling with:\n" +
        "    pip install docling",
    );
  }
  success(`Docling ${check.version ?? ""} found`);

  // 2. Run pipeline
  info(`Processing PDFs from ${resolvedDir}`);

  const result = await convertAndImportPdfs(resolvedDir, {
    skipImport,
    onProgress: (status) => {
      info(`[${status.phase}] ${status.current}/${status.total} — ${status.file}`);
    },
  });

  // 3. Report
  console.log("");
  success(`Converted: ${result.converted} PDFs → markdown`);

  if (!skipImport) {
    success(`Imported: ${result.imported} pages into gbrain`);
  } else {
    info("Import skipped (--skip-import). Staging dir:");
    info(`  ${result.stagingDir}`);
  }

  if (result.failed.length > 0) {
    console.log(`\n  ⚠ ${result.failed.length} failed:`);
    for (const f of result.failed) {
      console.log(`    - ${f.path}: ${f.error}`);
    }
  }

  const seconds = (result.durationMs / 1000).toFixed(1);
  console.log(`\n  Done in ${seconds}s.\n`);
}

main().catch((e) => die(String(e)));
