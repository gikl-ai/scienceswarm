import crypto, { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename } from "node:fs/promises";
import path from "node:path";

import {
  ApplyIdempotencyRecordSchema,
  ApplyManifestOperationShardSchema,
  ApplyManifestSchema,
  ApplyOperationShardSchema,
  ApplyPlanSchema,
  PAPER_LIBRARY_STATE_VERSION,
  type ApplyManifest,
  type ApplyManifestOperation,
  type ApplyOperation,
  type ApplyPlan,
  type PaperIdentityCandidate,
  type PaperReviewItem,
} from "./contracts";
import { buildAppliedPaperMetadata } from "./applied-metadata";
import {
  compareSnapshot,
  isPathInsideRoot,
  snapshotFile,
  validateRelativeDestination,
} from "./fs-safety";
import { readAllPaperReviewItems } from "./review";
import {
  getPaperLibraryApplyIdempotencyPath,
  getPaperLibraryApplyOperationShardPath,
  getPaperLibraryApplyPlanPath,
  getPaperLibraryManifestOperationShardPath,
  getPaperLibraryManifestPath,
  readCursorWindow,
  readPersistedState,
} from "./state";
import { renderRenameTemplate, type TemplateValues } from "./templates";
import { updatePaperLibraryScan } from "./jobs";
import { readJsonFile, writeJsonFile } from "@/lib/state/atomic-json";
import { getProjectStateRootForBrainRoot } from "@/lib/state/project-storage";

const APPLY_SHARD_SIZE = 250;
const APPROVAL_TTL_MS = 30 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function hashJson(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeApplyPlan(value: unknown): ApplyPlan {
  const parsed = ApplyPlanSchema.parse(value);
  return {
    ...parsed,
    operationShardIds: parsed.operationShardIds ?? [],
  } as ApplyPlan;
}

function normalizeApplyManifest(value: unknown): ApplyManifest {
  const parsed = ApplyManifestSchema.parse(value);
  return {
    ...parsed,
    appliedCount: parsed.appliedCount ?? 0,
    failedCount: parsed.failedCount ?? 0,
    undoneCount: parsed.undoneCount ?? 0,
    operationShardIds: parsed.operationShardIds ?? [],
    warnings: parsed.warnings ?? [],
  } as ApplyManifest;
}

function candidateForItem(item: PaperReviewItem): PaperIdentityCandidate | undefined {
  return item.candidates.find((candidate) => candidate.id === item.selectedCandidateId) ?? item.candidates[0];
}

function correctionString(item: PaperReviewItem, key: string): string | number | string[] | undefined {
  const value = item.correction?.[key];
  if (typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  return undefined;
}

function templateValuesForItem(item: PaperReviewItem): TemplateValues {
  const candidate = candidateForItem(item);
  const authors = correctionString(item, "authors") ?? candidate?.authors ?? [];
  const authorList = Array.isArray(authors) ? authors : String(authors).split(/,\s*/).filter(Boolean);
  return {
    year: correctionString(item, "year") ?? candidate?.year,
    first_author: correctionString(item, "first_author") ?? authorList[0],
    authors: authorList,
    title: correctionString(item, "title") ?? candidate?.title,
    short_title: correctionString(item, "short_title") ?? candidate?.title,
    venue: correctionString(item, "venue") ?? candidate?.venue,
    doi: correctionString(item, "doi") ?? candidate?.identifiers.doi,
    arxiv_id: correctionString(item, "arxiv_id") ?? candidate?.identifiers.arxivId,
    pmid: correctionString(item, "pmid") ?? candidate?.identifiers.pmid,
  };
}

function operationKind(sourceRelativePath: string, destinationRelativePath: string): ApplyOperation["kind"] {
  return path.dirname(sourceRelativePath) === path.dirname(destinationRelativePath) ? "rename" : "move";
}

function buildOperation(
  item: PaperReviewItem,
  templateFormat: string,
  existingDestinations: string[],
): ApplyOperation {
  const source = item.source;
  const conflictCodes: string[] = [];
  let destinationRelativePath = source?.relativePath ?? `${item.paperId}.pdf`;

  if (!source) conflictCodes.push("missing_source_snapshot");
  if (item.state !== "accepted" && item.state !== "corrected") {
    conflictCodes.push("review_required");
  }

  if (item.state === "accepted" || item.state === "corrected") {
    const rendered = renderRenameTemplate(templateFormat, templateValuesForItem(item), {
      existingDestinations,
    });
    if (rendered.ok) {
      destinationRelativePath = rendered.relativePath;
    } else {
      conflictCodes.push(...rendered.problems.map((problem) => problem.code));
    }
  }

  const validation = validateRelativeDestination(destinationRelativePath, { existingDestinations });
  if (!validation.ok) conflictCodes.push(...validation.problems.map((problem) => problem.code));

  return {
    id: randomUUID(),
    paperId: item.paperId,
    kind: source ? operationKind(source.relativePath, destinationRelativePath) : "move",
    source,
    destinationRelativePath,
    reason: item.state === "corrected" ? "User-corrected review item" : "Paper library template proposal",
    confidence: candidateForItem(item)?.confidence ?? 0,
    conflictCodes: Array.from(new Set(conflictCodes)),
  };
}

async function writeOperationShards(
  project: string,
  applyPlanId: string,
  operations: ApplyOperation[],
  stateRoot: string,
): Promise<string[]> {
  const shardIds: string[] = [];
  for (let start = 0; start < operations.length; start += APPLY_SHARD_SIZE) {
    const shardId = String(shardIds.length + 1).padStart(4, "0");
    shardIds.push(shardId);
    await writeJsonFile(getPaperLibraryApplyOperationShardPath(project, applyPlanId, shardId, stateRoot), ApplyOperationShardSchema.parse({
      version: PAPER_LIBRARY_STATE_VERSION,
      applyPlanId,
      operations: operations.slice(start, start + APPLY_SHARD_SIZE),
    }));
  }
  return shardIds;
}

export async function readApplyPlan(project: string, applyPlanId: string, brainRoot: string): Promise<ApplyPlan | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryApplyPlanPath(project, applyPlanId, stateRoot),
    ApplyPlanSchema,
    "paper-library apply plan",
  );
  return parsed.ok ? normalizeApplyPlan(parsed.data) : null;
}

