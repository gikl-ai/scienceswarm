/**
 * Second Brain — Proactive Meeting Prep
 *
 * Searches the brain for person pages matching attendee names,
 * surfaces recent interactions, open threads, and relevant papers,
 * then generates suggested discussion topics.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import matter from "gray-matter";
import { search } from "./search";
import type { BrainConfig, MeetingPrep, MeetingAttendeePrep } from "./types";
import type { LLMClient } from "./llm";
import { createCalendarAdapter } from "@/lib/integrations/calendar";

// ── Calendar Integration ─────────────────────────────

export interface CalendarEvent {
  title: string;
  time: string;
  attendees: string[];
}

/**
 * Load today's calendar events from a JSON file or env-configured path.
 * Returns null if no calendar data is available.
 */
export async function loadCalendarEvents(): Promise<CalendarEvent[] | null> {
  if (process.env.GOOGLE_CALENDAR_CREDENTIALS) {
    try {
      const adapter = createCalendarAdapter();
      const events = await adapter.getTodayEvents();
      if (events.length > 0) {
        return events.map((event) => ({
          title: event.title,
          time: event.start,
          attendees: event.attendees
            .map((attendee) => attendee.name || attendee.email)
            .filter(Boolean),
        }));
      }
    } catch {
      // Fall back to local JSON fixtures/exports if the live adapter fails.
    }
  }

  const calendarPath =
    process.env.BRAIN_CALENDAR_PATH ??
    process.env.CALENDAR_EVENTS_PATH;

  if (!calendarPath || !existsSync(calendarPath)) {
    return null;
  }

  try {
    const raw = readFileSync(calendarPath, "utf-8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) return null;

    return parsed
      .filter(
        (e: Record<string, unknown>) =>
          typeof e.title === "string" &&
          (typeof e.time === "string" || typeof e.start === "string") &&
          Array.isArray(e.attendees),
      )
      .map((e: Record<string, unknown>) => ({
        title: String(e.title),
        time: String(e.time ?? e.start),
        attendees: (e.attendees as unknown[])
          .map((attendee) => {
            if (typeof attendee === "string") return attendee;
            if (
              attendee &&
              typeof attendee === "object" &&
              "name" in attendee &&
              typeof attendee.name === "string"
            ) {
              return attendee.name;
            }
            if (
              attendee &&
              typeof attendee === "object" &&
              "email" in attendee &&
              typeof attendee.email === "string"
            ) {
              return attendee.email;
            }
            return "";
          })
          .filter(Boolean),
      }));
  } catch {
    return null;
  }
}

// ── Person Page Search ───────────────────────────────

interface PersonPageInfo {
  path: string;
  name: string;
  lastInteraction?: string;
  openThreads: string[];
}

/**
 * Search brain for a person page matching the given name.
 */
async function findPersonPage(
  config: BrainConfig,
  name: string,
): Promise<PersonPageInfo | null> {
  // First try searching people directory directly
  const peopleDir = join(config.root, "wiki/entities/people");
  if (existsSync(peopleDir)) {
    const entries = readdirSync(peopleDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const fullPath = join(peopleDir, entry);
      const stat = statSync(fullPath);
      if (!stat.isFile()) continue;

      const raw = readFileSync(fullPath, "utf-8");
      const parsed = matter(raw);
      const pageName =
        (parsed.data.name as string | undefined) ??
        (parsed.data.title as string | undefined) ??
        basename(entry, ".md");

      if (nameMatches(pageName, name)) {
        const openThreads = extractOpenThreads(parsed.content);
        const lastInteraction = extractLastInteraction(parsed.content, parsed.data);
        return {
          path: `wiki/entities/people/${entry}`,
          name: pageName,
          lastInteraction,
          openThreads,
        };
      }
    }
  }

  // Fallback: use brain search
  const results = await search(config, {
    query: name,
    mode: "grep",
    limit: 5,
  });

  const personResult = results.find(
    (r) => r.type === "person" && nameMatches(r.title, name),
  );

  if (personResult) {
    const absPath = join(config.root, personResult.path);
    if (existsSync(absPath)) {
      const raw = readFileSync(absPath, "utf-8");
      const parsed = matter(raw);
      return {
        path: personResult.path,
        name: personResult.title,
        lastInteraction: extractLastInteraction(parsed.content, parsed.data),
        openThreads: extractOpenThreads(parsed.content),
      };
    }
  }

  return null;
}

function nameMatches(pageName: string, searchName: string): boolean {
  const a = pageName.toLowerCase().trim();
  const b = searchName.toLowerCase().trim();
  if (a === b) return true;
  // Check if the search name is contained in the page name or vice versa
  if (a.includes(b) || b.includes(a)) return true;
  // Check last-name match (e.g., "Nanda" matches "Neel Nanda")
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  if (aParts.length > 0 && bParts.length > 0) {
    if (aParts[aParts.length - 1] === bParts[bParts.length - 1]) return true;
  }
  return false;
}

function extractLastInteraction(
  content: string,
  data: Record<string, unknown>,
): string | undefined {
  // Check frontmatter for a last_interaction field
  // gray-matter may parse YYYY-MM-DD as a Date object
  const fmValue = data.last_interaction;
  if (fmValue instanceof Date) {
    return fmValue.toISOString().slice(0, 10);
  }
  if (typeof fmValue === "string" && fmValue.trim()) {
    return fmValue.trim();
  }

  // Look for date-like patterns in the content (most recent first)
  const datePattern = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const dates: string[] = [];
  let match;
  while ((match = datePattern.exec(content)) !== null) {
    dates.push(match[1]);
  }

  if (dates.length > 0) {
    dates.sort().reverse();
    return dates[0];
  }

  return undefined;
}

function extractOpenThreads(content: string): string[] {
  const threads: string[] = [];

  // Look for open/active items in the content
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Match unchecked todo items
    if (trimmed.startsWith("- [ ]")) {
      threads.push(trimmed.slice(5).trim());
    }
    // Match "TODO:" or "OPEN:" markers
    if (/^(?:TODO|OPEN|PENDING):/i.test(trimmed)) {
      threads.push(trimmed);
    }
  }

  return threads.slice(0, 5);
}

