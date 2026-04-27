import { createHash } from "node:crypto";

import type { InProcessGbrainClient, PersistTransactionLinkInput } from "@/brain/in-process-gbrain-client";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { ensureBrainStoreReady } from "@/brain/store";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import { persistEntity, type PersistedEntityResult } from "@/lib/skills/db-base";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";

import {
  collectResearchLandscapeCandidates,
  type ResearchLandscapeSearchFn,
} from "./collect";
import {
  DEFAULT_PER_SOURCE_LIMIT,
  DEFAULT_RESEARCH_LANDSCAPE_SOURCES,
  DEFAULT_RETAINED_LIMIT,
  DEFAULT_RETRY_COUNT,
  type ResearchLandscapeFailure,
  type ResearchLandscapeInput,
  type ResearchLandscapeLastRun,
  type ResearchLandscapeResult,
  type ResearchLandscapeRetainedCandidate,
  type ResearchLandscapeRetainedWrite,
  type ResearchLandscapeSource,
  type ResearchLandscapeStatus,
} from "./contract";
import { dedupeResearchLandscapeCandidates } from "./dedupe";
import { writeResearchLandscapeLastRun } from "./last-run";
import { resolveExactTitleMatches } from "./resolve";
import { persistResearchArtifactPage } from "./writeback";

export type {
  ResearchLandscapeInput,
  ResearchLandscapeLastRun,
  ResearchLandscapeResult,
  ResearchLandscapeSource,
  ResearchLandscapeStatus,
} from "./contract";
export {
  readResearchLandscapeLastRun,
  researchLandscapeLastRunPath,
} from "./last-run";

