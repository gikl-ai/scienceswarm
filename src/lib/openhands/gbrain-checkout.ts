import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  isPageFileRef,
  type OpenHandsCheckoutManifest,
} from "@/brain/gbrain-data-contracts";
import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import { ensureBrainStoreReady, getBrainStore, type BrainStore } from "@/brain/store";
import { listGbrainFileRefPages } from "@/lib/gbrain/file-ref-pages";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { frontmatterMatchesStudy } from "@/lib/studies/frontmatter";

export interface BuildGbrainCheckoutInput {
  project: string;
  createdBy: string;
  checkoutId?: string;
  store?: BrainStore;
  fileStore?: GbrainFileStore;
  now?: () => Date;
}

export async function buildGbrainCheckoutManifest(
  input: BuildGbrainCheckoutInput,
): Promise<OpenHandsCheckoutManifest> {
  const project = assertSafeProjectSlug(input.project);
  const store = input.store ?? await defaultStore();
  const pages = await listGbrainFileRefPages(store);
  const filesByPath = new Map<string, OpenHandsCheckoutManifest["files"][number]>();
  for (const page of pages) {
    if (!frontmatterMatchesStudy(page.frontmatter, project)) continue;
    const refs = Array.isArray(page.frontmatter.file_refs)
      ? page.frontmatter.file_refs.filter(isPageFileRef)
      : [];
    for (const ref of refs) {
      filesByPath.set(ref.filename, {
        relativePath: ref.filename,
        fileObjectId: ref.fileObjectId,
        sourceSlug: page.path.replace(/\.md$/i, ""),
        sha256: ref.sha256,
        writable: ref.role === "checkout_input" || ref.role === "source",
      });
    }
  }

  const files = Array.from(filesByPath.values())
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    checkoutId: input.checkoutId ?? randomUUID(),
    project,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    createdBy: input.createdBy,
    rootName: project,
    files,
  };
}

export async function materializeGbrainCheckout(input: {
  manifest: OpenHandsCheckoutManifest;
  targetDir: string;
  fileStore?: GbrainFileStore;
}): Promise<void> {
  const fileStore = input.fileStore ?? createGbrainFileStore();
  await fs.mkdir(input.targetDir, { recursive: true });
  for (const file of input.manifest.files) {
    const opened = await fileStore.openObjectStream(file.fileObjectId);
    if (!opened) {
      throw new Error(`Missing file object for checkout: ${file.fileObjectId}`);
    }
    const target = path.resolve(input.targetDir, file.relativePath);
    const root = path.resolve(input.targetDir);
    if (!target.startsWith(`${root}${path.sep}`) && target !== root) {
      throw new Error(`Checkout path escapes target directory: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(target, "w");
    try {
      const reader = opened.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await handle.write(Buffer.from(value));
      }
    } finally {
      await handle.close();
    }
  }
}

async function defaultStore(): Promise<BrainStore> {
  await ensureBrainStoreReady();
  return getBrainStore();
}