// ── Meeting Prep Builder ─────────────────────────────

/**
 * Build meeting prep for calendar events. Called from buildMorningBrief.
 */
export async function buildMeetingPrepFromCalendar(
  config: BrainConfig,
  calendarEvents: CalendarEvent[],
): Promise<MeetingPrep[]> {
  const preps: MeetingPrep[] = [];

  for (const event of calendarEvents) {
    const attendees: MeetingAttendeePrep[] = [];

    for (const attendeeName of event.attendees) {
      const personPage = await findPersonPage(config, attendeeName);
      attendees.push({
        name: attendeeName,
        brainPagePath: personPage?.path,
        lastInteraction: personPage?.lastInteraction,
        openThreads: personPage?.openThreads ?? [],
      });
    }

    // Generate suggested topics from attendee context
    const suggestedTopics = generateSuggestedTopics(attendees, event.title);

    preps.push({
      title: event.title,
      time: event.time,
      attendees,
      suggestedTopics,
    });
  }

  return preps;
}

/**
 * Standalone meeting prep function for ad-hoc use.
 * Example: "prep me for my meeting with Neel Nanda"
 */
export async function prepMeeting(
  config: BrainConfig,
  llm: LLMClient,
  attendeeNames: string[],
): Promise<MeetingPrep> {
  const attendees: MeetingAttendeePrep[] = [];

  for (const name of attendeeNames) {
    const personPage = await findPersonPage(config, name);
    attendees.push({
      name,
      brainPagePath: personPage?.path,
      lastInteraction: personPage?.lastInteraction,
      openThreads: personPage?.openThreads ?? [],
    });
  }

  // Search for shared research context
  const sharedContext = await findSharedContext(config, attendeeNames);

  // Use LLM to generate better suggested topics when available
  const suggestedTopics = await generateLLMSuggestedTopics(
    llm,
    config,
    attendees,
    sharedContext,
  );

  return {
    title: `Meeting with ${attendeeNames.join(", ")}`,
    time: new Date().toISOString(),
    attendees,
    suggestedTopics,
  };
}

// ── Topic Generation ─────────────────────────────────

function generateSuggestedTopics(
  attendees: MeetingAttendeePrep[],
  meetingTitle: string,
): string[] {
  const topics: string[] = [];

  // Add open threads as potential discussion topics
  for (const attendee of attendees) {
    for (const thread of attendee.openThreads.slice(0, 2)) {
      topics.push(`Follow up with ${attendee.name}: ${thread}`);
    }
  }

  // If we have person pages but no threads, suggest catching up
  const attendeesWithPages = attendees.filter((a) => a.brainPagePath);
  if (topics.length === 0 && attendeesWithPages.length > 0) {
    topics.push(`Review recent work relevant to "${meetingTitle}"`);
  }

  // Always add the meeting title as a topic if nothing else
  if (topics.length === 0) {
    topics.push(meetingTitle);
  }

  return topics.slice(0, 5);
}

async function findSharedContext(
  config: BrainConfig,
  attendeeNames: string[],
): Promise<string[]> {
  const contexts: string[] = [];

  for (const name of attendeeNames) {
    const results = await search(config, {
      query: name,
      mode: "grep",
      limit: 5,
    });
    for (const r of results) {
      if (r.type !== "person") {
        contexts.push(`${r.title}: ${r.snippet}`);
      }
    }
  }

  return contexts.slice(0, 10);
}

async function generateLLMSuggestedTopics(
  llm: LLMClient,
  config: BrainConfig,
  attendees: MeetingAttendeePrep[],
  sharedContext: string[],
): Promise<string[]> {
  const contextParts: string[] = [];

  for (const attendee of attendees) {
    const parts = [`Attendee: ${attendee.name}`];
    if (attendee.brainPagePath) parts.push(`  Brain page: ${attendee.brainPagePath}`);
    if (attendee.lastInteraction) parts.push(`  Last interaction: ${attendee.lastInteraction}`);
    if (attendee.openThreads.length > 0) {
      parts.push(`  Open threads: ${attendee.openThreads.join("; ")}`);
    }
    contextParts.push(parts.join("\n"));
  }

  if (sharedContext.length > 0) {
    contextParts.push(
      "\nShared research context:",
      ...sharedContext.map((c) => `- ${c}`),
    );
  }

  try {
    const response = await llm.complete({
      system: MEETING_PREP_PROMPT,
      user: contextParts.join("\n"),
      model: config.extractionModel,
    });

    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.filter((t) => typeof t === "string").slice(0, 5);
      }
    }
  } catch {
    // Fall back to deterministic topic generation
  }

  return generateSuggestedTopics(
    attendees,
    `Meeting with ${attendees.map((a) => a.name).join(", ")}`,
  );
}

const MEETING_PREP_PROMPT = `You are a research meeting prep assistant.

Given information about meeting attendees (their brain pages, open threads, last interaction dates) and shared research context, suggest 3-5 specific discussion topics.

Topics should be:
- Specific and actionable (not generic like "catch up")
- Based on open threads, recent shared work, or knowledge gaps
- Ordered by importance

Output a JSON array of strings:
["topic 1", "topic 2", "topic 3"]`;
