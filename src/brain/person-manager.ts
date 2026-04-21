/**
 * Second Brain — Person Manager
 *
 * Enhanced person profiles for team members, collaborators, and contacts.
 * Not just paper authors — tracks relationship history, open threads,
 * meeting-sourced context, and key topics.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import matter from "gray-matter";
import type { BrainConfig } from "./types";
import { slugify } from "./entity-detector";

// ── Public Types ─────────────────────────────────────

export type PersonRelationship =
  | "team-member"
  | "collaborator"
  | "author"
  | "contact";

export interface PersonProfile {
  name: string;
  role?: string;
  affiliation?: string;
  relationship: PersonRelationship;
  lastInteraction?: string;
  meetingCount: number;
  openThreads: string[];
  keyTopics: string[];
}

// ── Core Functions ──────────────────────────────────

/**
 * Update a person page with meeting-derived context.
 *
 * - Adds timeline entry with meeting reference
 * - Updates "Recent Meetings" section
 * - Tracks open threads from this person
 * - Updates "Key Topics" with what they discussed
 */
export function updatePersonFromMeeting(
  config: BrainConfig,
  personPath: string,
  meetingPath: string,
  context: {
    statements: string[];
    decisions: string[];
    actionItems: string[];
    keyTopics?: string[];
    /** Meeting date (YYYY-MM-DD). Falls back to today if omitted. */
    date?: string;
  }
): void {
  const absPath = join(config.root, personPath);
  if (!existsSync(absPath)) return;

  let content = readFileSync(absPath, "utf-8");
  const date = context.date ?? new Date().toISOString().slice(0, 10);
  const meetingEntry = `- **${date}** | [[${meetingPath}]]`;
  const meetingAlreadyRecorded = sectionContainsText(
    content,
    "## Recent Meetings",
    `[[${meetingPath}]]`,
  );

  if (!meetingAlreadyRecorded) {
    const meetingCountMatch = content.match(/meetingCount:\s*(\d+)/);
    if (meetingCountMatch) {
      const currentCount = parseInt(meetingCountMatch[1], 10);
      content = content.replace(
        /meetingCount:\s*\d+/,
        `meetingCount: ${currentCount + 1}`
      );
    }

    content = appendToSection(
      content,
      "## Recent Meetings",
      meetingEntry,
      "None yet."
    );
  }

  // Add open threads from action items
  for (const actionItem of context.actionItems) {
    const threadEntry = `- [ ] ${actionItem} (from [[${meetingPath}]])`;
    if (
      !sectionContainsText(
        content,
        "## Open Threads",
        `${actionItem} (from [[${meetingPath}]])`,
      )
    ) {
      content = appendToSection(
        content,
        "## Open Threads",
        threadEntry,
        "None yet."
      );
    }
  }

  for (const topic of context.keyTopics ?? []) {
    if (!sectionContainsText(content, "## Key Topics", `- ${topic}`)) {
      content = appendToSection(
        content,
        "## Key Topics",
        `- ${topic}`,
        "None yet."
      );
    }
  }

  // Add timeline entry
  const summaryParts: string[] = [];
  if (context.statements.length > 0) {
    summaryParts.push(
      `Discussed: ${context.statements.slice(0, 2).join("; ").slice(0, 120)}`
    );
  }
  if (context.decisions.length > 0) {
    summaryParts.push(`Decisions: ${context.decisions.join(", ")}`);
  }
  const timelineEntry =
    `- **${date}** | Meeting [[${meetingPath}]] — ` +
    `${summaryParts.join(". ") || "Attended"}`;
  if (!sectionContainsText(content, "## Timeline", `[[${meetingPath}]]`)) {
    content = appendToSection(content, "## Timeline", timelineEntry);
  }

  writeFileSync(absPath, content);
}

/**
 * Quick lookup for meeting prep: last interaction, meeting count,
 * open threads, key topics.
 */
export function getPersonBrief(
  config: BrainConfig,
  name: string
): PersonProfile | null {
  const personPath = getPersonPagePath(name);
  const absPath = join(config.root, personPath);

  if (!existsSync(absPath)) return null;

  const content = readFileSync(absPath, "utf-8");
  const parsed = matter(content);
  const fm = parsed.data;

  // Extract open threads from ## Open Threads section
  const openThreads = extractListItems(content, "## Open Threads");

  // Extract key topics from ## Key Topics section
  const keyTopics = extractListItems(content, "## Key Topics");

  // Extract last interaction from ## Timeline (first entry = most recent)
  const lastInteraction = extractLastDate(content, "## Timeline");

  return {
    name: (fm.name as string) ?? name,
    role: fm.role as string | undefined,
    affiliation: fm.affiliation as string | undefined,
    relationship: validateRelationship(fm.relationship as string),
    lastInteraction: lastInteraction ?? undefined,
    meetingCount: typeof fm.meetingCount === "number" ? fm.meetingCount : 0,
    openThreads,
    keyTopics,
  };
}

