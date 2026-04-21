export interface ProjectOrganizerImportSummary {
  name: string;
  preparedFiles: number;
  detectedItems?: number;
  detectedBytes?: number;
  duplicateGroups?: number;
  generatedAt: string;
  source: string;
}

export interface ProjectOrganizerTask {
  path: string;
  title: string;
  status: string;
}

export interface ProjectOrganizerFrontierItem {
  path: string;
  title: string;
  status: string;
  whyItMatters: string;
}

export interface ProjectOrganizerThread {
  label: string;
  confidence: "high" | "medium" | "low";
  pageCount: number;
  pageTypes: string[];
  keywords: string[];
  evidence: Array<{
    path: string;
    title: string;
    type: string;
  }>;
}

export interface ProjectOrganizerDuplicate {
  a: string;
  b: string;
  reason: "shared-doi" | "title-similarity";
  similarity: number;
}

export interface ProjectOrganizerImportDuplicateGroup {
  id: string;
  members: string[];
  reason: string;
  hashPrefix?: string;
  contentType: string;
}

export interface ProjectOrganizerStaleExport {
  slug: string;
  projectPath: string;
  title: string;
  generatedAt?: string;
  trackedSourceCount: number;
  staleSources: Array<{
    slug: string;
    title: string;
    reason: "updated-source" | "missing-source";
    workspacePath?: string;
    observedAt?: string;
  }>;
}

export interface ProjectOrganizerReadout {
  project: string;
  generatedAt: string;
  pageCount: number;
  pageScanLimit: number;
  pageScanLimitReached: boolean;
  pageCountsByType: Record<string, number>;
  importSummary: ProjectOrganizerImportSummary | null;
  threads: ProjectOrganizerThread[];
  duplicatePapers: ProjectOrganizerDuplicate[];
  importDuplicateGroups: ProjectOrganizerImportDuplicateGroup[];
  trackedExportCount: number;
  staleExports: ProjectOrganizerStaleExport[];
  nextMove?: {
    recommendation?: string;
  };
  dueTasks: ProjectOrganizerTask[];
  frontier: ProjectOrganizerFrontierItem[];
  suggestedPrompts: string[];
}

export interface ProjectOrganizerPromptSource {
  threads: ProjectOrganizerThread[];
  duplicatePapers: ProjectOrganizerDuplicate[];
  importDuplicateGroups: ProjectOrganizerImportDuplicateGroup[];
  staleExports: ProjectOrganizerStaleExport[];
  nextMove?: {
    recommendation?: string;
  };
  frontier: ProjectOrganizerFrontierItem[];
}

function formatCount(label: string, count: number): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatThread(thread: ProjectOrganizerThread): string {
  const keywords = thread.keywords.slice(0, 3).join(", ");
  const basis = keywords.length > 0 ? `; keywords: ${keywords}` : "";
  return `${thread.label} (${formatCount("page", thread.pageCount)}; ${thread.confidence} confidence${basis})`;
}

function formatDuplicate(duplicate: ProjectOrganizerDuplicate): string {
  const reason = duplicate.reason === "shared-doi" ? "shared DOI" : "similar title";
  const score = duplicate.reason === "title-similarity"
    ? `, similarity ${(duplicate.similarity * 100).toFixed(0)}%`
    : "";
  return `${duplicate.a} <> ${duplicate.b} (${reason}${score})`;
}

function formatStaleExport(staleExport: ProjectOrganizerStaleExport): string {
  const updatedSources = staleExport.staleSources
    .filter((source) => source.reason === "updated-source")
    .slice(0, 2)
    .map((source) => source.workspacePath || source.slug)
    .join(", ");
  const missingSources = staleExport.staleSources
    .filter((source) => source.reason === "missing-source")
    .slice(0, 2)
    .map((source) => source.workspacePath || source.slug)
    .join(", ");
  const details = [
    updatedSources ? `updated source: ${updatedSources}` : "",
    missingSources ? `missing source: ${missingSources}` : "",
  ].filter(Boolean).join("; ");
  return details
    ? `${staleExport.projectPath} (${details})`
    : staleExport.projectPath;
}

