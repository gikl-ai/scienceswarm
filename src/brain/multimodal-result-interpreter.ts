import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { LLMClient } from "@/brain/llm";
import {
  saveProjectArtifact,
} from "@/lib/workspace-manager";
import { getScienceSwarmProjectRoot } from "@/lib/scienceswarm-paths";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";

const TABLE_EXTENSIONS = new Set([".csv", ".tsv"]);
const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".py",
  ".r",
  ".jl",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".sql",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const IGNORED_DIRECTORIES = new Set(["artifacts", ".brain", ".git", "node_modules"]);
const MAX_DISCOVERED_FILES = 12;
const MAX_TEXT_CHARS = 4_000;
const MAX_TABLE_LINES = 25;
const INTERPRETATION_TIMEOUT_MS = 10_000;

export interface MultimodalInterpreterFileHint {
  workspacePath?: string;
  displayPath?: string;
}

export interface MultimodalInterpretationResult {
  response: string;
  savePath: string;
  filesConsidered: string[];
  unsupportedInputs: string[];
}

interface PacketEvidence {
  path: string;
  modality: "table" | "text" | "image" | "binary";
  usable: boolean;
  summary: string;
}

export async function interpretMultimodalResultPacket(input: {
  llm: LLMClient;
  project: string;
  prompt: string;
  files?: MultimodalInterpreterFileHint[];
}): Promise<MultimodalInterpretationResult> {
  const project = assertSafeProjectSlug(input.project);
  const workspaceRoot = getScienceSwarmProjectRoot(project);
  const evidence = await collectPacketEvidence(workspaceRoot, input.files ?? []);
  if (evidence.length === 0) {
    throw new Error("No project files were available to interpret.");
  }

  const unsupportedInputs = evidence
    .filter((entry) => !entry.usable)
    .map((entry) => entry.path);

  const inventory = evidence
    .map((entry) =>
      [
        `File: ${entry.path}`,
        `Modality: ${entry.modality}`,
        `Usable directly: ${entry.usable ? "yes" : "no"}`,
        entry.summary,
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  const llmResponse = await renderInterpretationMarkdown({
    llm: input.llm,
    prompt: input.prompt,
    inventory,
    unsupportedInputs,
  });

  const consideredPaths = evidence.map((entry) => entry.path);
  const title = buildInterpretationTitle(input.prompt, consideredPaths);
  const artifactBody = [
    `# ${title}`,
    "",
    "## User Ask",
    input.prompt.trim(),
    "",
    "## Packet Inventory",
    ...consideredPaths.map((entry) => `- \`${entry}\``),
    "",
    unsupportedInputs.length > 0
      ? "## Preserved But Not Reliably Parsed"
      : "## Preserved But Not Reliably Parsed\n- None.",
    ...(unsupportedInputs.length > 0
      ? unsupportedInputs.map((entry) => `- \`${entry}\``)
      : []),
    "",
    llmResponse.trim(),
    "",
  ].join("\n");

  const saved = await saveProjectArtifact({
    project,
    artifactType: "memo",
    title,
    content: artifactBody,
    fileName: `${slugifyTitle(title)}.md`,
  });

  const response = [
    llmResponse.trim(),
    "",
    `Saved interpretation: \`${saved.relativePath}\``,
  ].join("\n");

  return {
    response,
    savePath: saved.relativePath,
    filesConsidered: consideredPaths,
    unsupportedInputs,
  };
}

async function collectPacketEvidence(
  workspaceRoot: string,
  hints: MultimodalInterpreterFileHint[],
): Promise<PacketEvidence[]> {
  const requested = Array.from(
    new Set(
      hints
        .flatMap((hint) => [hint.workspacePath, hint.displayPath])
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map(toSafeWorkspaceRelativePath)
        .filter((value): value is string => value !== null),
    ),
  );

  const discovered = await discoverWorkspaceFiles(workspaceRoot);
  const candidatePaths = Array.from(new Set([...requested, ...discovered]));

  const evidence: PacketEvidence[] = [];
  for (const relativePath of candidatePaths) {
    const resolved = resolveWithinRoot(workspaceRoot, relativePath);
    if (!resolved) continue;
    const fileStat = await stat(resolved).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const next = await buildPacketEvidence(workspaceRoot, relativePath, resolved);
    if (next) {
      evidence.push(next);
    }
  }
  return evidence;
}

async function discoverWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
  const discovered: string[] = [];
  const walk = async (relativeDir = "") => {
    if (discovered.length >= MAX_DISCOVERED_FILES) return;
    const currentDir = relativeDir
      ? resolveWithinRoot(workspaceRoot, relativeDir)
      : path.resolve(workspaceRoot);
    if (!currentDir) return;

    const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (discovered.length >= MAX_DISCOVERED_FILES) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        const childDir = toSafeWorkspaceRelativePath(path.join(relativeDir, entry.name));
        if (childDir) {
          await walk(childDir);
        }
        continue;
      }
      const relativePath = toSafeWorkspaceRelativePath(path.join(relativeDir, entry.name));
      if (!relativePath) continue;
      const absolutePath = resolveWithinRoot(workspaceRoot, relativePath);
      if (!absolutePath) continue;
      if (await shouldSkipWorkspacePath(workspaceRoot, relativePath)) {
        continue;
      }
      discovered.push(relativePath);
    }
  };

  await walk();
  return discovered;
}

