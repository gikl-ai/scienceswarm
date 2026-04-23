import { repairAppliedManifest } from "@/lib/paper-library/apply";
import { RepairManifestRequestSchema, paperLibraryError } from "@/lib/paper-library/contracts";
import { persistAppliedPaperLocations } from "@/lib/paper-library/gbrain-writer";
import { paperLibraryBadRequest, readJsonBody, requirePaperLibraryRequest } from "../_shared";

export async function POST(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return paperLibraryBadRequest(error);
  }

  const parsed = RepairManifestRequestSchema.safeParse(body);
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const result = await repairAppliedManifest({
      ...parsed.data,
      brainRoot: guard.brainRoot,
      persistLocations: persistAppliedPaperLocations,
    });
    if (!result) {
      return Response.json(paperLibraryError("job_not_found", "Apply manifest not found."), { status: 404 });
    }
    return Response.json({
      ok: true,
      repaired: result.repaired,
      manifest: result.manifest,
      status: result.manifest.status,
      warnings: result.manifest.warnings,
    });
  } catch (error) {
    return Response.json(
      paperLibraryError("manifest_not_repairable", error instanceof Error ? error.message : "Repair failed."),
      { status: 409 },
    );
  }
}