export async function readApplyOperations(
  project: string,
  applyPlanId: string,
  brainRoot: string,
): Promise<ApplyOperation[]> {
  const plan = await readApplyPlan(project, applyPlanId, brainRoot);
  if (!plan) return [];
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const shards = await Promise.all(plan.operationShardIds.map(async (shardId) => {
    const raw = await readJsonFile<unknown>(getPaperLibraryApplyOperationShardPath(project, applyPlanId, shardId, stateRoot));
    return raw ? ApplyOperationShardSchema.parse(raw).operations : [];
  }));
  return shards.flat();
}

export async function createApplyPlan(input: {
  project: string;
  scanId: string;
  brainRoot: string;
  rootPath?: string;
  templateFormat: string;
}): Promise<{ plan: ApplyPlan; operations: ApplyOperation[] } | null> {
  const review = await readAllPaperReviewItems(input.project, input.scanId, input.brainRoot);
  if (!review) return null;
  if (review.scan.status !== "ready_for_review" && review.scan.status !== "ready_for_apply") {
    throw new Error("Paper library scan must finish before an apply plan can be created.");
  }

  const scanRoot = await realpath(review.scan.rootRealpath ?? review.scan.rootPath);
  const requestedRoot = await realpath(input.rootPath ?? scanRoot);
  if (requestedRoot !== scanRoot) {
    throw new Error("Apply root does not match the approved scan root.");
  }

  const existingDestinations: string[] = [];
  const operations = review.items
    .filter((item) => item.state !== "ignored")
    .map((item) => {
      const operation = buildOperation(item, input.templateFormat, existingDestinations);
      existingDestinations.push(operation.destinationRelativePath);
      return operation;
    });

  const duplicateCounts = new Map<string, number>();
  for (const operation of operations) {
    const key = operation.destinationRelativePath.toLowerCase();
    duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }
  const dedupedOperations = operations.map((operation) => {
    const key = operation.destinationRelativePath.toLowerCase();
    if ((duplicateCounts.get(key) ?? 0) <= 1) return operation;
    return {
      ...operation,
      conflictCodes: Array.from(new Set([...operation.conflictCodes, "duplicate_destination"])),
    };
  });

  const createdAt = nowIso();
  const id = randomUUID();
  const operationShardIds = await writeOperationShards(input.project, id, dedupedOperations, review.stateRoot);
  const conflictCount = dedupedOperations.filter((operation) => operation.conflictCodes.length > 0).length;
  const planDigest = hashJson({
    scanId: input.scanId,
    rootRealpath: scanRoot,
    templateFormat: input.templateFormat,
    operations: dedupedOperations,
  });
  const plan = ApplyPlanSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    id,
    scanId: input.scanId,
    project: input.project,
    status: conflictCount > 0 ? "blocked" : "validated",
    rootPath: input.rootPath ?? review.scan.rootPath,
    rootRealpath: scanRoot,
    templateFormat: input.templateFormat,
    operationCount: dedupedOperations.length,
    conflictCount,
    operationShardIds,
    planDigest,
    createdAt,
    updatedAt: createdAt,
  });
  await writeJsonFile(getPaperLibraryApplyPlanPath(input.project, id, review.stateRoot), plan);
  await updatePaperLibraryScan(input.project, input.scanId, input.brainRoot, (scan) => ({
    ...scan,
    applyPlanId: id,
    updatedAt: nowIso(),
  }));
  return { plan, operations: dedupedOperations };
}