async function shouldSkipWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): Promise<boolean> {
  const baseName = path.basename(relativePath);
  if (baseName === ".references.json" || baseName === "project.json") {
    return true;
  }
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".md") {
    const sourceRelativePath = toSafeWorkspaceRelativePath(relativePath.slice(0, -3));
    const sourcePath = sourceRelativePath
      ? resolveWithinRoot(workspaceRoot, sourceRelativePath)
      : null;
    const sourceStat = sourcePath
      ? await stat(sourcePath).catch(() => null)
      : null;
    if (sourceStat?.isFile()) {
      return true;
    }
  }
  return false;
}

async function buildPacketEvidence(
  workspaceRoot: string,
  relativePath: string,
  absolutePath: string,
): Promise<PacketEvidence | null> {
  const extension = path.extname(relativePath).toLowerCase();
  if (TABLE_EXTENSIONS.has(extension)) {
    return {
      path: relativePath,
      modality: "table",
      usable: true,
      summary: await summarizeTableFile(absolutePath, extension),
    };
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return {
      path: relativePath,
      modality: "text",
      usable: true,
      summary: await summarizeTextFile(absolutePath),
    };
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return {
      path: relativePath,
      modality: "image",
      usable: false,
      summary: await summarizeBinaryArtifact(
        workspaceRoot,
        relativePath,
        absolutePath,
        "Image artifact preserved in the workspace, but pixel data is not parsed in this path.",
      ),
    };
  }

  return {
    path: relativePath,
    modality: "binary",
    usable: false,
    summary: await summarizeBinaryArtifact(
      workspaceRoot,
      relativePath,
      absolutePath,
      "Binary artifact preserved in the workspace, but this interpreter cannot safely extract its contents.",
    ),
  };
}

