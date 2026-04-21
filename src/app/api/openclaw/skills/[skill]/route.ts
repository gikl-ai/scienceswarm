import { isLocalRequest } from "@/lib/local-guard";
import {
  OpenClawSkillNotFoundError,
  OpenClawSkillValidationError,
  saveOpenClawSkill,
} from "@/lib/openclaw/skill-catalog";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    skill: string;
  }>;
};

export async function PUT(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { skill } = await context.params;
  const payload = await request.json().catch(() => ({}));
  const markdown =
    payload && typeof payload === "object" && "markdown" in payload && typeof payload.markdown === "string"
      ? payload.markdown
      : null;

  if (!markdown) {
    return Response.json(
      { error: "Request body must include markdown." },
      { status: 400 },
    );
  }

  try {
    const savedSkill = await saveOpenClawSkill(skill, markdown);
    return Response.json({
      skill: savedSkill,
      message: "Saved to disk. Reset the OpenClaw session to apply the change.",
    });
  } catch (error) {
    if (error instanceof OpenClawSkillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof OpenClawSkillNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    return Response.json({ error: "Failed to save OpenClaw skill." }, { status: 500 });
  }
}