/**
 * Ensure a person page exists; create from scratch if not.
 */
export function ensurePersonPage(
  config: BrainConfig,
  name: string,
  defaults?: {
    role?: string;
    affiliation?: string;
    relationship?: PersonRelationship;
  }
): string {
  const personDir = join(config.root, "wiki/entities/people");
  mkdirSync(personDir, { recursive: true });

  const personPath = getPersonPagePath(name);
  const absPath = join(config.root, personPath);

  if (existsSync(absPath)) return personPath;

  const relationship = defaults?.relationship ?? "contact";
  const role = defaults?.role ?? "Unknown";
  const affiliation = defaults?.affiliation ?? "Unknown";

  const content = [
    "---",
    `title: "${escapeYaml(name)}"`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    "type: person",
    "para: resources",
    `tags: [person]`,
    `name: "${escapeYaml(name)}"`,
    `role: "${escapeYaml(role)}"`,
    `affiliation: "${escapeYaml(affiliation)}"`,
    `relationship: ${relationship}`,
    "meetingCount: 0",
    "---",
    "",
    `# ${name}`,
    "",
    "## Executive Summary",
    "",
    `${name} — details to be filled.`,
    "",
    "## Role & Affiliation",
    "",
    `- **Role**: ${role}`,
    `- **Affiliation**: ${affiliation}`,
    "",
    "## Relationship History",
    "",
    `- ${relationship}`,
    "",
    "## What They Research / Build",
    "",
    "To be determined from future interactions.",
    "",
    "## Open Threads",
    "",
    "None yet.",
    "",
    "## Recent Meetings",
    "",
    "None yet.",
    "",
    "## Key Topics",
    "",
    "None yet.",
    "",
    "## Timeline",
    "",
  ].join("\n");

  writeFileSync(absPath, content);
  return personPath;
}

export function getPersonPagePath(name: string): string {
  return `wiki/entities/people/${slugify(name)}.md`;
}

// ── Helpers ──────────────────────────────────────────

function appendToSection(
  content: string,
  sectionHeader: string,
  entry: string,
  placeholderToRemove?: string
): string {
  const idx = content.indexOf(sectionHeader);
  if (idx === -1) {
    return content.trimEnd() + `\n\n${sectionHeader}\n\n${entry}\n`;
  }

  const afterHeader = content.indexOf("\n", idx) + 1;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSection === -1 ? content.length : nextSection;

  let sectionContent = content.slice(afterHeader, sectionEnd);

  if (placeholderToRemove && sectionContent.includes(placeholderToRemove)) {
    sectionContent = sectionContent.replace(placeholderToRemove, "").trim();
  }

  const updatedSection = sectionContent.trimEnd()
    ? sectionContent.trimEnd() + "\n" + entry + "\n"
    : "\n" + entry + "\n";

  return (
    content.slice(0, afterHeader) + updatedSection + content.slice(sectionEnd)
  );
}

function sectionContainsText(
  content: string,
  sectionHeader: string,
  text: string,
): boolean {
  const sectionContent = getSectionContent(content, sectionHeader);
  return sectionContent !== null && sectionContent.includes(text);
}

function getSectionContent(
  content: string,
  sectionHeader: string,
): string | null {
  const idx = content.indexOf(sectionHeader);
  if (idx === -1) return null;

  const afterHeader = content.indexOf("\n", idx) + 1;
  const nextSection = content.indexOf("\n## ", afterHeader);
  const sectionEnd = nextSection === -1 ? content.length : nextSection;
  return content.slice(afterHeader, sectionEnd);
}

function extractListItems(content: string, sectionHeader: string): string[] {
  const sectionContent = getSectionContent(content, sectionHeader);
  if (sectionContent === null) return [];

  const items: string[] = [];
  for (const line of sectionContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") && trimmed !== "- None" && !trimmed.includes("None yet")) {
      // Strip leading "- " and optional "[ ] "
      let item = trimmed.slice(2);
      if (item.startsWith("[ ] ")) item = item.slice(4);
      if (item.startsWith("[x] ")) item = item.slice(4);
      items.push(item);
    }
  }

  return items;
}

function extractLastDate(
  content: string,
  sectionHeader: string
): string | null {
  const sectionContent = getSectionContent(content, sectionHeader);
  if (sectionContent === null) return null;

  // Use last match — appendToSection appends newest entries at the end
  const allDates = [...sectionContent.matchAll(/\*\*(\d{4}-\d{2}-\d{2})\*\*/g)];
  return allDates.length > 0 ? allDates[allDates.length - 1][1] : null;
}

function validateRelationship(value?: string): PersonRelationship {
  const valid: PersonRelationship[] = [
    "team-member",
    "collaborator",
    "author",
    "contact",
  ];
  if (value && valid.includes(value as PersonRelationship)) {
    return value as PersonRelationship;
  }
  return "contact";
}

function escapeYaml(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, " ");
}