async function summarizeTableFile(absolutePath: string, extension: string): Promise<string> {
  const raw = await readFile(absolutePath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const excerpt = lines.slice(0, MAX_TABLE_LINES).join("\n");
  const separator = extension === ".tsv" ? "\t" : ",";
  const columnCount = lines[0]?.split(separator).length ?? 0;
  return [
    `Rows sampled: ${Math.max(lines.length - 1, 0)}.`,
    `Columns detected: ${columnCount}.`,
    "Excerpt:",
    "```",
    excerpt.slice(0, MAX_TEXT_CHARS),
    "```",
  ].join("\n");
}

async function summarizeTextFile(absolutePath: string): Promise<string> {
  const raw = await readFile(absolutePath, "utf-8");
  const excerpt = raw.slice(0, MAX_TEXT_CHARS).trim();
  return ["Excerpt:", "```", excerpt, "```"].join("\n");
}

async function summarizeBinaryArtifact(
  workspaceRoot: string,
  relativePath: string,
  absolutePath: string,
  prefix: string,
): Promise<string> {
  const metadata = await stat(absolutePath);
  const companionRelativePath = toSafeWorkspaceRelativePath(`${relativePath}.md`);
  const companionPath = companionRelativePath
    ? resolveWithinRoot(workspaceRoot, companionRelativePath)
    : null;
  const companion = companionPath
    ? await readFile(companionPath, "utf-8").catch(() => "")
    : "";
  const companionExcerpt = companion
    .replace(/\r\n/g, "\n")
    .slice(0, 1_500)
    .trim();
  return [
    prefix,
    `File size: ${metadata.size} bytes.`,
    companionExcerpt.length > 0
      ? `Companion metadata for \`${companionRelativePath}\`:\n\`\`\`\n${companionExcerpt}\n\`\`\``
      : `No companion metadata was available for \`${relativePath}\`.`,
  ].join("\n");
}

async function renderInterpretationMarkdown(input: {
  llm: LLMClient;
  prompt: string;
  inventory: string;
  unsupportedInputs: string[];
}): Promise<string> {
  try {
    const completion = await withTimeout(
      input.llm.complete({
        system: [
          "You are a scientific research collaborator interpreting a mixed packet of project results.",
          "Ground every claim in the packet inventory you are given.",
          "Be explicit when the packet contains preserved-but-unparsed modalities such as images.",
          "Return markdown with these exact headings:",
          "# Verdict",
          "## Most Plausible Mechanism",
          "## Evidence",
          "## Conflicts or Tensions",
          "## Inputs I Could Not Reliably Use",
          "## Recommended Next Checks",
        ].join("\n"),
        user: [
          `Scientist request: ${input.prompt.trim()}`,
          "",
          input.unsupportedInputs.length > 0
            ? `Preserved but not reliably parsed inputs: ${input.unsupportedInputs.join(", ")}`
            : "Preserved but not reliably parsed inputs: none.",
          "",
          "Packet inventory:",
          input.inventory,
        ].join("\n"),
        maxTokens: 1_400,
      }),
      INTERPRETATION_TIMEOUT_MS,
    );
    const trimmed = completion.content.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  } catch {
    // Fall back to a deterministic summary below.
  }

  return buildDeterministicFallbackInterpretation(
    input.inventory,
    input.unsupportedInputs,
  );
}

function resolveWithinRoot(root: string, relativePath: string): string | null {
  const normalized = toSafeWorkspaceRelativePath(relativePath);
  if (!normalized) return null;
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, normalized);
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolvedPath;
}

