/**
 * Second Brain — Chat Entity Hook
 *
 * Hook that runs entity detection on every chat message.
 * Designed to be non-blocking: returns context enrichment immediately,
 * queues page creation/enrichment for background processing.
 *
 * Integrates with chat-inject.ts without breaking existing flow.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { BrainConfig } from "./types";
import type { LLMClient } from "./llm";
import {
  detectEntities,
  type DetectedEntity,
  type ScienceEntityType,
  type EntityDetectionResult,
} from "./entity-detector";
import { saveOriginal } from "./originals";
import { ensureBacklinks } from "./backlink";
import { search } from "./search";

// ── Public Types ─────────────────────────────────────

export interface ChatEntityContext {
  /** Brain pages relevant to this message */
  relevantPages: Array<{ path: string; title: string; snippet: string }>;
  /** Entities detected that have brain pages */
  knownEntities: Array<{
    name: string;
    path: string;
    type: ScienceEntityType;
  }>;
  /** Entities detected that need brain pages (queued for creation) */
  newEntities: DetectedEntity[];
  /** Original thinking captured */
  originalsCaptures: string[];
}

export interface EntityProcessingResult {
  pagesCreated: string[];
  pagesEnriched: string[];
  contextLoaded: Array<{ path: string; title: string; snippet: string }>;
  originalsRecorded: string[];
  backlinksCreated: number;
}

// ── Core Hook ────────────────────────────────────────

/**
 * Hook that runs entity detection on every chat message.
 * Non-blocking design: returns context enrichment immediately,
 * queues background work for page creation/enrichment.
 */
export async function onChatMessage(
  config: BrainConfig,
  llm: LLMClient,
  message: string,
  options?: { project?: string; userId?: string }
): Promise<ChatEntityContext> {
  // 1. Fast entity detection (always runs, <10ms)
  const detection = await detectEntities(message, { fast: true });

  if (detection.isOperational) {
    return {
      relevantPages: [],
      knownEntities: [],
      newEntities: [],
      originalsCaptures: [],
    };
  }

  // 2. Search brain for detected entities (parallel)
  const knownEntities: ChatEntityContext["knownEntities"] = [];
  const newEntities: DetectedEntity[] = [];
  const relevantPages: ChatEntityContext["relevantPages"] = [];

  const searchPromises = detection.entities.map(async (entity) => {
    // Check if entity page already exists
    if (existsSync(join(config.root, entity.suggestedPath))) {
      const content = readFileSync(
        join(config.root, entity.suggestedPath),
        "utf-8"
      );
      const title = extractTitle(content) ?? entity.name;
      const snippet = content.slice(0, 200).trim();

      knownEntities.push({
        name: entity.name,
        path: entity.suggestedPath,
        type: entity.type,
      });

      relevantPages.push({
        path: entity.suggestedPath,
        title,
        snippet,
      });
      return;
    }

    // Search brain for the entity
    try {
      const results = await search(config, {
        query: entity.name,
        mode: "grep",
        limit: 2,
      });

      if (results.length > 0) {
        knownEntities.push({
          name: entity.name,
          path: results[0].path,
          type: entity.type,
        });
        relevantPages.push({
          path: results[0].path,
          title: results[0].title,
          snippet: results[0].snippet,
        });
      } else {
        newEntities.push(entity);
      }
    } catch {
      newEntities.push(entity);
    }
  });

  await Promise.all(searchPromises);

  // 3. Queue background work (page creation, back-links, originals)
  // Fire and forget — don't block the response
  processInBackground(config, llm, message, detection, options).catch(
    () => {
      // Background processing errors are non-fatal
    }
  );

  return {
    relevantPages,
    knownEntities,
    newEntities,
    originalsCaptures: detection.originals.map((o) => o.verbatim),
  };
}

/**
 * Process detected entities in the background.
 * Creates pages, originals, and back-links.
 */
export async function processDetectedEntities(
  config: BrainConfig,
  llm: LLMClient,
  result: EntityDetectionResult,
  sourceContext: string
): Promise<EntityProcessingResult> {
  const pagesCreated: string[] = [];
  const pagesEnriched: string[] = [];
  const contextLoaded: EntityProcessingResult["contextLoaded"] = [];
  const originalsRecorded: string[] = [];
  let backlinksCreated = 0;
  const date = new Date().toISOString().slice(0, 10);

  // Process originals (highest priority)
  for (const original of result.originals) {
    const path = saveOriginal(config, original, sourceContext);
    originalsRecorded.push(path);
    pagesCreated.push(path);
  }

  // Process entities
  for (const entity of result.entities) {
    const absPath = join(config.root, entity.suggestedPath);

    if (existsSync(absPath)) {
      // Page exists — load for context enrichment
      const content = readFileSync(absPath, "utf-8");
      const title = extractTitle(content) ?? entity.name;
      contextLoaded.push({
        path: entity.suggestedPath,
        title,
        snippet: content.slice(0, 200).trim(),
      });

      // Ensure back-links
      ensureBacklinks(
        config,
        entity.suggestedPath,
        sourceContext,
        `Mentioned ${entity.type}: ${entity.name}`,
        date
      );
      backlinksCreated++;
    } else {
      // Check if a page exists via search
      try {
        const results = await search(config, {
          query: entity.name,
          mode: "grep",
          limit: 1,
        });

        if (results.length > 0) {
          // Found an existing page — enrich it
          pagesEnriched.push(results[0].path);
          ensureBacklinks(
            config,
            results[0].path,
            sourceContext,
            `Mentioned ${entity.type}: ${entity.name}`,
            date
          );
          backlinksCreated++;
        }
        // If no page found, entity is queued for creation by dream cycle
      } catch {
        // Search failure — skip
      }
    }
  }

  return {
    pagesCreated,
    pagesEnriched,
    contextLoaded,
    originalsRecorded,
    backlinksCreated,
  };
}

// ── Background Processing ────────────────────────────

async function processInBackground(
  config: BrainConfig,
  llm: LLMClient,
  message: string,
  detection: EntityDetectionResult,
  options?: { project?: string; userId?: string }
): Promise<void> {
  const sourceContext = options?.project
    ? `chat in project ${options.project}`
    : "chat message";

  // If we have entities but no originals yet, try LLM detection for originals
  if (detection.originals.length === 0 && detection.entities.length > 0) {
    try {
      const fullDetection = await detectEntities(message, {
        fast: false,
        llm,
      });
      detection.originals = fullDetection.originals;
      // Merge any new entities from LLM
      const existingNames = new Set(
        detection.entities.map((e) => e.name.toLowerCase())
      );
      for (const entity of fullDetection.entities) {
        if (!existingNames.has(entity.name.toLowerCase())) {
          detection.entities.push(entity);
        }
      }
    } catch {
      // LLM detection failed — proceed with fast-path results only
    }
  }

  await processDetectedEntities(config, llm, detection, sourceContext);
}

// ── Helpers ──────────────────────────────────────────

function extractTitle(content: string): string | null {
  const match = content.match(/^# (.+)$/m);
  return match ? match[1].trim() : null;
}