export async function approveApplyPlan(input: {
  project: string;
  applyPlanId: string;
  brainRoot: string;
}): Promise<{ plan: ApplyPlan; approvalToken: string; expiresAt: string } | null> {
  const plan = await readApplyPlan(input.project, input.applyPlanId, input.brainRoot);
  if (!plan) return null;
  if (plan.status !== "validated" || plan.conflictCount > 0 || !plan.planDigest) {
    throw new Error("Apply plan must be validated and conflict-free before approval.");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const approved = ApplyPlanSchema.parse({
    ...plan,
    status: "approved",
    approvalTokenHash: hashToken(token),
    approvalExpiresAt: expiresAt,
    approvedAt: nowIso(),
    updatedAt: nowIso(),
  });
  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  await writeJsonFile(getPaperLibraryApplyPlanPath(input.project, input.applyPlanId, stateRoot), approved);
  return { plan: approved, approvalToken: token, expiresAt };
}

function validateApprovalTokenMatch(plan: ApplyPlan, approvalToken: string): void {
  if (!plan.approvalTokenHash || hashToken(approvalToken) !== plan.approvalTokenHash) {
    throw new Error("Approval token does not match this apply plan.");
  }
}

function validateApproval(plan: ApplyPlan, approvalToken: string): void {
  if (plan.status !== "approved") throw new Error("Apply plan is not approved.");
  validateApprovalTokenMatch(plan, approvalToken);
  if (!plan.approvalExpiresAt || Date.parse(plan.approvalExpiresAt) <= Date.now()) {
    throw new Error("Approval token expired.");
  }
}

function manifestOperationsFromPlan(
  operations: ApplyOperation[],
  reviewItemsByPaperId: Map<string, PaperReviewItem>,
): ApplyManifestOperation[] {
  return operations.map((operation) => ({
    operationId: operation.id,
    paperId: operation.paperId,
    sourceRelativePath: operation.source?.relativePath ?? "",
    destinationRelativePath: operation.destinationRelativePath,
    status: "pending",
    source: operation.source,
    appliedMetadata: buildAppliedPaperMetadata(operation, reviewItemsByPaperId.get(operation.paperId)),
  }));
}

async function writeManifestOperationShard(
  project: string,
  manifestId: string,
  shardId: string,
  operations: ApplyManifestOperation[],
  stateRoot: string,
): Promise<void> {
  await writeJsonFile(getPaperLibraryManifestOperationShardPath(project, manifestId, shardId, stateRoot), ApplyManifestOperationShardSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    manifestId,
    operations,
  }));
}

async function writeManifestOperations(
  project: string,
  manifestId: string,
  operations: ApplyManifestOperation[],
  stateRoot: string,
): Promise<string[]> {
  const shardIds: string[] = [];
  for (let start = 0; start < operations.length; start += APPLY_SHARD_SIZE) {
    const shardId = String(shardIds.length + 1).padStart(4, "0");
    shardIds.push(shardId);
    await writeManifestOperationShard(
      project,
      manifestId,
      shardId,
      operations.slice(start, start + APPLY_SHARD_SIZE),
      stateRoot,
    );
  }
  return shardIds;
}