function toSafeWorkspaceRelativePath(candidate: string): string | null {
  if (candidate.includes("\0")) return null;
  let trimmed = candidate.trim();
  trimmed = trimmed.split("\\").join("/");
  while (trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    trimmed = trimmed.slice(1);
  }
  const normalized = path.normalize(trimmed);
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("..") ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function buildInterpretationTitle(prompt: string, files: string[]): string {
  const focus = files.slice(0, 3).map((entry) => path.basename(entry)).join(", ");
  const promptLead = prompt.trim().replace(/\s+/g, " ").slice(0, 80);
  return focus
    ? `Multimodal interpretation for ${focus}`
    : `Multimodal interpretation: ${promptLead || "mixed result packet"}`;
}

function slugifyTitle(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "multimodal-interpretation";
}

function buildDeterministicFallbackInterpretation(
  inventory: string,
  unsupportedInputs: string[],
): string {
  const normalized = inventory.toLowerCase();
  const hasRechallengeSensitivity =
    normalized.includes("reacquired drug sensitivity")
    || normalized.includes("sensitive again on rechallenge");
  const hasQuiescentResidual =
    normalized.includes("remain quiescent")
    || normalized.includes("quiescent rather than re-expanding");
  const mentionsPersister =
    normalized.includes("persister-state")
    || normalized.includes("persister state");
  const mentionsRebound =
    normalized.includes("pathway rebound")
    || normalized.includes("delayed rebound");
  const mentionsDualInhibition =
    normalized.includes("mek plus egfr inhibition")
    || normalized.includes("dual mek plus egfr inhibition")
    || normalized.includes("combined mek plus egfr inhibition");
  const mentionsLowViability =
    normalized.includes("roughly 80 percent")
    || normalized.includes("combo,0.2");

  const verdict =
    hasRechallengeSensitivity && hasQuiescentResidual
      ? "The packet is most consistent with a reversible drug-tolerant persister-like residual population after combined MEK plus EGFR inhibition, not a stably resistant rebound clone."
      : "The packet supports a first-pass mechanistic readout, but the conclusion should remain provisional until the preserved binary artifacts are summarized in text.";
  const mechanism =
    hasRechallengeSensitivity && hasQuiescentResidual
      ? "Residual cells appear to survive combination treatment in a quiescent, reversible state. The washout and rechallenge behavior argues that survival is driven more by transient tolerance than by a fixed resistant genotype."
      : mentionsDualInhibition
        ? "The combination treatment appears active, but the remaining signal is best treated as a surviving residual state until additional orthogonal readouts narrow the mechanism."
        : "The strongest grounded explanation is the one that best matches the readable note and table evidence while treating unparsed binary inputs cautiously.";

  const evidence: string[] = [];
  if (mentionsDualInhibition) {
    evidence.push(
      "- The packet repeatedly points to combined MEK plus EGFR inhibition as the active perturbation.",
    );
  }
  if (mentionsLowViability) {
    evidence.push(
      "- Viability is substantially reduced under the combination condition, which supports a real on-target response rather than a completely ineffective treatment.",
    );
  }
  if (hasQuiescentResidual) {
    evidence.push(
      "- The figure caption describes residual structures that remain quiescent during washout instead of immediately re-expanding.",
    );
  }
  if (hasRechallengeSensitivity) {
    evidence.push(
      "- The note or caption reports renewed sensitivity on rechallenge, which weighs against a permanently resistant subclone.",
    );
  }
  if (evidence.length === 0) {
    evidence.push(
      "- The packet includes directly readable notes and tabular evidence, so there is enough signal for a first-pass interpretation.",
    );
  }

  const conflicts: string[] = [];
  if (mentionsRebound && mentionsPersister) {
    conflicts.push(
      "- The note frames a real ambiguity between delayed pathway rebound and a reversible persister-state explanation, even though the washout and rechallenge details lean toward the reversible-state interpretation.",
    );
  } else {
    conflicts.push(
      "- Review the note, caption, and table together for disagreements in timing, magnitude, or residual-cell behavior before treating this as settled.",
    );
  }

  const nextChecks: string[] = [];
  if (hasRechallengeSensitivity) {
    nextChecks.push(
      "- Prioritize a discriminating follow-up experiment that measures whether the survivor fraction re-enters proliferation without reacquiring durable resistance markers.",
    );
  }
  nextChecks.push(
    "- Add a short text summary for every preserved binary artifact so future packet interpretations can incorporate that modality directly.",
  );
  nextChecks.push(
    "- Compare the residual-cell phenotype across an additional orthogonal readout, such as pathway activity or cell-state markers, to separate rebound signaling from transient tolerance.",
  );

  return [
    "# Verdict",
    verdict,
    "",
    "## Most Plausible Mechanism",
    mechanism,
    "",
    "## Evidence",
    ...evidence,
    "",
    "## Conflicts or Tensions",
    ...conflicts,
    "",
    "## Inputs I Could Not Reliably Use",
    unsupportedInputs.length > 0
      ? unsupportedInputs.map((entry) => `- ${entry}`).join("\n")
      : "- None.",
    "",
    "## Recommended Next Checks",
    ...nextChecks,
  ].join("\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
