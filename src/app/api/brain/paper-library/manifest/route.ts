import { z } from "zod";
import {
  ProjectSlugSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";
import {
  readApplyManifest,
  readManifestOperations,
  windowManifestOperations,
} from "@/lib/paper-library/apply";
import { paperLibraryBadRequest, requirePaperLibraryRequest } from "../_shared";

const ManifestLookupRequestSchema = z.object({
  project: ProjectSlugSchema,
  id: z.string().min(1),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
});

export async function GET(request: Request) {
  const guard = await requirePaperLibraryRequest(request);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const parsed = ManifestLookupRequestSchema.safeParse({
    project: url.searchParams.get("project"),
    id: url.searchParams.get("id"),
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) return paperLibraryBadRequest(parsed.error);

  try {
    const manifest = await readApplyManifest(parsed.data.project, parsed.data.id, guard.brainRoot);
    if (!manifest) {
      return Response.json(paperLibraryError("job_not_found", "Apply manifest not found."), { status: 404 });
    }
    const operations = await readManifestOperations(parsed.data.project, parsed.data.id, guard.brainRoot);
    const page = windowManifestOperations(operations, parsed.data);
    return Response.json({ ok: true, manifest, operations: page.items, ...page });
  } catch (error) {
    return paperLibraryBadRequest(error);
  }
}
