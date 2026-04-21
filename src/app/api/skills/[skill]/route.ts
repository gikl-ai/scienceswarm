import { isLocalRequest } from "@/lib/local-guard";
import {
  saveWorkspaceSkill,
  WorkspaceSkillNotFoundError,
  WorkspaceSkillValidationError,
} from "@/lib/skills/workspace";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    skill: string;
  }>;
};

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { skill } = await context.params;
  const payload = await request.json().catch(() => ({}));

  const manifest =
    payload &&
    typeof payload === "object" &&
    "manifest" in payload &&
    payload.manifest &&
    typeof payload.manifest === "object" &&
    !Array.isArray(payload.manifest)
      ? (() => {
          const nextManifest: {
            name?: string;
            description?: string;
            visibility?: "public" | "private";
            status?: "draft" | "ready";
            tags?: string[];
            hosts?: string[];
            owner?: string;
            summary?: string;
          } = {};

          if ("name" in payload.manifest && typeof payload.manifest.name === "string") {
            nextManifest.name = payload.manifest.name;
          }
          if ("description" in payload.manifest && typeof payload.manifest.description === "string") {
            nextManifest.description = payload.manifest.description;
          }
          if (
            "visibility" in payload.manifest &&
            (payload.manifest.visibility === "public" || payload.manifest.visibility === "private")
          ) {
            nextManifest.visibility = payload.manifest.visibility;
          }
          if (
            "status" in payload.manifest &&
            (payload.manifest.status === "ready" || payload.manifest.status === "draft")
          ) {
            nextManifest.status = payload.manifest.status;
          }
          if ("tags" in payload.manifest) {
            nextManifest.tags = parseStringArray(payload.manifest.tags);
          }
          if ("hosts" in payload.manifest) {
            nextManifest.hosts = parseStringArray(payload.manifest.hosts);
          }
          if ("owner" in payload.manifest && typeof payload.manifest.owner === "string") {
            nextManifest.owner = payload.manifest.owner;
          }
          if ("summary" in payload.manifest && typeof payload.manifest.summary === "string") {
            nextManifest.summary = payload.manifest.summary;
          }
          return nextManifest;
        })()
      : undefined;

  const adapterHost =
    payload && typeof payload === "object" && "adapterHost" in payload && typeof payload.adapterHost === "string"
      ? payload.adapterHost
      : undefined;
  const markdown =
    payload && typeof payload === "object" && "markdown" in payload && typeof payload.markdown === "string"
      ? payload.markdown
      : undefined;

  if (manifest === undefined && adapterHost === undefined && markdown === undefined) {
    return Response.json(
      { error: "Request body must include manifest changes and/or adapter markdown." },
      { status: 400 },
    );
  }

  if ((adapterHost === undefined) !== (markdown === undefined)) {
    return Response.json(
      { error: "Adapter saves must include both adapterHost and markdown." },
      { status: 400 },
    );
  }

  if (manifest?.visibility === "public") {
    return Response.json(
      { error: "Use the promote flow to publish a skill into the ScienceSwarm public catalog." },
      { status: 400 },
    );
  }

  try {
    const savedSkill = await saveWorkspaceSkill(
      skill,
      {
        manifest,
        adapterHost,
        markdown,
      },
    );
    return Response.json({
      skill: savedSkill,
      message: "Workspace skill saved. Sync repo host outputs to make the change live in each interface.",
    });
  } catch (error) {
    if (error instanceof WorkspaceSkillValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceSkillNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: "Failed to save workspace skill." }, { status: 500 });
  }
}
