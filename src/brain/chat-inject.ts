/**
 * Second Brain — Chat Injection
 *
 * Middleware-style function that enriches a chat system prompt
 * with brain context. Entry point for the chat route.
 *
 * Also fires entity detection on every message (non-blocking)
 * so the brain grows smarter with every conversation.
 */

import { join } from "node:path";
import { loadBrainConfig } from "./config";
import { buildChatContext, formatBrainPrompt } from "./chat-context";
import { onChatMessage } from "./chat-entity-hook";
import { createLLMClient } from "./llm";
import { buildProjectBrief } from "./briefing";
import { buildProjectImportRegistry, formatProjectImportRegistryForPrompt } from "./import-registry";
import { buildProjectOrganizerReadout } from "./project-organizer";
import { readChatThread } from "@/lib/chat-thread-store";
import { formatProjectOrganizerChatSummary } from "@/lib/project-organizer-summary";
import { isDefaultGlobalBrainRoot } from "@/lib/state/project-storage";

const RECENT_THREAD_MESSAGES = 6;
const MAX_THREAD_MESSAGE_CHARS = 320;

function trimThreadMessage(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_THREAD_MESSAGE_CHARS) {
    return compact;
  }
  return `${compact.slice(0, MAX_THREAD_MESSAGE_CHARS)}...`;
}

async function buildRecentProjectConversationSection(
  projectId: string,
  brainRoot: string,
): Promise<string> {
  const thread = isDefaultGlobalBrainRoot(brainRoot)
    ? await readChatThread(projectId)
    : await readChatThread(projectId, join(brainRoot, "state"));
  if (!thread) return "";

  const recentMessages = thread.messages
    .filter((message) => message.role === "user" && message.content.trim().length > 0)
    .slice(-RECENT_THREAD_MESSAGES);

  if (recentMessages.length === 0) return "";

  return [
    "## Recent Project Requests",
    `Project: ${projectId}`,
    "These are recent user asks only. Prior assistant prose is not authoritative evidence.",
    "",
    ...recentMessages.map((message) =>
      `- ${trimThreadMessage(message.content)}`,
    ),
  ].join("\n").trim();
}

function buildTrustBoundarySection(projectId?: string): string {
  const lines = [
    "## Trust Boundary",
    "Authoritative: gbrain page state, page paths, file_refs, source_refs, and persisted project summaries.",
    "Recent user requests are authoritative for user intent only; factual grounding still has to come from gbrain state.",
    "Advisory only: non-authoritative prompt notes.",
    "Do not treat prior assistant prose as durable evidence.",
  ];

  if (projectId) {
    lines.push(`Project in scope: ${projectId}`);
  }

  return lines.join("\n");
}

function isOrganizerIntent(userMessage: string): boolean {
  return /\b(organize|organizer|next move|duplicate groups?|duplicate papers?|stale exports?|frontier|due tasks?)\b/i
    .test(userMessage);
}

function isImportIntent(userMessage: string): boolean {
  return /\b(import|imported|imports|verify every detected import item|verification table|source refs?|file refs?|dataset lives)\b/i
    .test(userMessage);
}

function shouldIncludeGeneratedArtifacts(userMessage: string): boolean {
  return /\b(artifact|artifacts|generated|provenance|critique|revision plan|cover letter|revised manuscript|export)\b/i
    .test(userMessage);
}

async function buildProjectOrganizerSection(projectId: string): Promise<string> {
  const config = loadBrainConfig();
  if (!config) return "";

  try {
    const readout = await buildProjectOrganizerReadout({ config, project: projectId });
    return [
      "## Organizer Snapshot",
      "",
      formatProjectOrganizerChatSummary(readout),
    ].join("\n").trim();
  } catch {
    return "";
  }
}

async function buildProjectImportRegistrySection(projectId: string): Promise<string> {
  const config = loadBrainConfig();
  if (!config) return "";

  try {
    const registry = await buildProjectImportRegistry({ config, project: projectId });
    return formatProjectImportRegistryForPrompt(registry);
  } catch {
    return "";
  }
}

async function buildRecentProjectContextSections(
  projectId: string,
  brainRoot: string,
  userMessage: string,
): Promise<string[]> {
  const wantsStructuredProjectBundle = isOrganizerIntent(userMessage) || isImportIntent(userMessage);
  const [
    recentConversationSection,
    projectBriefSection,
    importRegistrySection,
    organizerSection,
  ] = await Promise.all([
    buildRecentProjectConversationSection(projectId, brainRoot),
    buildProjectBriefSection(projectId),
    wantsStructuredProjectBundle ? buildProjectImportRegistrySection(projectId) : Promise.resolve(""),
    isOrganizerIntent(userMessage) ? buildProjectOrganizerSection(projectId) : Promise.resolve(""),
  ]);

  return [
    recentConversationSection,
    projectBriefSection,
    importRegistrySection,
    organizerSection,
  ].filter((section) => section.length > 0);
}