async function rewriteManifestOperationAt(
  manifest: ApplyManifest,
  operationIndex: number,
  operations: ApplyManifestOperation[],
  stateRoot: string,
): Promise<void> {
  const shardIndex = Math.floor(operationIndex / APPLY_SHARD_SIZE);
  const shardId = manifest.operationShardIds[shardIndex];
  if (!shardId) {
    throw new Error(`Apply manifest ${manifest.id} is missing operation shard for operation index ${operationIndex}.`);
  }
  const start = shardIndex * APPLY_SHARD_SIZE;
  await writeManifestOperationShard(
    manifest.project,
    manifest.id,
    shardId,
    operations.slice(start, start + APPLY_SHARD_SIZE),
    stateRoot,
  );
}

async function writeManifest(manifest: ApplyManifest, stateRoot: string): Promise<ApplyManifest> {
  const parsed = normalizeApplyManifest(manifest);
  await writeJsonFile(getPaperLibraryManifestPath(parsed.project, parsed.id, stateRoot), parsed);
  return parsed;
}

export async function readApplyManifest(project: string, manifestId: string, brainRoot: string): Promise<ApplyManifest | null> {
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const parsed = await readPersistedState(
    getPaperLibraryManifestPath(project, manifestId, stateRoot),
    ApplyManifestSchema,
    "paper-library apply manifest",
  );
  return parsed.ok ? normalizeApplyManifest(parsed.data) : null;
}

export async function readManifestOperations(project: string, manifestId: string, brainRoot: string): Promise<ApplyManifestOperation[]> {
  const manifest = await readApplyManifest(project, manifestId, brainRoot);
  if (!manifest) return [];
  const stateRoot = getProjectStateRootForBrainRoot(project, brainRoot);
  const shards = await Promise.all(manifest.operationShardIds.map(async (shardId) => {
    const raw = await readJsonFile<unknown>(getPaperLibraryManifestOperationShardPath(project, manifestId, shardId, stateRoot));
    return raw ? ApplyManifestOperationShardSchema.parse(raw).operations : [];
  }));
  return shards.flat();
}

