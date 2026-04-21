/**
 * /api/brain/compile-originals
 *
 * GET  — Returns compilable themes (clusters with 3+ originals)
 * POST — Compile originals into an artifact and save it
 *
 * Body (POST): { theme: string, format: ArtifactFormat }
 * Returns: CompiledArtifact with savedPath
 */

import {
  findCompilableThemes,
  compileOriginals,
  saveArtifact,
} from "@/brain/originals-artifacts";
import type { ArtifactFormat } from "@/brain/originals-artifacts";
import { getBrainConfig, getLLMClient, isErrorResponse } from "../_shared";

const VALID_FORMATS = new Set([
  "blog-post",
  "memo",
  "evidence-summary",
  "paper-outline",
  "thread",
]);

export async function GET() {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  try {
    const themes = await findCompilableThemes(config);
    return Response.json({ themes });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to find compilable themes";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  let body: { theme?: string; format?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { theme, format } = body;

  if (!theme || typeof theme !== "string") {
    return Response.json(
      { error: "Missing required field: theme (string)" },
      { status: 400 }
    );
  }

  if (!format || !VALID_FORMATS.has(format)) {
    return Response.json(
      {
        error: `Invalid format. Must be one of: ${[...VALID_FORMATS].join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    // Find the matching cluster
    const themes = await findCompilableThemes(config);
    const cluster = themes.find((t) => t.theme === theme);

    if (!cluster) {
      return Response.json(
        { error: `No compilable theme found matching: ${theme}` },
        { status: 404 }
      );
    }

    // Compile and save
    const llm = getLLMClient(config);
    const artifact = await compileOriginals(
      config,
      llm,
      cluster,
      format as ArtifactFormat
    );
    const savedPath = saveArtifact(config, artifact);

    return Response.json({ artifact, savedPath });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Compilation failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
