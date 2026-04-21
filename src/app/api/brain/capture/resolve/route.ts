import type { CaptureChannel } from "@/brain/types";
import { isCaptureChannel, resolvePendingCapture } from "@/lib/capture";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { getBrainConfig, isErrorResponse } from "../../_shared";

export async function POST(request: Request): Promise<Response> {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.captureId !== "string" || !body.captureId.trim()) {
    return Response.json({ error: "Missing required field: captureId" }, { status: 400 });
  }

  if (typeof body.project !== "string" || !body.project.trim()) {
    return Response.json({ error: "Missing required field: project" }, { status: 400 });
  }

  let channel: CaptureChannel = "web";
  if (body.channel !== undefined) {
    if (!isCaptureChannel(body.channel)) {
      return Response.json(
        { error: "channel must be one of: web, telegram, openclaw" },
        { status: 400 },
      );
    }
    channel = body.channel;
  }

  const captureId = body.captureId.trim();
  const project = body.project.trim();
  const rawPath =
    typeof body.rawPath === "string" && body.rawPath.trim().length > 0
      ? body.rawPath.trim()
      : undefined;

  try {
    assertSafeProjectSlug(project);
  } catch {
    return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
  }

  try {
    const result = await resolvePendingCapture({
      brainRoot: configOrError.root,
      channel,
      captureId,
      project,
      rawPath,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("not found")) {
      return Response.json({ error: "Capture not found" }, { status: 404 });
    }

    console.error("POST /api/brain/capture/resolve failed", error);
    return Response.json({ error: "Capture resolution failed" }, { status: 500 });
  }
}
