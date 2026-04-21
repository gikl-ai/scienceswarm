/**
 * External Integration — Google Calendar
 *
 * Adapter pattern: MockCalendarAdapter for dev/testing,
 * GoogleCalendarAdapter for real Google Calendar API v3.
 * Factory returns the appropriate adapter based on env credentials.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { CalendarEvent } from "./types";

// ── Adapter Interface ────────────────────────────────────

export interface CalendarAdapter {
  getUpcomingEvents(days: number): Promise<CalendarEvent[]>;
  getTodayEvents(): Promise<CalendarEvent[]>;
  getEventAttendees(eventId: string): Promise<Array<{ name: string; email: string }>>;
}

// ── Mock Adapter ─────────────────────────────────────────

const STATE_FILE = join(process.cwd(), "state", "calendar-events.json");

export class MockCalendarAdapter implements CalendarAdapter {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? STATE_FILE;
  }

  private loadEvents(): CalendarEvent[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw) as CalendarEvent[];
  }

  async getUpcomingEvents(days: number): Promise<CalendarEvent[]> {
    const events = this.loadEvents();
    const now = new Date();
    // Use start of today (midnight UTC) so events anywhere in today are included
    const startOfToday = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
    const cutoff = new Date(startOfToday.getTime() + days * 24 * 60 * 60 * 1000);
    return events.filter((e) => {
      const start = new Date(e.start);
      return start >= startOfToday && start <= cutoff;
    });
  }

  async getTodayEvents(): Promise<CalendarEvent[]> {
    const events = this.loadEvents();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    return events.filter((e) => e.start.slice(0, 10) === todayStr);
  }

  async getEventAttendees(
    eventId: string,
  ): Promise<Array<{ name: string; email: string }>> {
    const events = this.loadEvents();
    const event = events.find((e) => e.id === eventId);
    return event?.attendees ?? [];
  }
}

// ── Google Calendar API Adapter ──────────────────────────

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendarAdapter implements CalendarAdapter {
  private readonly credentials: string;

  constructor(credentials: string) {
    this.credentials = credentials;
  }

  private async fetchCalendar(
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(`${GCAL_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.credentials}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Calendar API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  async getUpcomingEvents(days: number): Promise<CalendarEvent[]> {
    const now = new Date();
    const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const data = (await this.fetchCalendar("/calendars/primary/events", {
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    })) as { items?: GCalEvent[] };

    return (data.items ?? []).map(parseGCalEvent);
  }

  async getTodayEvents(): Promise<CalendarEvent[]> {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const data = (await this.fetchCalendar("/calendars/primary/events", {
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
    })) as { items?: GCalEvent[] };

    return (data.items ?? []).map(parseGCalEvent);
  }

  async getEventAttendees(
    eventId: string,
  ): Promise<Array<{ name: string; email: string }>> {
    const data = (await this.fetchCalendar(
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    )) as GCalEvent;

    return (data.attendees ?? []).map((a) => ({
      name: a.displayName ?? a.email ?? "Unknown",
      email: a.email ?? "",
    }));
  }
}

// ── Google Calendar API Types (internal) ─────────────────

interface GCalEvent {
  id?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ displayName?: string; email?: string }>;
  location?: string;
  description?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri?: string }> };
}

function parseGCalEvent(ev: GCalEvent): CalendarEvent {
  const meetingLink =
    ev.hangoutLink ??
    ev.conferenceData?.entryPoints?.find((e) => e.uri)?.uri ??
    undefined;

  return {
    id: ev.id ?? "",
    title: ev.summary ?? "(no title)",
    start: ev.start?.dateTime ?? ev.start?.date ?? "",
    end: ev.end?.dateTime ?? ev.end?.date ?? "",
    attendees: (ev.attendees ?? []).map((a) => ({
      name: a.displayName ?? a.email ?? "Unknown",
      email: a.email ?? "",
    })),
    location: ev.location,
    description: ev.description,
    meetingLink,
  };
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create the appropriate calendar adapter.
 * Returns GoogleCalendarAdapter if GOOGLE_CALENDAR_CREDENTIALS is set,
 * MockCalendarAdapter otherwise.
 */
export function createCalendarAdapter(): CalendarAdapter {
  const creds = process.env.GOOGLE_CALENDAR_CREDENTIALS;
  if (creds) {
    return new GoogleCalendarAdapter(creds);
  }
  return new MockCalendarAdapter();
}
