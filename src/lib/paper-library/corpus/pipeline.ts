import { readdir } from "node:fs/promises";
import path from "node:path";

import { shouldSkipImportDirectory, shouldSkipImportFile } from "@/lib/import/ignore";
import type { PaperReviewItem } from "../contracts";
import { buildPaperCorpusManifest } from "./source-inventory";
import { writePaperCorpusManifestByScan } from "./state";

function isSourceSidecar(name: string): boolean {
  const extension = path.posix.extname(name.toLowerCase());
  return extension === ".tex" || extension === ".html" || extension === ".htm";
}

async function walkSourceSidecars(rootRealpath: string, current: string, sidecars: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (!shouldSkipImportDirectory(entry.name)) {
        await walkSourceSidecars(rootRealpath, absolutePath, sidecars);
      }
      continue;
    }
    if (!entry.isFile() || shouldSkipImportFile(entry.name) || !isSourceSidecar(entry.name)) continue;
    sidecars.push(path.relative(rootRealpath, absolutePath).replaceAll(path.sep, "/"));
  }
}

export async function listPaperCorpusSourceSidecars(rootRealpath: string): Promise<string[]> {
  const sidecars: string[] = [];
  await walkSourceSidecars(rootRealpath, rootRealpath, sidecars);
  return sidecars.sort((left, right) => left.localeCompare(right));
}

export async function writePaperCorpusManifestForScan(input: {
  project: string;
  scanId: string;
  rootRealpath: string;
  createdAt: string;
  updatedAt: string;
  items: readonly PaperReviewItem[];
  stateRoot: string;
}) {
  const includedItems = input.items.filter((item) => item.state !== "ignored");
  const manifest = buildPaperCorpusManifest({
    id: `corpus-${input.scanId}`,
    project: input.project,
    scanId: input.scanId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    items: includedItems,
    sidecarRelativePaths: await listPaperCorpusSourceSidecars(input.rootRealpath),
  });
  return writePaperCorpusManifestByScan(input.project, input.scanId, manifest, input.stateRoot);
}