export async function runResearchLandscape(
  input: ResearchLandscapeInput,
  options: {
    brainRoot?: string;
    now?: Date;
    searches?: Partial<Record<ResearchLandscapeSource, ResearchLandscapeSearchFn>>;
    createClient?: () => InProcessGbrainClient;
    ensureReady?: () => Promise<void>;
    persistPaper?: (
      candidate: ResearchLandscapeRetainedCandidate,
      context: { client: InProcessGbrainClient; brainRoot: string; project?: string; now: Date },
    ) => Promise<PersistedEntityResult>;
    persistArtifactPage?: typeof persistResearchArtifactPage;
    writeLastRun?: (brainRoot: string, payload: ResearchLandscapeLastRun) => string;
    getUserHandle?: () => string;
  } = {},
): Promise<ResearchLandscapeResult> {
  const normalized = normalizeInput(input);
  const now = options.now ?? new Date();
  const brainRoot = options.brainRoot ?? getScienceSwarmBrainRoot();
  const ensureReady = options.ensureReady ?? ensureBrainStoreReady;
  const client = (options.createClient ?? createInProcessGbrainClient)();
  const persistPaper = options.persistPaper ?? defaultPersistPaper;
  const persistArtifactPage = options.persistArtifactPage ?? persistResearchArtifactPage;
  const writeLastRun = options.writeLastRun ?? writeResearchLandscapeLastRun;
  const userHandle = (options.getUserHandle ?? getCurrentUserHandle)();

  const collected = await collectResearchLandscapeCandidates(normalized, {
    searches: options.searches,
  });
  const deduped = dedupeResearchLandscapeCandidates(collected.candidates);
  const retained = deduped.retained.slice(0, normalized.retainedLimit);
  const titleResolution = resolveExactTitleMatches(retained, normalized.exactTitle);
  const failures: ResearchLandscapeFailure[] = collected.sourceRuns
    .filter((run) => run.status === "failed" && run.error)
    .map((run) => ({
      stage: "source" as const,
      source: run.source,
      message: run.error as string,
    }));

  await ensureReady();

  const retainedWrites = await Promise.all(retained.map(async (candidate) => {
    try {
      const persisted = await persistPaper(candidate, {
        client,
        brainRoot,
        project: normalized.project,
        now,
      });
      return { candidate, persisted } satisfies ResearchLandscapeRetainedWrite;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        stage: "persist_paper",
        title: candidate.entity.payload.title,
        message,
      });
      return { candidate, error: message } satisfies ResearchLandscapeRetainedWrite;
    }
  }));

  const status = classifyRunStatus(collected.candidates.length, failures);
  const packetSlugStem = buildArtifactStem(normalized, now);
  const packetSlug = `packets/${packetSlugStem}`;
  const journalSlug = `journals/${packetSlugStem}`;
  const packetTitle = `Research Packet: ${normalized.exactTitle ?? normalized.query}`;
  const journalTitle = `Research Landscape Journal: ${normalized.exactTitle ?? normalized.query}`;
  const packetFrontmatter = buildPacketFrontmatter(normalized, now, userHandle, status, retained, deduped.duplicates.length, failures);
  const journalFrontmatter = buildJournalFrontmatter(normalized, now, userHandle, status, collected.sourceRuns, failures);
  const packet = await persistArtifactPage({
    slug: packetSlug,
    title: packetTitle,
    type: "research_packet",
    brainRoot,
    client,
    userHandle,
    now,
    compiledTruth: renderPacketBody(normalized, retainedWrites, deduped.duplicates, collected.sourceRuns, titleResolution),
    timelineEntry: renderPacketTimeline(now, status, retainedWrites, deduped.duplicates.length, failures.length),
    frontmatter: packetFrontmatter,
    links: buildPacketLinks(normalized.project, packetSlug, retainedWrites),
  });
  const journal = await persistArtifactPage({
    slug: journalSlug,
    title: journalTitle,
    type: "overnight_journal",
    brainRoot,
    client,
    userHandle,
    now,
    compiledTruth: renderJournalBody(normalized, status, retainedWrites, deduped.duplicates, collected.sourceRuns, failures, packet.slug),
    timelineEntry: renderJournalTimeline(now, status, collected.sourceRuns, failures),
    frontmatter: journalFrontmatter,
    links: buildJournalLinks(normalized.project, journalSlug, packet.slug),
  });

  const titleResolutionWithSlugs = titleResolution && {
    ...titleResolution,
    matches: titleResolution.matches.map((match) => ({
      ...match,
      slug: retainedWrites.find((write) => write.candidate.entity.payload.title === match.title)?.persisted?.slug,
    })),
  };

  const pointerPath = writeLastRun(brainRoot, {
    timestamp: now.toISOString(),
    status,
    query: normalized.query,
    exact_title: normalized.exactTitle,
    project: normalized.project,
    packet_slug: packet.slug,
    journal_slug: journal.slug,
    collected_candidates: collected.candidates.length,
    retained_candidates: retained.length,
    duplicates_dropped: deduped.duplicates.length,
    partial: status !== "completed",
    source_failures: failures
      .filter((failure) => failure.stage === "source" && failure.source)
      .map((failure) => ({
        source: failure.source as ResearchLandscapeSource,
        message: failure.message,
      })),
  });

  return {
    status,
    query: normalized.query,
    exactTitle: normalized.exactTitle,
    project: normalized.project,
    packet,
    journal,
    pointerPath,
    sourceRuns: collected.sourceRuns,
    collectedCandidates: collected.candidates.length,
    retainedCandidates: retained.length,
    duplicatesDropped: deduped.duplicates.length,
    retainedWrites,
    failures,
    titleResolution: titleResolutionWithSlugs,
  };
}

async function defaultPersistPaper(
  candidate: ResearchLandscapeRetainedCandidate,
  context: { client: InProcessGbrainClient; brainRoot: string; project?: string; now: Date },
): Promise<PersistedEntityResult> {
  return persistEntity(candidate.entity, {
    client: context.client,
    brainRoot: context.brainRoot,
    project: context.project,
    now: context.now,
  });
}

function normalizeInput(
  input: ResearchLandscapeInput,
): Required<Pick<ResearchLandscapeInput, "query" | "perSourceLimit" | "retainedLimit" | "retryCount">>
  & Pick<ResearchLandscapeInput, "exactTitle" | "project" | "startYear" | "endYear">
  & { sources: ResearchLandscapeSource[] } {
  const query = input.query?.trim();
  if (!query) {
    throw new Error("query is required");
  }
  if (
    input.startYear != null
    && input.endYear != null
    && input.startYear > input.endYear
  ) {
    throw new Error("startYear cannot be greater than endYear");
  }

  let project: string | undefined;
  if (input.project?.trim()) {
    try {
      project = assertSafeProjectSlug(input.project.trim());
    } catch (error) {
      if (error instanceof InvalidSlugError) {
        throw new Error(error.message);
      }
      throw error;
    }
  }

  const sources = uniqueSources(input.sources ?? DEFAULT_RESEARCH_LANDSCAPE_SOURCES);

  return {
    query,
    exactTitle: input.exactTitle?.trim() || undefined,
    project,
    sources,
    perSourceLimit: clamp(input.perSourceLimit, DEFAULT_PER_SOURCE_LIMIT, 1, 50),
    retainedLimit: clamp(input.retainedLimit, DEFAULT_RETAINED_LIMIT, 1, 50),
    startYear: normalizeYear(input.startYear),
    endYear: normalizeYear(input.endYear),
    retryCount: clamp(input.retryCount, DEFAULT_RETRY_COUNT, 0, 3),
  };
}

