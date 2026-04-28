import path from "node:path";
import { z } from "zod";

import {
  PaperIngestManifestSchema,
  PaperProvenanceLedgerRecordSchema,
  type PaperIngestManifest,
  type PaperProvenanceLedgerRecord,
} from "./contracts";
import {
  getPaperLibraryStateDir,
  parsePersistedState,
  readPersistedState,
  writePersistedState,
  type ParsePersistedStateRepairable,
  type ParsePersistedStateResult,
} from "../state";

export const PAPER_CORPUS_STATE_DIR = "corpus";
const PaperIngestManifestStateSchema = PaperIngestManifestSchema as z.ZodType<PaperIngestManifest>;

export function getPaperCorpusStateDir(project: string, stateRoot?: string): string {
  return path.join(getPaperLibraryStateDir(project, stateRoot), PAPER_CORPUS_STATE_DIR);
}

export function getPaperCorpusManifestPath(project: string, manifestId: string, stateRoot?: string): string {
  return path.join(getPaperCorpusStateDir(project, stateRoot), "manifests", `${encodeURIComponent(manifestId)}.json`);
}

export function getPaperCorpusManifestByScanPath(project: string, scanId: string, stateRoot?: string): string {
  return path.join(getPaperCorpusStateDir(project, stateRoot), "by-scan", `${encodeURIComponent(scanId)}.json`);
}

export function getPaperCorpusPaperProvenancePath(project: string, paperSlug: string, stateRoot?: string): string {
  return path.join(
    getPaperCorpusStateDir(project, stateRoot),
    "provenance",
    `${encodeURIComponent(paperSlug)}.json`,
  );
}

export function parsePaperCorpusManifest(
  value: unknown,
  options: { path?: string } = {},
): ParsePersistedStateResult<PaperIngestManifest> | ParsePersistedStateRepairable {
  return parsePersistedState(value, PaperIngestManifestStateSchema, {
    kind: "paper corpus manifest",
    path: options.path,
  });
}

export async function readPaperCorpusManifest(
  project: string,
  manifestId: string,
  stateRoot?: string,
): Promise<ParsePersistedStateResult<PaperIngestManifest> | ParsePersistedStateRepairable> {
  const filePath = getPaperCorpusManifestPath(project, manifestId, stateRoot);
  return readPersistedState(filePath, PaperIngestManifestStateSchema, "paper corpus manifest");
}

export async function writePaperCorpusManifest(
  project: string,
  manifest: PaperIngestManifest,
  stateRoot?: string,
): Promise<PaperIngestManifest> {
  const filePath = getPaperCorpusManifestPath(project, manifest.id, stateRoot);
  return writePersistedState(filePath, PaperIngestManifestStateSchema, manifest);
}

export type PaperProvenanceLedger = PaperProvenanceLedgerRecord[];
const PaperProvenanceLedgerSchema = z.array(PaperProvenanceLedgerRecordSchema) as z.ZodType<PaperProvenanceLedger>;

export function parsePaperProvenanceLedger(
  value: unknown,
  options: { path?: string } = {},
): ParsePersistedStateResult<PaperProvenanceLedger> | ParsePersistedStateRepairable {
  return parsePersistedState(value, PaperProvenanceLedgerSchema, {
    kind: "paper corpus provenance ledger",
    path: options.path,
  });
}

export async function readPaperProvenanceLedger(
  project: string,
  paperSlug: string,
  stateRoot?: string,
): Promise<ParsePersistedStateResult<PaperProvenanceLedger> | ParsePersistedStateRepairable> {
  const filePath = getPaperCorpusPaperProvenancePath(project, paperSlug, stateRoot);
  return readPersistedState(filePath, PaperProvenanceLedgerSchema, "paper corpus provenance ledger");
}

export async function writePaperProvenanceLedger(
  project: string,
  paperSlug: string,
  records: readonly PaperProvenanceLedgerRecord[],
  stateRoot?: string,
): Promise<PaperProvenanceLedger> {
  const filePath = getPaperCorpusPaperProvenancePath(project, paperSlug, stateRoot);
  return writePersistedState(filePath, PaperProvenanceLedgerSchema, [...records]);
}
