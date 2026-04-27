import { buildProjectImportRegistry } from "@/brain/import-registry";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET(request: Request): Promise<Response> {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const url = new URL(request.url);
  const study = url.searchParams.get("study") || url.searchParams.get("project");
  if (!study) {
    return Response.json({ error: "Missing study parameter" }, { status: 400 });
  }

  try {
    assertSafeProjectSlug(study);
  } catch (error) {
    if (!(error instanceof InvalidSlugError)) {
      throw error;
    }
    return Response.json({ error: "study must be a safe bare slug" }, { status: 400 });
  }

  try {
    const registry = await buildProjectImportRegistry({ config, project: study });
    return Response.json(registry);
  } catch {
    return Response.json({ error: "Import registry failed" }, { status: 500 });
  }
}
