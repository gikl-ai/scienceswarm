/**
 * External Integration — Manager
 *
 * Central entry point for all external integrations.
 * Checks status of configured providers and orchestrates sync.
 */

import type { BrainConfig } from "@/brain/types";
import type { LLMClient } from "@/brain/llm";
import { importReferences } from "@/brain/bibtex-import";
import type { IntegrationStatus, SyncReport, SyncProviderResult } from "./types";
import { createCalendarAdapter } from "./calendar";
import { createEmailAdapter } from "./email";
import { createZoteroAdapter, zoteroItemsToReferences } from "./zotero";

// Re-export types and factories for convenience
export type { IntegrationStatus, SyncReport, SyncProviderResult } from "./types";
export type {
  CalendarEvent,
  EmailThread,
  ZoteroItem,
  ZoteroCollection,
  IntegrationConfig,
} from "./types";
export { createCalendarAdapter } from "./calendar";
export { createEmailAdapter } from "./email";
export { createZoteroAdapter, zoteroItemsToReferences } from "./zotero";

const importOnlyLlm: LLMClient = {
  async complete() {
    return {
      content: "",
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd: 0,
        model: "integration-sync",
      },
    };
  },
};

// ── Status ───────────────────────────────────────────────

/**
 * Check which integrations are configured and healthy.
 * Returns status for each provider.
 */
export async function getIntegrationStatus(): Promise<
  Record<string, IntegrationStatus>
> {
  const status: Record<string, IntegrationStatus> = {};

  // Google Calendar
  const hasCalCreds = !!process.env.GOOGLE_CALENDAR_CREDENTIALS;
  status["google-calendar"] = { enabled: hasCalCreds };
  if (hasCalCreds) {
    try {
      const cal = createCalendarAdapter();
      await cal.getTodayEvents();
      status["google-calendar"].lastSync = new Date().toISOString();
    } catch (err) {
      status["google-calendar"].error =
        err instanceof Error ? err.message : "Calendar check failed";
    }
  }

  // Gmail
  const hasGmailCreds = !!process.env.GMAIL_CREDENTIALS;
  status.gmail = { enabled: hasGmailCreds };
  if (hasGmailCreds) {
    try {
      const email = createEmailAdapter();
      await email.getRecentThreads(1);
      status.gmail.lastSync = new Date().toISOString();
    } catch (err) {
      status.gmail.error =
        err instanceof Error ? err.message : "Gmail check failed";
    }
  }

  // Zotero
  const hasZoteroCreds =
    !!process.env.ZOTERO_API_KEY && !!process.env.ZOTERO_USER_ID;
  status.zotero = { enabled: hasZoteroCreds };
  if (hasZoteroCreds) {
    try {
      const zotero = createZoteroAdapter();
      await zotero.getCollections();
      status.zotero.lastSync = new Date().toISOString();
    } catch (err) {
      status.zotero.error =
        err instanceof Error ? err.message : "Zotero check failed";
    }
  }

  return status;
}

// ── Sync ─────────────────────────────────────────────────

/**
 * Run all enabled integrations and return a sync report.
 * - Calendar: fetch upcoming events
 * - Gmail: fetch recent threads
 * - Zotero: fetch items, convert to ParsedReference[]
 */
export async function syncAll(config: BrainConfig): Promise<SyncReport> {
  const results: SyncProviderResult[] = [];

  // Calendar sync
  const hasCalCreds = !!process.env.GOOGLE_CALENDAR_CREDENTIALS;
  if (hasCalCreds) {
    try {
      const cal = createCalendarAdapter();
      const events = await cal.getUpcomingEvents(7);
      results.push({
        provider: "google-calendar",
        success: true,
        itemsSynced: events.length,
      });
    } catch (err) {
      results.push({
        provider: "google-calendar",
        success: false,
        itemsSynced: 0,
        error: err instanceof Error ? err.message : "Calendar sync failed",
      });
    }
  }

  // Gmail sync
  const hasGmailCreds = !!process.env.GMAIL_CREDENTIALS;
  if (hasGmailCreds) {
    try {
      const email = createEmailAdapter();
      const threads = await email.getRecentThreads(7);
      results.push({
        provider: "gmail",
        success: true,
        itemsSynced: threads.length,
      });
    } catch (err) {
      results.push({
        provider: "gmail",
        success: false,
        itemsSynced: 0,
        error: err instanceof Error ? err.message : "Gmail sync failed",
      });
    }
  }

  // Zotero sync
  const hasZoteroCreds =
    !!process.env.ZOTERO_API_KEY && !!process.env.ZOTERO_USER_ID;
  if (hasZoteroCreds) {
    try {
      const zotero = createZoteroAdapter();
      const items = await zotero.getItems();
      const refs = zoteroItemsToReferences(items);
      const importResult = await importReferences(config, importOnlyLlm, refs, {
        enrichMatches: true,
      });
      results.push({
        provider: "zotero",
        success: importResult.errors.length === 0,
        itemsSynced: items.length,
        pagesCreated: importResult.pagesCreated.length,
        pagesEnriched: importResult.pagesEnriched.length,
        pagesSkipped: importResult.pagesSkipped,
      });
    } catch (err) {
      results.push({
        provider: "zotero",
        success: false,
        itemsSynced: 0,
        error: err instanceof Error ? err.message : "Zotero sync failed",
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    results,
  };
}