function normalizeYear(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Math.trunc(value);
}

function clamp(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  return Math.min(max, Math.max(min, value ?? fallback));
}

function uniqueSources(sources: ResearchLandscapeSource[]): ResearchLandscapeSource[] {
  const normalized = [...new Set(sources)].filter((source): source is ResearchLandscapeSource =>
    DEFAULT_RESEARCH_LANDSCAPE_SOURCES.includes(source),
  );
  return normalized.length > 0 ? normalized : [...DEFAULT_RESEARCH_LANDSCAPE_SOURCES];
}

function classifyRunStatus(
  collectedCandidates: number,
  failures: ResearchLandscapeFailure[],
): ResearchLandscapeStatus {
  if (collectedCandidates === 0 && failures.length > 0) {
    return "failed";
  }
  return failures.length > 0 ? "partial" : "completed";
}

function buildArtifactStem(
  input: Required<Pick<ResearchLandscapeInput, "query">>
    & Pick<ResearchLandscapeInput, "exactTitle" | "project" | "startYear" | "endYear">
    & { sources: ResearchLandscapeSource[] },
  now: Date,
): string {
  const datePrefix = now.toISOString().slice(0, 10);
  const label = (input.exactTitle ?? input.query)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
    || "research-landscape";
  const hash = createHash("sha256")
    .update(JSON.stringify({
      query: input.query,
      exactTitle: input.exactTitle,
      project: input.project,
      sources: input.sources,
      startYear: input.startYear,
      endYear: input.endYear,
    }))
    .digest("hex")
    .slice(0, 8);
  return `${datePrefix}-${label}-${hash}`;
}

function buildPacketFrontmatter(
  input: Required<Pick<ResearchLandscapeInput, "query">>
    & Pick<ResearchLandscapeInput, "exactTitle" | "project" | "startYear" | "endYear">
    & { sources: ResearchLandscapeSource[] },
  now: Date,
  userHandle: string,
  status: ResearchLandscapeStatus,
  retained: ResearchLandscapeRetainedCandidate[],
  duplicatesDropped: number,
  failures: ResearchLandscapeFailure[],
): Record<string, unknown> {
  return {
    date: now.toISOString().slice(0, 10),
    tags: packetTags(input.project),
    para: "resources",
    status,
    query: input.query,
    exact_title: input.exactTitle,
    sources: input.sources,
    start_year: input.startYear,
    end_year: input.endYear,
    retained_count: retained.length,
    duplicates_dropped: duplicatesDropped,
    failure_count: failures.length,
    study: input.project,
    study_slug: input.project,
    legacy_project_slug: input.project,
    created_by: userHandle,
  };
}

function buildJournalFrontmatter(
  input: Required<Pick<ResearchLandscapeInput, "query">>
    & Pick<ResearchLandscapeInput, "exactTitle" | "project">
    & { sources: ResearchLandscapeSource[] },
  now: Date,
  userHandle: string,
  status: ResearchLandscapeStatus,
  sourceRuns: ResearchLandscapeResult["sourceRuns"],
  failures: ResearchLandscapeFailure[],
): Record<string, unknown> {
  return {
    date: now.toISOString().slice(0, 10),
    tags: journalTags(input.project),
    para: "resources",
    status,
    query: input.query,
    exact_title: input.exactTitle,
    sources: input.sources,
    source_runs: sourceRuns.map((run) => ({
      source: run.source,
      status: run.status,
      attempts: run.attempts,
      candidates: run.candidatesAfterYearFilter,
    })),
    failure_count: failures.length,
    study: input.project,
    study_slug: input.project,
    legacy_project_slug: input.project,
    created_by: userHandle,
  };
}

