/**
 * Second Brain — Meeting Transcript Ingestion
 *
 * Meetings are the richest signal source. Every meeting produces entity
 * updates across multiple brain pages: attendee profiles, decisions,
 * tasks, and open threads.
 *
 * Pipeline:
 * 1. Parse transcript (diarized, Otter.ai, Circleback, or plain text)
 * 2. Create meeting page with LLM summary + full transcript
 * 3. For each attendee: create or update person page
 * 4. Extract decisions → decision pages
 * 5. Extract action items → task pages
 * 6. Identify open threads
 * 7. Back-link everything bidirectionally
 */

import {
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import type { BrainConfig } from "./types";
import type { LLMClient } from "./llm";
import { ensureBacklinks } from "./backlink";
import { slugify } from "./entity-detector";
import { logEvent } from "./cost";
import {
  ensurePersonPage,
  getPersonBrief,
  updatePersonFromMeeting,
} from "./person-manager";

// ── Public Types ─────────────────────────────────────

export interface MeetingTranscript {
  title: string;
  date: string; // ISO date YYYY-MM-DD
  attendees: string[];
  /** Diarized transcript segments */
  segments: Array<{
    speaker: string;
    timestamp?: string;
    text: string;
  }>;
  /** Raw transcript text (if no diarization) */
  rawText?: string;
}

export interface MeetingIngestResult {
  meetingPagePath: string;
  attendeePagesUpdated: string[];
  attendeePagesCreated: string[];
  decisionsExtracted: string[];
  tasksExtracted: string[];
  openThreads: string[];
  durationMs: number;
}

// ── Transcript Parsing ──────────────────────────────

/**
 * Parse common transcript formats into a normalized MeetingTranscript.
 *
 * Supported formats:
 * - Diarized: "Speaker Name (HH:MM:SS): text" or "Speaker Name: text"
 * - Otter.ai: timestamps + speaker labels
 * - Circleback: structured JSON with attendees, notes, action_items
 * - Plain text fallback: treat as single-speaker narrative
 */
export function parseMeetingTranscript(content: string): MeetingTranscript {
  const trimmed = content.trim();

  // Try Circleback JSON first
  const circlebackResult = tryParseCircleback(trimmed);
  if (circlebackResult) return circlebackResult;

  // Try diarized format
  const diarizedResult = tryParseDiarized(trimmed);
  if (diarizedResult) return diarizedResult;

  // Plain text fallback
  return parsePlainText(trimmed);
}

/**
 * Try to parse as Circleback JSON format:
 * { title, date, attendees, notes, action_items, transcript }
 */
function tryParseCircleback(content: string): MeetingTranscript | null {
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== "object") return null;
    if (!data.attendees && !data.transcript && !data.notes) return null;

    const attendees: string[] = Array.isArray(data.attendees)
      ? data.attendees.map((a: unknown) =>
          typeof a === "string" ? a : (a as { name?: string })?.name ?? String(a)
        )
      : [];

    const segments: MeetingTranscript["segments"] = [];
    if (Array.isArray(data.transcript)) {
      for (const seg of data.transcript) {
        segments.push({
          speaker: seg.speaker ?? "Unknown",
          timestamp: seg.timestamp ?? seg.time,
          text: seg.text ?? seg.content ?? "",
        });
      }
    }

    const rawParts: string[] = [];
    if (data.notes) rawParts.push(String(data.notes));
    if (Array.isArray(data.action_items)) {
      rawParts.push(
        "Action Items:\n" +
          data.action_items
            .map(
              (item: { text?: string; assignee?: string }) =>
                `- ${item.text ?? String(item)}${item.assignee ? ` (${item.assignee})` : ""}`
            )
            .join("\n")
      );
    }

    return {
      title: data.title ?? "Untitled Meeting",
      date: data.date ?? new Date().toISOString().slice(0, 10),
      attendees,
      segments,
      rawText: rawParts.length > 0 ? rawParts.join("\n\n") : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Try to parse diarized transcript format:
 * "Speaker Name (HH:MM:SS): text" or "Speaker Name: text"
 */
function tryParseDiarized(content: string): MeetingTranscript | null {
  // Pattern: "Speaker Name (HH:MM:SS): text" or "Speaker Name (HH:MM): text"
  const timestampedPattern =
    /^(.+?)\s*\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*:\s*(.+)$/;
  // Pattern: "Speaker Name: text" (but must be at line start)
  const simplePattern = /^([A-Z][a-zA-Z\s.'-]+?)\s*:\s*(.+)$/;

  const lines = content.split("\n");
  const segments: MeetingTranscript["segments"] = [];
  const speakerSet = new Set<string>();
  let matchCount = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const tsMatch = trimmedLine.match(timestampedPattern);
    if (tsMatch) {
      const speaker = tsMatch[1].trim();
      speakerSet.add(speaker);
      segments.push({
        speaker,
        timestamp: tsMatch[2],
        text: tsMatch[3].trim(),
      });
      matchCount++;
      continue;
    }

    const simpleMatch = trimmedLine.match(simplePattern);
    if (simpleMatch) {
      const speaker = simpleMatch[1].trim();
      // Avoid matching section headings (e.g. "Decisions:", "Action Items:"),
      // URLs, numbers, or single-word labels that aren't names
      const lowerSpeaker = speaker.toLowerCase();
      const isSectionHeading = [
        "decisions", "action items", "summary", "notes", "context",
        "open threads", "key topics", "agenda", "attendees", "minutes",
        "description", "status", "date", "time", "location",
      ].some((h) => lowerSpeaker === h || lowerSpeaker.startsWith(h + " "));
      if (
        speaker.length < 40 &&
        speaker.split(/\s+/).length >= 2 && // Names have at least 2 words
        !speaker.includes("http") &&
        !speaker.match(/^\d/) &&
        !isSectionHeading
      ) {
        speakerSet.add(speaker);
        segments.push({
          speaker,
          text: simpleMatch[2].trim(),
        });
        matchCount++;
        continue;
      }
    }

    // Continuation of previous speaker's text
    if (segments.length > 0) {
      segments[segments.length - 1].text += " " + trimmedLine;
    }
  }

  // Need at least 2 diarized lines to consider it diarized
  if (matchCount < 2) return null;

  // Extract title from first line if it looks like a header
  let title = "Meeting";
  const firstLine = lines[0]?.trim() ?? "";
  if (firstLine.startsWith("#")) {
    title = firstLine.replace(/^#+\s*/, "");
  }

  return {
    title,
    date: new Date().toISOString().slice(0, 10),
    attendees: Array.from(speakerSet),
    segments,
  };
}

/**
 * Plain text fallback: treat as single-speaker narrative.
 */
function parsePlainText(content: string): MeetingTranscript {
  let title = "Meeting Notes";
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (firstLine.startsWith("#")) {
    title = firstLine.replace(/^#+\s*/, "");
  } else if (firstLine.length > 0 && firstLine.length <= 120) {
    // Use first line as title if it looks like a heading (short, non-empty)
    title = firstLine.replace(/\.+$/, ""); // strip trailing periods
  }

  return {
    title,
    date: new Date().toISOString().slice(0, 10),
    attendees: [],
    segments: [],
    rawText: content,
  };
}

// ── Meeting Ingestion ───────────────────────────────

const MEETING_SUMMARY_PROMPT = `You are a meeting analyst for a scientist's second brain.
Given a meeting transcript, produce:

1. SUMMARY: 3-5 sentence summary reframed through a scientist's priorities.
   Focus on: key decisions, commitments, surprises, unresolved items.

2. DECISIONS: Array of decisions made (each with a short title and description).

3. TASKS: Array of action items (each with assignee, title, and description).

4. OPEN_THREADS: Array of unresolved discussions that need follow-up.

5. KEY_TOPICS: Array of main topics discussed.

Output valid JSON:
{
  "summary": "...",
  "decisions": [{ "title": "...", "description": "..." }],
  "tasks": [{ "assignee": "...", "title": "...", "description": "..." }],
  "openThreads": [{ "topic": "...", "context": "..." }],
  "keyTopics": ["..."]
}`;

interface MeetingAnalysis {
  summary: string;
  decisions: Array<{ title: string; description: string }>;
  tasks: Array<{ assignee: string; title: string; description: string }>;
  openThreads: Array<{ topic: string; context: string }>;
  keyTopics: string[];
}

/**
 * Full meeting ingestion pipeline.
 */
export async function ingestMeeting(
  config: BrainConfig,
  llm: LLMClient,
  transcript: MeetingTranscript
): Promise<MeetingIngestResult> {
  const startTime = Date.now();

  // Validate and sanitize date to prevent path traversal
  transcript.date = sanitizeDate(transcript.date);

  // Build full transcript text for LLM analysis
  const transcriptText = buildTranscriptText(transcript);

  // Analyze via LLM
  const analysis = await analyzeMeeting(llm, transcriptText, config);

  // Create meeting page
  const meetingPagePath = createMeetingPage(
    config,
    transcript,
    analysis,
    transcriptText
  );

  // Process attendees
  const attendeePagesCreated: string[] = [];
  const attendeePagesUpdated: string[] = [];

  // Collect per-speaker statements
  const speakerStatements = collectSpeakerStatements(transcript);

  for (const attendee of transcript.attendees) {
    const existingPerson = getPersonBrief(config, attendee);
    const personPath = ensurePersonPage(config, attendee);

    if (existingPerson) {
      attendeePagesUpdated.push(personPath);
    } else {
      attendeePagesCreated.push(personPath);
    }

    // Find this person's decisions and tasks
    const personDecisions = analysis.decisions
      .filter((d) => d.description.toLowerCase().includes(attendee.toLowerCase()))
      .map((d) => d.title);
    const personTasks = analysis.tasks
      .filter(
        (t) => t.assignee.toLowerCase().includes(attendee.toLowerCase())
      )
      .map((t) => t.title);

    // Update person page with meeting context
    updatePersonFromMeeting(config, personPath, meetingPagePath, {
      statements: speakerStatements.get(attendee) ?? [],
      decisions: personDecisions,
      actionItems: personTasks,
      keyTopics: analysis.keyTopics,
      date: transcript.date,
    });

    // Back-link: person page → meeting page
    ensureBacklinks(
      config,
      personPath,
      meetingPagePath,
      `Attended meeting: ${transcript.title}`,
      transcript.date
    );
  }

  // Create decision pages
  const decisionsExtracted: string[] = [];
  for (const decision of analysis.decisions) {
    const decisionPath = createDecisionPage(
      config,
      decision,
      transcript.date,
      meetingPagePath
    );
    decisionsExtracted.push(decisionPath);

    // Back-link: decision → meeting
    ensureBacklinks(
      config,
      decisionPath,
      meetingPagePath,
      `Decision made during: ${transcript.title}`,
      transcript.date
    );
  }

  // Create task pages
  const tasksExtracted: string[] = [];
  for (const task of analysis.tasks) {
    const taskPath = createTaskPage(
      config,
      task,
      transcript.date,
      meetingPagePath
    );
    tasksExtracted.push(taskPath);

    // Back-link: task → meeting
    ensureBacklinks(
      config,
      taskPath,
      meetingPagePath,
      `Action item from: ${transcript.title}`,
      transcript.date
    );
  }

  // Open threads
  const openThreads = analysis.openThreads.map((t) => t.topic);

  // Back-link: meeting page → attendee pages
  for (const attendee of transcript.attendees) {
    const personPath = `wiki/entities/people/${slugify(attendee)}.md`;
    ensureBacklinks(
      config,
      meetingPagePath,
      personPath,
      `Attendee: ${attendee}`,
      transcript.date
    );
  }

  const durationMs = Date.now() - startTime;

  // Log event
  logEvent(config, {
    ts: new Date().toISOString(),
    type: "ingest",
    contentType: "note",
    created: [
      meetingPagePath,
      ...attendeePagesCreated,
      ...decisionsExtracted,
      ...tasksExtracted,
    ],
    updated: attendeePagesUpdated,
    durationMs,
  });

  return {
    meetingPagePath,
    attendeePagesUpdated,
    attendeePagesCreated,
    decisionsExtracted,
    tasksExtracted,
    openThreads,
    durationMs,
  };
}

// ── Internal Helpers ────────────────────────────────

function buildTranscriptText(transcript: MeetingTranscript): string {
  if (transcript.segments.length > 0) {
    return transcript.segments
      .map((s) => {
        const ts = s.timestamp ? ` (${s.timestamp})` : "";
        return `${s.speaker}${ts}: ${s.text}`;
      })
      .join("\n");
  }
  return transcript.rawText ?? "";
}

async function analyzeMeeting(
  llm: LLMClient,
  transcriptText: string,
  config: BrainConfig
): Promise<MeetingAnalysis> {
  const defaultAnalysis: MeetingAnalysis = {
    summary: "Meeting transcript processed.",
    decisions: [],
    tasks: [],
    openThreads: [],
    keyTopics: [],
  };

  try {
    const response = await llm.complete({
      system: MEETING_SUMMARY_PROMPT,
      user: transcriptText,
      model: config.synthesisModel,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return defaultAnalysis;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: parsed.summary ?? defaultAnalysis.summary,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      openThreads: Array.isArray(parsed.openThreads)
        ? parsed.openThreads
        : [],
      keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics : [],
    };
  } catch {
    return defaultAnalysis;
  }
}

function createMeetingPage(
  config: BrainConfig,
  transcript: MeetingTranscript,
  analysis: MeetingAnalysis,
  transcriptText: string
): string {
  const meetingsDir = join(config.root, "wiki/meetings");
  mkdirSync(meetingsDir, { recursive: true });

  const slug = slugify(transcript.title);
  const filename = `${transcript.date}-${slug}.md`;
  const meetingPagePath = `wiki/meetings/${filename}`;

  const attendeeLinks = transcript.attendees
    .map((a) => `[[wiki/entities/people/${slugify(a)}.md|${a}]]`)
    .join(", ");

  const decisionList =
    analysis.decisions.length > 0
      ? analysis.decisions
          .map((d) => `- **${d.title}**: ${d.description}`)
          .join("\n")
      : "- None recorded";

  const taskList =
    analysis.tasks.length > 0
      ? analysis.tasks
          .map(
            (t) =>
              `- **${t.title}** (${t.assignee}): ${t.description}`
          )
          .join("\n")
      : "- None recorded";

  const threadList =
    analysis.openThreads.length > 0
      ? analysis.openThreads
          .map((t) => `- **${t.topic}**: ${t.context}`)
          .join("\n")
      : "- None identified";

  const content = [
    "---",
    `title: "${escapeYaml(transcript.title)}"`,
    `date: ${transcript.date}`,
    "type: note",
    "para: projects",
    `tags: [meeting]`,
    `attendees: [${transcript.attendees.map((a) => `"${escapeYaml(a)}"`).join(", ")}]`,
    "---",
    "",
    `# ${transcript.title}`,
    "",
    `**Date**: ${transcript.date}`,
    `**Attendees**: ${attendeeLinks || "Not specified"}`,
    "",
    "## Summary",
    "",
    analysis.summary,
    "",
    "## Decisions",
    "",
    decisionList,
    "",
    "## Action Items",
    "",
    taskList,
    "",
    "## Open Threads",
    "",
    threadList,
    "",
    "---",
    "",
    "## Full Transcript",
    "",
    transcriptText,
    "",
    "## Timeline",
    "",
    `- **${transcript.date}** | Meeting ingested`,
    "",
  ].join("\n");

  writeFileSync(join(config.root, meetingPagePath), content);
  return meetingPagePath;
}

function createDecisionPage(
  config: BrainConfig,
  decision: { title: string; description: string },
  date: string,
  meetingPath: string
): string {
  const decisionsDir = join(config.root, "wiki/decisions");
  mkdirSync(decisionsDir, { recursive: true });

  const slug = slugify(decision.title);
  const decisionPath = `wiki/decisions/${date}-${slug}.md`;
  const legacyDecisionPath = `wiki/entities/decisions/${date}-${slug}.md`;

  // Skip if decision already captured under either taxonomy path.
  const existingDecisionPath = findExistingPagePath(
    config,
    decisionPath,
    legacyDecisionPath,
  );
  if (existingDecisionPath) {
    return existingDecisionPath;
  }
  const absPath = join(config.root, decisionPath);

  const content = [
    "---",
    `title: "${escapeYaml(decision.title)}"`,
    `date: ${date}`,
    "type: decision",
    "para: projects",
    `tags: [decision, meeting]`,
    `source: "[[${meetingPath}]]"`,
    "---",
    "",
    `# ${decision.title}`,
    "",
    "## Context",
    "",
    `Decided during meeting: [[${meetingPath}]]`,
    "",
    "## Decision",
    "",
    decision.description,
    "",
    "## Timeline",
    "",
    `- **${date}** | Decision recorded from meeting`,
    "",
  ].join("\n");

  writeFileSync(absPath, content);
  return decisionPath;
}

function createTaskPage(
  config: BrainConfig,
  task: { assignee: string; title: string; description: string },
  date: string,
  meetingPath: string
): string {
  const tasksDir = join(config.root, "wiki/tasks");
  mkdirSync(tasksDir, { recursive: true });

  const slug = slugify(task.title);
  const taskPath = `wiki/tasks/${date}-${slug}.md`;
  const legacyTaskPath = `wiki/entities/tasks/${date}-${slug}.md`;

  // Skip if task already captured under either taxonomy path.
  const existingTaskPath = findExistingPagePath(config, taskPath, legacyTaskPath);
  if (existingTaskPath) {
    return existingTaskPath;
  }
  const absPath = join(config.root, taskPath);

  const content = [
    "---",
    `title: "${escapeYaml(task.title)}"`,
    `date: ${date}`,
    "type: task",
    "para: projects",
    `tags: [task, meeting]`,
    `assignee: "${escapeYaml(task.assignee)}"`,
    `source: "[[${meetingPath}]]"`,
    "status: open",
    "---",
    "",
    `# ${task.title}`,
    "",
    `**Assignee**: ${task.assignee}`,
    `**Status**: open`,
    `**Source**: [[${meetingPath}]]`,
    "",
    "## Description",
    "",
    task.description,
    "",
    "## Timeline",
    "",
    `- **${date}** | Task created from meeting`,
    "",
  ].join("\n");

  writeFileSync(absPath, content);
  return taskPath;
}

function findExistingPagePath(
  config: BrainConfig,
  currentPath: string,
  legacyPath: string,
): string | null {
  for (const candidate of [currentPath, legacyPath]) {
    if (existsSync(join(config.root, candidate))) {
      return candidate;
    }
  }
  return null;
}

function collectSpeakerStatements(
  transcript: MeetingTranscript
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const segment of transcript.segments) {
    const existing = map.get(segment.speaker) ?? [];
    existing.push(segment.text);
    map.set(segment.speaker, existing);
  }
  return map;
}

/**
 * Validate and sanitize a date string to YYYY-MM-DD format.
 * Prevents path traversal via crafted date values used in file paths.
 */
function sanitizeDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return new Date().toISOString().slice(0, 10);
  }
  const [, year, month, day] = match;
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) {
    return new Date().toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

function escapeYaml(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, " ");
}
