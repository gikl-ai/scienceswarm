import { isLocalRequest } from "@/lib/local-guard";
import {
  promoteWorkspaceSkill,
  WorkspaceSkillNotFoundError,
  WorkspaceSkillValidationError,
} from "@/lib/skills/workspace";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    skill: string;
  }>;
};

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { skill } = await context.params;

  try {
    const promotedSkill = await promoteWorkspaceSkill(skill);
    return Response.json({
      skill: promotedSkill,
      message:
        "Promoted into the ScienceSwarm public catalog, synced enabled host outputs, and refreshed skills/public-index.json.",
    });
  } catch (error) {
    if (error instanceof WorkspaceSkillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceSkillNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: "Failed to promote workspace skill." }, { status: 500 });
  }
}