async function destinationIsAvailable(destinationAbsolutePath: string): Promise<boolean> {
  try {
    await lstat(destinationAbsolutePath);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function assertDestinationParentInsideRoot(rootRealpath: string, destinationAbsolutePath: string): Promise<void> {
  const parent = path.dirname(destinationAbsolutePath);
  await mkdir(parent, { recursive: true });
  const parentRealpath = await realpath(parent);
  if (!isPathInsideRoot(rootRealpath, parentRealpath)) {
    throw new Error("Destination parent escapes the approved root.");
  }
}

async function applyOneOperation(rootRealpath: string, operation: ApplyOperation): Promise<ApplyManifestOperation> {
  if (!operation.source) throw new Error("Apply operation is missing a source snapshot.");
  if (operation.conflictCodes.length > 0) throw new Error(`Apply operation has unresolved conflicts: ${operation.conflictCodes.join(", ")}`);

  const sourceAbsolutePath = path.join(rootRealpath, operation.source.relativePath);
  const destinationAbsolutePath = path.join(rootRealpath, operation.destinationRelativePath);
  const currentSnapshot = await snapshotFile(rootRealpath, sourceAbsolutePath);
  if (!currentSnapshot.ok) throw new Error(currentSnapshot.problems[0]?.message ?? "Source cannot be snapshotted.");
  const comparison = compareSnapshot(operation.source, currentSnapshot.snapshot);
  if (!comparison.ok) throw new Error(comparison.problems[0]?.message ?? "Source changed since approval.");
  const destinationValidation = validateRelativeDestination(operation.destinationRelativePath);
  if (!destinationValidation.ok) throw new Error(destinationValidation.problems[0]?.message ?? "Destination is unsafe.");
  await assertDestinationParentInsideRoot(rootRealpath, destinationAbsolutePath);
  const baseOperation = {
    operationId: operation.id,
    paperId: operation.paperId,
    sourceRelativePath: operation.source.relativePath,
    destinationRelativePath: operation.destinationRelativePath,
    source: operation.source,
  } satisfies Pick<
    ApplyManifestOperation,
    "operationId" | "paperId" | "sourceRelativePath" | "destinationRelativePath" | "source"
  >;
  if (operation.source.relativePath === operation.destinationRelativePath) {
    return {
      ...baseOperation,
      status: "verified",
      destinationSnapshot: currentSnapshot.snapshot,
      appliedAt: nowIso(),
    };
  }
  if (!(await destinationIsAvailable(destinationAbsolutePath))) {
    throw new Error("Destination already exists.");
  }

  await rename(sourceAbsolutePath, destinationAbsolutePath);
  const destinationSnapshot = await snapshotFile(rootRealpath, destinationAbsolutePath);
  if (!destinationSnapshot.ok) throw new Error(destinationSnapshot.problems[0]?.message ?? "Moved file cannot be verified.");
  return {
    ...baseOperation,
    status: "verified",
    destinationSnapshot: destinationSnapshot.snapshot,
    appliedAt: nowIso(),
  };
}

export interface PersistAppliedPaperLocationsInput {
  project: string;
  brainRoot: string;
  manifestId: string;
  plan: ApplyPlan;
  operations: ApplyOperation[];
  reviewItems?: PaperReviewItem[];
  manifestOperations: ApplyManifestOperation[];
}

async function readExistingApplyForIdempotency(
  project: string,
  applyPlanId: string,
  idempotencyKey: string | undefined,
  plan: ApplyPlan,
  brainRoot: string,
  stateRoot: string,
): Promise<{ manifest: ApplyManifest; operations: ApplyManifestOperation[] } | null> {
  if (!idempotencyKey) return null;
  const record = await readJsonFile<unknown>(
    getPaperLibraryApplyIdempotencyPath(project, idempotencyKey, stateRoot),
  );
  if (!record) return null;
  const parsed = ApplyIdempotencyRecordSchema.parse(record);
  if (parsed.project !== project || parsed.applyPlanId !== applyPlanId) {
    throw new Error("Idempotency key was already used for another apply plan.");
  }
  if (plan.planDigest && parsed.planDigest !== plan.planDigest) {
    throw new Error("Idempotency key does not match this apply plan version.");
  }
  const manifest = await readApplyManifest(project, parsed.manifestId, brainRoot);
  if (!manifest) return null;
  return {
    manifest,
    operations: await readManifestOperations(project, parsed.manifestId, brainRoot),
  };
}

export async function applyApprovedPlan(input: {
  project: string;
  applyPlanId: string;
  approvalToken: string;
  idempotencyKey?: string;
  brainRoot: string;
  persistLocations?: (input: PersistAppliedPaperLocationsInput) => Promise<void>;
}): Promise<{ manifest: ApplyManifest; operations: ApplyManifestOperation[] } | null> {
  const plan = await readApplyPlan(input.project, input.applyPlanId, input.brainRoot);
  if (!plan) return null;
  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  validateApprovalTokenMatch(plan, input.approvalToken);
  if (plan.manifestId && plan.status !== "approved") {
    const existingManifest = await readApplyManifest(input.project, plan.manifestId, input.brainRoot);
    if (existingManifest) {
      return {
        manifest: existingManifest,
        operations: await readManifestOperations(input.project, existingManifest.id, input.brainRoot),
      };
    }
  }
  const existingForIdempotency = await readExistingApplyForIdempotency(
    input.project,
    input.applyPlanId,
    input.idempotencyKey,
    plan,
    input.brainRoot,
    stateRoot,
  );
  if (existingForIdempotency) return existingForIdempotency;

  validateApproval(plan, input.approvalToken);
  if (plan.conflictCount > 0) throw new Error("Cannot apply a plan with unresolved conflicts.");

  const operations = await readApplyOperations(input.project, input.applyPlanId, input.brainRoot);
  const review = await readAllPaperReviewItems(input.project, plan.scanId, input.brainRoot);
  const reviewItems = review?.items ?? [];
  const reviewItemsByPaperId = new Map(reviewItems.map((item) => [item.paperId, item]));
  const manifestId = plan.manifestId ?? randomUUID();
  const manifestOperations = manifestOperationsFromPlan(operations, reviewItemsByPaperId);
  const createdAt = nowIso();
  const planDigest = plan.planDigest ?? hashJson({
    scanId: plan.scanId,
    rootRealpath: plan.rootRealpath,
    templateFormat: plan.templateFormat,
    operations,
  });
  let manifest = ApplyManifestSchema.parse({
    version: PAPER_LIBRARY_STATE_VERSION,
    id: manifestId,
    project: input.project,
    applyPlanId: input.applyPlanId,
    status: "applying",
    rootRealpath: plan.rootRealpath,
    planDigest,
    operationCount: manifestOperations.length,
    appliedCount: 0,
    failedCount: 0,
    undoneCount: 0,
    operationShardIds: await writeManifestOperations(input.project, manifestId, manifestOperations, stateRoot),
    warnings: [],
    createdAt,
    updatedAt: createdAt,
  });
  await writeManifest(manifest, stateRoot);
  if (input.idempotencyKey) {
    await writeJsonFile(getPaperLibraryApplyIdempotencyPath(input.project, input.idempotencyKey, stateRoot), ApplyIdempotencyRecordSchema.parse({
      version: PAPER_LIBRARY_STATE_VERSION,
      project: input.project,
      applyPlanId: input.applyPlanId,
      manifestId,
      planDigest,
      createdAt,
    }));
  }
  await writeJsonFile(getPaperLibraryApplyPlanPath(input.project, input.applyPlanId, stateRoot), ApplyPlanSchema.parse({
    ...plan,
    status: "applying",
    manifestId,
    updatedAt: nowIso(),
  }));

  for (const [index, operation] of operations.entries()) {
    try {
      manifestOperations[index] = {
        ...manifestOperations[index],
        ...(await applyOneOperation(plan.rootRealpath, operation)),
      };
    } catch (error) {
      manifestOperations[index] = {
        ...manifestOperations[index],
        status: "failed",
        error: error instanceof Error ? error.message : "Apply operation failed.",
      };
    }
    await rewriteManifestOperationAt(manifest, index, manifestOperations, stateRoot);
  }

  const appliedCount = manifestOperations.filter((operation) => operation.status === "verified").length;
  const failedCount = manifestOperations.filter((operation) => operation.status === "failed").length;
  let status: ApplyManifest["status"] = failedCount > 0 ? "failed" : "applied";
  const warnings: string[] = [];

  if (status === "applied" && input.persistLocations) {
    try {
      await input.persistLocations({
        project: input.project,
        brainRoot: input.brainRoot,
        manifestId,
        plan,
        operations,
        reviewItems,
        manifestOperations,
      });
    } catch (error) {
      status = "applied_with_repair_required";
      warnings.push(error instanceof Error ? error.message : "gbrain update failed after filesystem apply.");
    }
  }

  manifest = await writeManifest({
    ...manifest,
    status,
    appliedCount,
    failedCount,
    warnings,
    updatedAt: nowIso(),
  }, stateRoot);
  await writeJsonFile(getPaperLibraryApplyPlanPath(input.project, input.applyPlanId, stateRoot), ApplyPlanSchema.parse({
    ...plan,
    status: status === "applied" ? "applied" : status,
    manifestId,
    updatedAt: nowIso(),
  }));
  return { manifest, operations: manifestOperations };
}

export async function repairAppliedManifest(input: {
  project: string;
  manifestId: string;
  brainRoot: string;
  persistLocations?: (input: PersistAppliedPaperLocationsInput) => Promise<void>;
}): Promise<{ manifest: ApplyManifest; operations: ApplyManifestOperation[]; repaired: boolean } | null> {
  const manifest = await readApplyManifest(input.project, input.manifestId, input.brainRoot);
  if (!manifest) return null;
  if (manifest.status !== "applied_with_repair_required") {
    throw new Error("Apply manifest does not require repair.");
  }
  if (!input.persistLocations) {
    throw new Error("Repair handler is unavailable.");
  }

  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  const plan = await readApplyPlan(input.project, manifest.applyPlanId, input.brainRoot);
  if (!plan) {
    throw new Error("Apply plan not found for this manifest.");
  }

  const operations = await readApplyOperations(input.project, manifest.applyPlanId, input.brainRoot);
  const manifestOperations = await readManifestOperations(input.project, input.manifestId, input.brainRoot);
  const appliedOperationCount = manifestOperations.filter((operation) => (
    operation.status === "applied" || operation.status === "verified"
  )).length;
  if (appliedOperationCount === 0) {
    throw new Error("Apply manifest has no verified operations to repair.");
  }
  const needsReviewFallback = manifestOperations.some((operation) => !operation.appliedMetadata);
  const review = needsReviewFallback
    ? await readAllPaperReviewItems(input.project, plan.scanId, input.brainRoot)
    : null;

  try {
    await input.persistLocations({
      project: input.project,
      brainRoot: input.brainRoot,
      manifestId: manifest.id,
      plan,
      operations,
      reviewItems: review?.items ?? [],
      manifestOperations,
    });

    const updatedManifest = await writeManifest({
      ...manifest,
      status: "applied",
      warnings: [],
      updatedAt: nowIso(),
    }, stateRoot);
    await writeJsonFile(getPaperLibraryApplyPlanPath(input.project, manifest.applyPlanId, stateRoot), ApplyPlanSchema.parse({
      ...plan,
      status: "applied",
      manifestId: manifest.id,
      updatedAt: nowIso(),
    }));

    return { manifest: updatedManifest, operations: manifestOperations, repaired: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "gbrain update failed after filesystem apply.";
    const updatedManifest = await writeManifest({
      ...manifest,
      status: "applied_with_repair_required",
      warnings: Array.from(new Set([...manifest.warnings, message])),
      updatedAt: nowIso(),
    }, stateRoot);
    await writeJsonFile(getPaperLibraryApplyPlanPath(input.project, manifest.applyPlanId, stateRoot), ApplyPlanSchema.parse({
      ...plan,
      status: "applied_with_repair_required",
      manifestId: manifest.id,
      updatedAt: nowIso(),
    }));

    return { manifest: updatedManifest, operations: manifestOperations, repaired: false };
  }
}

export async function undoApplyManifest(input: {
  project: string;
  manifestId: string;
  brainRoot: string;
}): Promise<{ manifest: ApplyManifest; operations: ApplyManifestOperation[] } | null> {
  const manifest = await readApplyManifest(input.project, input.manifestId, input.brainRoot);
  if (!manifest) return null;
  const stateRoot = getProjectStateRootForBrainRoot(input.project, input.brainRoot);
  const operations = await readManifestOperations(input.project, input.manifestId, input.brainRoot);
  await writeManifest({ ...manifest, status: "undoing", updatedAt: nowIso() }, stateRoot);

  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation.status !== "applied" && operation.status !== "verified") {
      continue;
    }
    try {
      const sourceAbsolutePath = path.join(manifest.rootRealpath, operation.sourceRelativePath);
      const destinationAbsolutePath = path.join(manifest.rootRealpath, operation.destinationRelativePath);
      if (operation.sourceRelativePath === operation.destinationRelativePath) {
        operations[index] = {
          ...operation,
          status: "undone",
          undoneAt: nowIso(),
        };
        await rewriteManifestOperationAt(manifest, index, operations, stateRoot);
        continue;
      }
      if (operation.destinationSnapshot) {
        const currentDestination = await snapshotFile(manifest.rootRealpath, destinationAbsolutePath);
        if (!currentDestination.ok) throw new Error("Destination cannot be snapshotted for undo.");
        const comparison = compareSnapshot(operation.destinationSnapshot, currentDestination.snapshot);
        if (!comparison.ok) throw new Error("Destination changed since apply.");
      }
      if (!(await destinationIsAvailable(sourceAbsolutePath))) {
        throw new Error("Original source path already exists.");
      }
      await assertDestinationParentInsideRoot(manifest.rootRealpath, sourceAbsolutePath);
      await rename(destinationAbsolutePath, sourceAbsolutePath);
      operations[index] = {
        ...operation,
        status: "undone",
        undoneAt: nowIso(),
      };
    } catch (error) {
      operations[index] = {
        ...operation,
        status: "failed",
        error: error instanceof Error ? error.message : "Undo operation failed.",
      };
    }
    await rewriteManifestOperationAt(manifest, index, operations, stateRoot);
  }

  const failedCount = operations.filter((operation) => operation.status === "failed").length;
  const undoneCount = operations.filter((operation) => operation.status === "undone").length;
  const updatedManifest = await writeManifest({
    ...manifest,
    status: failedCount > 0 ? "failed" : "undone",
    failedCount,
    undoneCount,
    updatedAt: nowIso(),
  }, stateRoot);
  return { manifest: updatedManifest, operations };
}

export function windowApplyOperations(operations: ApplyOperation[], options: { cursor?: string; limit?: number }) {
  return readCursorWindow(operations, options);
}

export function windowManifestOperations(
  operations: ApplyManifestOperation[],
  options: { cursor?: string; limit?: number },
) {
  return readCursorWindow(operations, options);
}
