/**
 * External Integration — Shared Types
 *
 * Types for Google Calendar, Gmail, and Zotero integrations.
 * These feed data into the brain's person pages, meeting prep, and briefings.
 */

// ── Configuration ────────────────────────────────────────

export interface IntegrationConfig {
  provider: "google-calendar" | "gmail" | "zotero";
  enabled: boolean;
  credentials?: Record<string, string>;
  lastSync?: string;
  syncInterval?: number; // minutes
}

// ── Google Calendar ──────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  attendees: Array<{ name: string; email: string }>;
  location?: string;
  description?: string;
  meetingLink?: string;
}

// ── Gmail ────────────────────────────────────────────────

export interface EmailMessage {
  from: string;
  date: string; // ISO 8601
  body: string;
  snippet: string;
}

export interface EmailThread {
  id: string;
  subject: string;
  participants: Array<{ name: string; email: string }>;
  messages: EmailMessage[];
  labels: string[];
}

// ── Zotero ───────────────────────────────────────────────

export interface ZoteroItem {
  key: string;
  title: string;
  authors: string[];
  year: number;
  doi?: string;
  abstract?: string;
  tags: string[];
  collections: string[];
  dateAdded: string;
  dateModified: string;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentCollection?: string;
}

// ── Sync Report ──────────────────────────────────────────

export interface SyncProviderResult {
  provider: string;
  success: boolean;
  itemsSynced: number;
  pagesCreated?: number;
  pagesEnriched?: number;
  pagesSkipped?: number;
  error?: string;
}

export interface SyncReport {
  timestamp: string;
  results: SyncProviderResult[];
}

export interface IntegrationStatus {
  enabled: boolean;
  lastSync?: string;
  error?: string;
}
