import { isLocalRequest } from "@/lib/local-guard";
import { SKILL_HOST_DEFINITIONS } from "@/lib/skills/schema";
import {
  createWorkspaceSkill,
  listWorkspaceSkills,
  WorkspaceSkillConflictError,
  WorkspaceSkillValidationError,
} from "@/lib/skills/workspace";

export const dynamic = "force-dynamic";

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function GET(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const skills = await listWorkspaceSkills();
    return Response.json({
      skills,
      hosts: SKILL_HOST_DEFINITIONS,
    });
  } catch {
    return Response.json({ error: "Failed to load workspace skills." }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = await request.json().catch(() => ({}));
  const slug =
    payload && typeof payload === "object" && "slug" in payload && typeof payload.slug === "string"
      ? payload.slug
      : null;
  const name =
    payload && typeof payload === "object" && "name" in payload && typeof payload.name === "string"
      ? payload.name
      : null;
  const description =
    payload &&
    typeof payload === "object" &&
    "description" in payload &&
    typeof payload.description === "string"
      ? payload.description
      : null;
  const hosts =
    payload && typeof payload === "object" && "hosts" in payload
      ? parseStringArray(payload.hosts)
      : [];

  if (!slug || !name || !description || hosts.length === 0) {
    return Response.json(
      { error: "Request body must include slug, name, description, and at least one host." },
      { status: 400 },
    );
  }

  try {
    const skill = await createWorkspaceSkill({
      slug,
      name,
      description,
      hosts,
      visibility: "private",
      status:
        payload && typeof payload === "object" && payload.status === "ready" ? "ready" : "draft",
      tags:
        payload && typeof payload === "object" && "tags" in payload ? parseStringArray(payload.tags) : [],
      owner:
        payload && typeof payload === "object" && "owner" in payload && typeof payload.owner === "string"
          ? payload.owner
          : null,
      summary:
        payload && typeof payload === "object" && "summary" in payload && typeof payload.summary === "string"
          ? payload.summary
          : null,
    });

    return Response.json(
      {
        skill,
        message: "Workspace skill created. Sync enabled hosts to materialize repo adapters.",
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
    return Response.json({ error: "Failed to create workspace skill." }, { status: 500 });
  }
}
