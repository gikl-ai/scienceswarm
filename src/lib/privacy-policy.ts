import { ensureProjectManifest } from "@/lib/state/project-manifests";

async function readProjectPrivacy(projectId?: string | null): Promise<"local-only" | "cloud-ok" | "execution-ok" | null> {
  if (!projectId) {
    return null;
  }

  // Lazily upgrade legacy projects (project.json without a state manifest)
  // so privacy enforcement doesn't 403 on projects created before manifests
  // were introduced. ensureProjectManifest returns null only when neither
  // a manifest nor a project.json exists for the slug.
  const manifest = await ensureProjectManifest(projectId);
  return manifest?.privacy ?? null;
}

export async function enforceCloudPrivacy(projectId?: string | null): Promise<Response | null> {
  if (!projectId) {
    return null;
  }

  const privacy = await readProjectPrivacy(projectId);
  if (!privacy) {
    return Response.json(
      { error: `Project ${projectId} has no privacy manifest; remote chat is blocked.` },
      { status: 403 },
    );
  }

  if (privacy === "local-only") {
    return Response.json(
      { error: `Project ${projectId} is local-only; remote chat is blocked for this project.` },
      { status: 403 },
    );
  }

  return null;
}

export async function enforceExecutionPrivacy(projectId?: string | null): Promise<Response | null> {
  if (!projectId) {
    return Response.json(
      { error: "projectId is required before OpenHands execution is allowed." },
      { status: 400 },
    );
  }

  const privacy = await readProjectPrivacy(projectId);
  if (!privacy) {
    return Response.json(
      { error: `Project ${projectId} has no privacy manifest; execution is blocked.` },
      { status: 403 },
    );
  }

  if (privacy !== "execution-ok") {
    return Response.json(
      { error: `Project ${projectId} requires execution-ok privacy before OpenHands execution is allowed.` },
      { status: 403 },
    );
  }

  return null;
}