function renderPacketBody(
  input: Required<Pick<ResearchLandscapeInput, "query">>
    & Pick<ResearchLandscapeInput, "exactTitle" | "project" | "startYear" | "endYear">
    & { sources: ResearchLandscapeSource[] },
  retainedWrites: ResearchLandscapeRetainedWrite[],
  duplicates: ReturnType<typeof dedupeResearchLandscapeCandidates>["duplicates"],
  sourceRuns: ResearchLandscapeResult["sourceRuns"],
  titleResolution: ResearchLandscapeResult["titleResolution"],
): string {
  const lines: string[] = [
    `# Research Packet: ${input.exactTitle ?? input.query}`,
    "",
    "## Scope",
    `- Query: ${input.query}`,
  ];
  if (input.exactTitle) lines.push(`- Exact title: ${input.exactTitle}`);
  if (input.project) lines.push(`- Study: ${input.project}`);
  lines.push(`- Sources: ${input.sources.join(", ")}`);
  if (input.startYear != null || input.endYear != null) {
    lines.push(`- Year window: ${input.startYear ?? "any"}-${input.endYear ?? "any"}`);
  }
  lines.push(
    `- Collected candidates: ${sourceRuns.reduce((sum, run) => sum + run.candidatesAfterYearFilter, 0)}`,
    `- Retained candidates: ${retainedWrites.length}`,
    `- Dropped duplicates: ${duplicates.length}`,
    "",
  );

  if (titleResolution) {
    lines.push(
      "## Exact-title Resolution",
      `- Target: ${titleResolution.target}`,
      `- Status: ${titleResolution.status}`,
      `- Matches: ${titleResolution.matchedCount}`,
      "",
    );
  }

  lines.push("## Retained Papers");
  if (retainedWrites.length === 0) {
    lines.push("", "- No retained papers matched the requested scope.", "");
  } else {
    for (const [index, write] of retainedWrites.entries()) {
      const persistedSlug = write.persisted?.slug;
      const title = write.candidate.entity.payload.title;
      const year = write.candidate.entity.payload.year ?? "n.d.";
      const venue = write.candidate.entity.payload.venue.name || "Unknown venue";
      const abstract = write.candidate.entity.payload.abstract?.trim();
      lines.push(
        "",
        `### ${index + 1}. ${title}`,
        `- Brain page: ${persistedSlug ? `[[${persistedSlug}|${title}]]` : "_not persisted_"}`,
        `- Sources: ${write.candidate.sources.join(", ")}`,
        `- Year: ${year}`,
        `- Venue: ${venue}`,
      );
      if (write.persisted) {
        lines.push(`- Write status: ${write.persisted.write_status}`);
      }
      if (write.error) {
        lines.push(`- Persistence error: ${write.error}`);
      }
      if (abstract) {
        lines.push("", "#### Abstract", abstract);
      }
    }
    lines.push("");
  }

  lines.push("## Dropped Duplicates");
  if (duplicates.length === 0) {
    lines.push("", "- No duplicate candidates were dropped.", "");
  } else {
    for (const duplicate of duplicates) {
      const similarity = duplicate.similarity == null ? "" : ` (similarity ${duplicate.similarity.toFixed(2)})`;
      lines.push(
        "",
        `- ${duplicate.droppedTitle} from ${duplicate.droppedSource} merged into ${duplicate.keptTitle} via ${duplicate.reason}${similarity}.`,
      );
    }
    lines.push("");
  }

  const sourceFailures = sourceRuns.filter((run) => run.status === "failed");
  lines.push("## Source Failures");
  if (sourceFailures.length === 0) {
    lines.push("", "- No source failures recorded.", "");
  } else {
    for (const failure of sourceFailures) {
      lines.push("", `- ${failure.source}: ${failure.error ?? "unknown error"}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function renderJournalBody(
  input: Required<Pick<ResearchLandscapeInput, "query">>
    & Pick<ResearchLandscapeInput, "exactTitle" | "project">
    & { sources: ResearchLandscapeSource[] },
  status: ResearchLandscapeStatus,
  retainedWrites: ResearchLandscapeRetainedWrite[],
  duplicates: ReturnType<typeof dedupeResearchLandscapeCandidates>["duplicates"],
  sourceRuns: ResearchLandscapeResult["sourceRuns"],
  failures: ResearchLandscapeFailure[],
  packetSlug: string,
): string {
  const lines: string[] = [
    `# Research Landscape Journal: ${input.exactTitle ?? input.query}`,
    "",
    "## Run",
    `- Status: ${status}`,
    `- Query: ${input.query}`,
    `- Packet: [[${packetSlug}|Research packet]]`,
  ];
  if (input.exactTitle) lines.push(`- Exact title: ${input.exactTitle}`);
  if (input.project) lines.push(`- Study: ${input.project}`);
  lines.push(`- Sources: ${input.sources.join(", ")}`, "");

  lines.push("## Source Runs");
  for (const run of sourceRuns) {
    lines.push(
      "",
      `### ${run.source}`,
      `- Status: ${run.status}`,
      `- Attempts: ${run.attempts}`,
      `- Candidates fetched: ${run.candidatesFetched}`,
      `- Candidates after year filter: ${run.candidatesAfterYearFilter}`,
    );
    if (run.error) lines.push(`- Error: ${run.error}`);
  }
  lines.push("");

  lines.push("## Retained Writes");
  if (retainedWrites.length === 0) {
    lines.push("", "- No retained papers were written.", "");
  } else {
    for (const write of retainedWrites) {
      lines.push(
        "",
        `- ${write.candidate.entity.payload.title}: ${write.persisted?.write_status ?? "failed"}`,
      );
    }
    lines.push("");
  }

  lines.push("## Failures");
  if (failures.length === 0) {
    lines.push("", "- No failures recorded.", "");
  } else {
    for (const failure of failures) {
      lines.push(
        "",
        `- ${failure.stage}${failure.source ? `/${failure.source}` : ""}${failure.title ? ` (${failure.title})` : ""}: ${failure.message}`,
      );
    }
    lines.push("");
  }

  lines.push("## Duplicate Summary", "", `- Duplicates dropped: ${duplicates.length}`, "");
  return lines.join("\n").trim();
}

function renderPacketTimeline(
  now: Date,
  status: ResearchLandscapeStatus,
  retainedWrites: ResearchLandscapeRetainedWrite[],
  duplicatesDropped: number,
  failureCount: number,
): string {
  return [
    `### ${now.toISOString()}`,
    `- status: ${status}`,
    `- retained_writes: ${retainedWrites.length}`,
    `- duplicates_dropped: ${duplicatesDropped}`,
    `- failures: ${failureCount}`,
  ].join("\n");
}

function renderJournalTimeline(
  now: Date,
  status: ResearchLandscapeStatus,
  sourceRuns: ResearchLandscapeResult["sourceRuns"],
  failures: ResearchLandscapeFailure[],
): string {
  return [
    `### ${now.toISOString()}`,
    `- status: ${status}`,
    `- source_runs: ${sourceRuns.length}`,
    `- failures: ${failures.length}`,
  ].join("\n");
}

function buildPacketLinks(
  project: string | undefined,
  packetSlug: string,
  retainedWrites: ResearchLandscapeRetainedWrite[],
): PersistTransactionLinkInput[] {
  const links: PersistTransactionLinkInput[] = [];
  if (project) {
    links.push({
      from: project,
      to: packetSlug,
      context: "research_landscape",
      linkType: "supports",
    });
  }
  for (const write of retainedWrites) {
    if (!write.persisted?.slug) continue;
    links.push({
      from: packetSlug,
      to: write.persisted.slug,
      context: "retained_candidate",
      linkType: "supports",
    });
  }
  return links;
}

function buildJournalLinks(
  project: string | undefined,
  journalSlug: string,
  packetSlug: string,
): PersistTransactionLinkInput[] {
  const links: PersistTransactionLinkInput[] = [{
    from: journalSlug,
    to: packetSlug,
    context: "packet_artifact",
    linkType: "supports",
  }];
  if (project) {
    links.push({
      from: project,
      to: journalSlug,
      context: "research_landscape",
      linkType: "supports",
    });
  }
  return links;
}

function packetTags(project: string | undefined): string[] {
  return [project, "research-packet", "research-landscape"].filter(Boolean) as string[];
}

function journalTags(project: string | undefined): string[] {
  return [project, "overnight-journal", "research-landscape-run"].filter(Boolean) as string[];
}
