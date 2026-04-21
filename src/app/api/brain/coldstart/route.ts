/**
 * POST /api/brain/coldstart
 *
 * Two actions:
 * - { action: "scan", paths: string[] } — scan directories and return a ColdstartScan preview
 * - { action: "import", preview: ImportPreview, options?: { skipDuplicates?: boolean } } — run import
 */

import { scanCorpus, approveAndImport } from "@/brain/coldstart";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { createIngestService } from "@/brain/ingest/service";
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
      return Response.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }
    body = parsed;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { action } = body as { action?: string };

  if (action === "scan") {
    const { paths } = body as { paths?: unknown };
    if (
      !Array.isArray(paths) ||
      !paths.every((p: unknown) => typeof p === "string")
    ) {
      return Response.json(
        { error: "Missing or invalid field: paths (must be string[])" },
        { status: 400 },
      );
    }

    try {
      const scan = await scanCorpus(paths as string[]);
      return Response.json(scan);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scan failed";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (action === "import") {
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
        ? (options as { skipDuplicates?: boolean })
        : undefined;

    try {
      const llm = getLLMClient(config);
      const uploadedBy = getCurrentUserHandle();
      const gbrain = createInProcessGbrainClient();
      const result = await approveAndImport(
        config,
        llm,
        preview as import("@/brain/types").ImportPreview,
        {
          ...importOptions,
          enableGbrain: true,
          gbrain,
          ingestService: createIngestService({ gbrain }),
          uploadedBy,
        },
      );
      return Response.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Import failed";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json(
    { error: 'Invalid action. Must be "scan" or "import".' },
    { status: 400 },
  );
}
