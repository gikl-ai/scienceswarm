import { isLocalRequest } from "@/lib/local-guard";
import {
  importWorkspaceSkillFromGitHub,
  WorkspaceSkillConflictError,
  WorkspaceSkillValidationError,
} from "@/lib/skills/workspace";

export const dynamic = "force-dynamic";

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = await request.json().catch(() => ({}));
  const repo =
    payload && typeof payload === "object" && "repo" in payload && typeof payload.repo === "string"
      ? payload.repo
      : null;
  const importPath =
    payload && typeof payload === "object" && "path" in payload && typeof payload.path === "string"
      ? payload.path
      : null;
  const host =
    payload && typeof payload === "object" && "host" in payload && typeof payload.host === "string"
      ? payload.host
      : null;

  if (!repo || !importPath || !host) {
    return Response.json(
      { error: "Request body must include repo, path, and host." },
      { status: 400 },
    );
  }

  try {
    const skill = await importWorkspaceSkillFromGitHub({
      repo,
      path: importPath,
      host,
      ref:
        payload && typeof payload === "object" && "ref" in payload && typeof payload.ref === "string"
          ? payload.ref
          : "main",
      slug:
        payload && typeof payload === "object" && "slug" in payload && typeof payload.slug === "string"
          ? payload.slug
          : undefined,
      visibility: "private",
      status:
        payload && typeof payload === "object" && payload.status === "ready" ? "ready" : "draft",
      owner:
        payload && typeof payload === "object" && "owner" in payload && typeof payload.owner === "string"
          ? payload.owner
          : null,
      tags:
        payload && typeof payload === "object" && "tags" in payload ? parseStringArray(payload.tags) : [],
      summary:
        payload && typeof payload === "object" && "summary" in payload && typeof payload.summary === "string"
          ? payload.summary
          : null,
    });

    return Response.json(
      {
        skill,
        message: "Workspace skill imported. Review the adapter and sync it into the hosts you want to support.",
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof WorkspaceSkillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceSkillConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: "Failed to import workspace skill." }, { status: 500 });
  }
}
