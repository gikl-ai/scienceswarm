import { isLocalRequest } from "@/lib/local-guard";
import {
  syncWorkspaceSkill,
  WorkspaceSkillNotFoundError,
  WorkspaceSkillValidationError,
} from "@/lib/skills/workspace";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    skill: string;
  }>;
};

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { skill } = await context.params;
  const rawBody = await request.text();
  let payload: unknown = {};
  if (rawBody.trim().length > 0) {
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return Response.json({ error: "Request body must contain valid JSON." }, { status: 400 });
    }
  }
  const hosts =
    payload && typeof payload === "object" && "hosts" in payload ? parseStringArray(payload.hosts) : [];

  try {
    const syncedSkill = await syncWorkspaceSkill(skill, hosts.length > 0 ? hosts : undefined);
    return Response.json({
      skill: syncedSkill,
      message: hosts.length > 0
        ? `Synced ${hosts.join(", ")} from the workspace skill source of truth.`
        : "Synced all enabled host outputs from the workspace skill source of truth.",
    });
  } catch (error) {
    if (error instanceof WorkspaceSkillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceSkillNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: "Failed to sync workspace skill." }, { status: 500 });
  }
}