export function buildProjectOrganizerSuggestedPrompts(
  readout: ProjectOrganizerPromptSource,
): string[] {
  const prompts: string[] = [];

  if (readout.threads.length > 0) {
    prompts.push(`Explain the ${readout.threads[0].label} thread and what to do next.`);
  }
  if (readout.duplicatePapers.length > 0) {
    prompts.push("Show me the possible duplicate papers and tell me which copies to keep.");
  } else if (readout.importDuplicateGroups.length > 0) {
    prompts.push("List the exact recorded import duplicate groups and tell me whether any are actual duplicate papers.");
  }
  if (readout.staleExports.length > 0) {
    prompts.push("Show me the stale exports and tell me what needs to be regenerated.");
  }
  if (readout.nextMove?.recommendation) {
    prompts.push("Turn the next move into concrete tasks.");
  } else if (readout.frontier.length > 0) {
    prompts.push(`Summarize why ${readout.frontier[0].title} matters for this project.`);
  } else {
    prompts.push("Suggest the next pages or tasks to create for this project.");
  }

  return prompts.slice(0, 3);
}

export function formatProjectOrganizerChatSummary(readout: ProjectOrganizerReadout): string {
  const lines: string[] = [];

  if (readout.importSummary) {
    const detectedScope =
      typeof readout.importSummary.detectedItems === "number"
        ? ` from ${readout.importSummary.detectedItems.toLocaleString("en-US")} detected items`
        : "";
    lines.push(
      `Imported **${readout.importSummary.name}** into **${readout.project}** ` +
      `(${readout.importSummary.preparedFiles.toLocaleString("en-US")} files${detectedScope}).`,
    );
  } else {
    lines.push(`Organizer summary for **${readout.project}**.`);
  }

  lines.push("");

  if (readout.pageScanLimitReached) {
    lines.push(
      `- Coverage warning: organizer scan limit reached at ${readout.pageScanLimit.toLocaleString("en-US")} pages, so findings may be partial.`,
    );
  }

  if (readout.threads.length > 0) {
    lines.push(`- Candidate threads: ${readout.threads.slice(0, 3).map(formatThread).join("; ")}`);
  } else {
    lines.push("- Candidate threads: not enough repeated tags or titles yet to infer a stable cluster.");
  }

  if (readout.duplicatePapers.length > 0) {
    lines.push(
      `- Possible duplicate papers: ${readout.duplicatePapers.slice(0, 3).map(formatDuplicate).join("; ")}`,
    );
  } else {
    lines.push("- Possible duplicate papers: none surfaced from the current gbrain project pages.");
  }

  if (readout.importDuplicateGroups.length > 0) {
    lines.push(
      `- Import duplicate groups: ${readout.importDuplicateGroups.slice(0, 3).map((group) => {
        const members = group.members.join(", ");
        const hash = group.hashPrefix ? `, hash ${group.hashPrefix}` : "";
        return `${group.contentType}: ${members}${hash}`;
      }).join("; ")}`,
    );
  } else if ((readout.importSummary?.duplicateGroups ?? 0) > 0) {
    lines.push(
      `- Import duplicate groups: ${readout.importSummary!.duplicateGroups} recorded group(s) were flagged during import, but the exact member list is not currently available.`,
    );
  } else {
    lines.push("- Import duplicate groups: none recorded in the current import state.");
  }

  if (readout.staleExports.length > 0) {
    lines.push(
      `- Stale exports: ${readout.staleExports.slice(0, 3).map(formatStaleExport).join("; ")}`,
    );
  } else if (readout.trackedExportCount > 0) {
    lines.push(
      `- Stale exports: none across ${readout.trackedExportCount} tracked export${readout.trackedExportCount === 1 ? "" : "s"}.`,
    );
  } else {
    lines.push("- Stale exports: none with tracked gbrain source snapshots yet.");
  }

  if (readout.nextMove?.recommendation) {
    lines.push(`- Next move: ${readout.nextMove.recommendation}`);
  }

  if (readout.dueTasks.length > 0) {
    lines.push(`- Open tasks: ${readout.dueTasks.slice(0, 3).map((task) => task.title).join("; ")}`);
  }

  if (readout.frontier.length > 0) {
    lines.push(`- Frontier to watch: ${readout.frontier.slice(0, 2).map((item) => item.title).join("; ")}`);
  }

  const prompts = readout.suggestedPrompts.length > 0
    ? readout.suggestedPrompts
    : buildProjectOrganizerSuggestedPrompts(readout);
  if (prompts.length > 0) {
    lines.push("");
    lines.push("Try asking:");
    lines.push(...prompts.map((prompt) => `- ${prompt}`));
  }

  return lines.join("\n");
}
