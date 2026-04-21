/**
 * POST /api/brain/coldstart-stream
 *
 * SSE streaming version of the coldstart import.
 *
 * Event shape (Phase C Lane 4 — warm-start progress UI):
 *
 *   event: start      data: { total: number }
 *   event: progress   data: { phase, current, total, currentFile, message }
 *   event: file-done  data: { path, type, wikiPath }
 *   event: error      data: { path, error }
 *   event: complete   data: ColdstartResult
 *
 * `start` is emitted once before any progress event so UI consumers
 * (see `src/components/progress/brain-progress.tsx`) can initialize
 * the progress bar immediately rather than waiting for the first file
 * to land. It carries the total count of files that will be processed
 * (i.e. `preview.files.length - skipped`). All other events preserve
 * the legacy shape so existing tests and consumers keep working.
 */

import { approveAndImportWithProgress } from "@/brain/coldstart";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { createIngestService } from "@/brain/ingest/service";
import type { ImportPreview } from "@/brain/types";
import { safeProjectSlugOrNull } from "@/lib/project-navigation";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";

export async function POST(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { preview, options } = body as {
    preview?: unknown;
    options?: unknown;
  };

  if (
    !preview ||
    typeof preview !== "object" ||
    !Array.isArray((preview as Record<string, unknown>).files)
  ) {
    return Response.json(
      { error: "Missing or invalid field: preview (must include files array)" },
      { status: 400 },
    );
  }

  const importOptions =
    options && typeof options === "object"
      ? {
          skipDuplicates:
            (options as { skipDuplicates?: unknown }).skipDuplicates === true,
          projectSlug: safeProjectSlugOrNull(
            typeof (options as { projectSlug?: unknown }).projectSlug ===
              "string"
              ? (options as { projectSlug?: string }).projectSlug
              : null,
          ) ?? undefined,
        }
      : undefined;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const llm = getLLMClient(config);
        const uploadedBy = getCurrentUserHandle();
        const gbrain = createInProcessGbrainClient();
        const previewCast = preview as ImportPreview;

        // Compute the total up front so UI consumers can render a
        // determinate progress bar before the first file lands. This
        // mirrors the bookkeeping inside approveAndImportWithProgress
        // (total = files - pre-skipped duplicates) so the start event
        // and the subsequent progress events agree on the denominator.
        let skippedByDedup = 0;
        if (importOptions?.skipDuplicates) {
          const seen = new Set<string>();
          for (const group of previewCast.duplicateGroups ?? []) {
            const paths = group.paths ?? [];
            for (const p of paths.slice(1)) {
              if (!seen.has(p)) {
                seen.add(p);
                skippedByDedup++;
              }
            }
          }
        }
        const total = Math.max(
          0,
          previewCast.files.length - skippedByDedup,
        );
        send("start", { total });

        const result = await approveAndImportWithProgress(
          config,
          llm,
          previewCast,
          {
            ...importOptions,
            enableGbrain: true,
            gbrain,
            ingestService: createIngestService({ gbrain }),
            uploadedBy,
          },
          {
            onProgress: (p) => send("progress", p),
            onFileDone: (f) => send("file-done", f),
            onError: (e) => send("error", e),
          },
        );

        send("complete", result);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Import failed";
        // Emit the per-entry error so the error list populates, then a
        // final `complete` so the UI transitions out of the "running"
        // state. Without the `complete` event, the client's reader loop
        // would exit on stream close with no state change, leaving
        // `BrainProgress` stuck in "running" indefinitely (Greptile P1
        // on PR #248).
        send("error", { path: "", error: message });
        send("complete", {
          imported: 0,
          skipped: 0,
          errors: [{ path: "", error: message }],
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
