/**
 * External Integration — Zotero Sync
 *
 * Adapter pattern: MockZoteroAdapter for dev/testing,
 * ZoteroApiAdapter for real Zotero API v3.
 * Factory returns the appropriate adapter based on env credentials.
 *
 * Supports incremental sync via Zotero's version-based pagination.
 * Converts ZoteroItem[] to ParsedReference[] for import into brain.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { ParsedReference } from "@/brain/types";
import type { ZoteroItem, ZoteroCollection } from "./types";

// ── Adapter Interface ────────────────────────────────────

export interface ZoteroAdapter {
  getItems(since?: string): Promise<ZoteroItem[]>;
  getCollections(): Promise<ZoteroCollection[]>;
  getItem(key: string): Promise<ZoteroItem | null>;
}

// ── Mock Adapter ─────────────────────────────────────────

const STATE_FILE = join(process.cwd(), "state", "zotero-items.json");

export class MockZoteroAdapter implements ZoteroAdapter {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? STATE_FILE;
  }

  private loadItems(): ZoteroItem[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    return JSON.parse(raw) as ZoteroItem[];
  }

  async getItems(since?: string): Promise<ZoteroItem[]> {
    const items = this.loadItems();
    if (!since) return items;
    return items.filter((item) => item.dateModified >= since);
  }

  async getCollections(): Promise<ZoteroCollection[]> {
    // Mock returns collections derived from items' collection fields
    const items = this.loadItems();
    const collSet = new Map<string, ZoteroCollection>();
    for (const item of items) {
      for (const coll of item.collections) {
        if (!collSet.has(coll)) {
          collSet.set(coll, { key: coll, name: coll });
        }
      }
    }
    return [...collSet.values()];
  }

  async getItem(key: string): Promise<ZoteroItem | null> {
    const items = this.loadItems();
    return items.find((i) => i.key === key) ?? null;
  }
}

// ── Zotero API Adapter ───────────────────────────────────

const ZOTERO_BASE = "https://api.zotero.org";

export class ZoteroApiAdapter implements ZoteroAdapter {
  private readonly apiKey: string;
  private readonly userId: string;

  constructor(apiKey: string, userId: string) {
    this.apiKey = apiKey;
    this.userId = userId;
  }

  private async fetchZotero(
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const url = new URL(`${ZOTERO_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), {
      headers: {
        "Zotero-API-Key": this.apiKey,
        "Zotero-API-Version": "3",
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Zotero API error ${res.status}: ${text}`);
    }

    return res.json();
  }

  async getItems(since?: string): Promise<ZoteroItem[]> {
    const params: Record<string, string> = {
      format: "json",
      limit: "100",
    };
    if (since) {
      params.since = since;
    }

    const data = (await this.fetchZotero(
      `/users/${this.userId}/items`,
      params,
    )) as ZoteroApiItem[];

    return data.map(parseZoteroApiItem);
  }

  async getCollections(): Promise<ZoteroCollection[]> {
    const data = (await this.fetchZotero(
      `/users/${this.userId}/collections`,
      { format: "json" },
    )) as ZoteroApiCollection[];

    return data.map((c) => ({
      key: c.key,
      name: c.data?.name ?? c.key,
      parentCollection: c.data?.parentCollection || undefined,
    }));
  }

  async getItem(key: string): Promise<ZoteroItem | null> {
    try {
      const data = (await this.fetchZotero(
        `/users/${this.userId}/items/${encodeURIComponent(key)}`,
        { format: "json" },
      )) as ZoteroApiItem;

      return parseZoteroApiItem(data);
    } catch {
      return null;
    }
  }
}

// ── Zotero API Types (internal) ──────────────────────────

interface ZoteroApiCreator {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

interface ZoteroApiItem {
  key: string;
  data: {
    title?: string;
    creators?: ZoteroApiCreator[];
    date?: string;
    DOI?: string;
    abstractNote?: string;
    tags?: Array<{ tag: string }>;
    collections?: string[];
    dateAdded?: string;
    dateModified?: string;
  };
}

interface ZoteroApiCollection {
  key: string;
  data?: {
    name?: string;
    parentCollection?: string;
  };
}

function parseZoteroApiItem(item: ZoteroApiItem): ZoteroItem {
  const d = item.data;
  const authors = (d.creators ?? []).map((c) => {
    if (c.name) return c.name;
    return [c.firstName, c.lastName].filter(Boolean).join(" ");
  });

  // Parse year from date string (various formats: "2024", "2024-01-15", "January 2024")
  let year = 0;
  if (d.date) {
    const yearMatch = d.date.match(/(\d{4})/);
    if (yearMatch) year = parseInt(yearMatch[1], 10);
  }

  return {
    key: item.key,
    title: d.title ?? "",
    authors,
    year,
    doi: d.DOI || undefined,
    abstract: d.abstractNote || undefined,
    tags: (d.tags ?? []).map((t) => t.tag),
    collections: d.collections ?? [],
    dateAdded: d.dateAdded ?? "",
    dateModified: d.dateModified ?? "",
  };
}

// ── Converter ────────────────────────────────────────────

/**
 * Convert ZoteroItem[] to ParsedReference[] for import into the brain.
 * Compatible with the bibtex-import deduplication pipeline.
 */
export function zoteroItemsToReferences(
  items: ZoteroItem[],
): ParsedReference[] {
  return items.map((item) => ({
    bibtexKey: `zotero:${item.key}`,
    title: item.title,
    authors: item.authors,
    year: item.year,
    venue: "", // Zotero items don't always have a venue field
    doi: item.doi,
    abstract: item.abstract,
    keywords: item.tags,
    entryType: "article",
    rawEntry: JSON.stringify(item),
  }));
}

// ── Factory ──────────────────────────────────────────────

/**
 * Create the appropriate Zotero adapter.
 * Returns ZoteroApiAdapter if ZOTERO_API_KEY and ZOTERO_USER_ID are set,
 * MockZoteroAdapter otherwise.
 */
export function createZoteroAdapter(): ZoteroAdapter {
  const apiKey = process.env.ZOTERO_API_KEY;
  const userId = process.env.ZOTERO_USER_ID;
  if (apiKey && userId) {
    return new ZoteroApiAdapter(apiKey, userId);
  }
  return new MockZoteroAdapter();
}