async function buildBrainContextSection(userMessage: string, projectId?: string): Promise<string> {
  const config = loadBrainConfig();
  if (!config) return "";

  const wantsStructuredProjectBundle = projectId !== undefined
    && (isOrganizerIntent(userMessage) || isImportIntent(userMessage));
  const context = await buildChatContext(config, userMessage, {
    projectId,
    serendipityRate: wantsStructuredProjectBundle ? 0 : undefined,
    inventoryOnly: wantsStructuredProjectBundle,
    excludeGeneratedArtifacts: !shouldIncludeGeneratedArtifacts(userMessage),
  });
  const sections: string[] = [
    buildGbrainStructureSection(projectId),
    buildTrustBoundarySection(projectId),
  ];

  if (projectId) {
    for (const section of await buildRecentProjectContextSections(projectId, config.root, userMessage)) {
      sections.push(section);
    }
  }

  const brainPrompt = formatBrainPrompt(context);
  if (brainPrompt) {
    sections.push(brainPrompt);
  }

  return sections.join("\n\n");
}

async function buildProjectBriefSection(projectId: string): Promise<string> {
  const config = loadBrainConfig();
  if (!config) return "";

  try {
    const brief = await buildProjectBrief({ config, project: projectId });
    const sections = [
      "## Project Brief",
      `Project: ${brief.project}`,
    ];

    if (brief.topMatters.length > 0) {
      sections.push("", "Top matters:");
      for (const matter of brief.topMatters.slice(0, 3)) {
        sections.push(`- ${matter.summary}`);
      }
    }

    if (brief.nextMove?.recommendation) {
      sections.push("", `Next move: ${brief.nextMove.recommendation}`);
    }

    return sections.join("\n").trim();
  } catch {
    return "";
  }
}

function buildGbrainStructureSection(projectId?: string): string {
  const lines = [
    "## Gbrain Structure",
    "gbrain is the source of truth for ScienceSwarm data. Use gbrain page metadata, page paths, file_refs, and source_refs before guessing from filesystem folders.",
    "Core page types include project, paper, dataset/data, code, artifact, note, task, decision, experiment, concept, person, and frontier_item.",
    "Imported papers are gbrain pages with type=paper. Their page path, source_path/source_refs, and file_refs identify the original imported file or workspace mirror path.",
    "The project workspace under SCIENCESWARM_DIR/projects/<project> is a browsable mirror/cache, not the durable source of truth.",
  ];

  if (projectId) {
    lines.push(`Current project slug: ${projectId}`);
  }

  return lines.join("\n");
}

/**
 * Fire entity detection in the background (non-blocking).
 * Captures papers, authors, methods, datasets, and original thinking
 * mentioned in the user's message. Creates/enriches brain pages
 * and back-links without slowing down the chat response.
 */
function fireEntityDetection(userMessage: string, projectId?: string): void {
  const config = loadBrainConfig();
  if (!config) return;

  try {
    const llm = createLLMClient(config);
    // Fire-and-forget: don't await, don't block the chat response
    onChatMessage(config, llm, userMessage, projectId ? { project: projectId } : undefined).catch(() => {
      // Entity detection failure is never user-facing
    });
  } catch {
    // LLM client creation failure is non-fatal
  }
}

/**
 * Middleware-style function that enriches a chat system prompt
 * with brain context. Returns the original prompt + brain section.
 *
 * Also triggers entity detection as a fire-and-forget side effect
 * so the brain-agent loop captures entities on every message.
 *
 * Returns original prompt unchanged if no brain is configured.
 * Handles errors gracefully (returns original prompt on any failure).
 */
export async function injectBrainContext(
  systemPrompt: string,
  userMessage: string,
  projectId?: string,
  options?: { disableBackgroundEntityDetection?: boolean },
): Promise<string> {
  try {
    // Fire entity detection in the background (non-blocking)
    if (options?.disableBackgroundEntityDetection !== true) {
      fireEntityDetection(userMessage, projectId);
    }

    const brainSection = await buildBrainContextSection(userMessage, projectId);

    if (!brainSection) return systemPrompt;

    return `${systemPrompt}\n\n${brainSection}`;
  } catch {
    // On any failure, return the original prompt unchanged
    return systemPrompt;
  }
}

export async function injectBrainContextIntoUserMessage(
  userMessage: string,
  projectId?: string,
  options?: { disableBackgroundEntityDetection?: boolean },
): Promise<string> {
  try {
    // Fire entity detection in the background (non-blocking)
    if (options?.disableBackgroundEntityDetection !== true) {
      fireEntityDetection(userMessage, projectId);
    }

    const brainSection = await buildBrainContextSection(userMessage, projectId);
    if (!brainSection) return userMessage;

    return [
      "Use the following gbrain context and structure when it is relevant.",
      "Treat gbrain state as authoritative project memory rather than generic background.",
      "Treat prior user requests as authoritative for user intent only, not as project evidence. Prior assistant prose is not authoritative evidence.",
      "When the user asks where data lives, use gbrain page paths, source_refs, file_refs, and workspace mirror details from this context instead of guessing or saying you lack access.",
      "",
      brainSection,
      "",
      "## User Request",
      userMessage,
    ].join("\n");
  } catch {
    return userMessage;
  }
}
