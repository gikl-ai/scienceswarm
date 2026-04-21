import type {
  CaptureKind,
  CaptureRequest,
  PrivacyMode,
  SourceRef,
} from "@/brain/types";
import { isCaptureChannel, processCapture } from "@/lib/capture";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { getBrainConfig, isErrorResponse } from "../_shared";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCaptureKind(value: unknown): value is CaptureKind {
  return value === "note"
    || value === "observation"
    || value === "decision"
    || value === "hypothesis"
    || value === "task";
}

function isPrivacyMode(value: unknown): value is PrivacyMode {
  return value === "local-only" || value === "cloud-ok" || value === "execution-ok";
}

function isSourceRef(value: unknown): value is SourceRef {
  if (!value || typeof value !== "object") return false;
  const sourceRef = value as Record<string, unknown>;
  const validKind =
    sourceRef.kind === "import"
    || sourceRef.kind === "capture"
    || sourceRef.kind === "external"
    || sourceRef.kind === "artifact"
    || sourceRef.kind === "conversation";
  return validKind
    && typeof sourceRef.ref === "string"
    && (sourceRef.hash === undefined || typeof sourceRef.hash === "string");
}

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

  if (typeof body.content !== "string" || !body.content.trim()) {
    return Response.json({ error: "Missing required field: content" }, { status: 400 });
  }

  const capture: CaptureRequest = {
    content: body.content.trim(),
  };

  if (body.channel !== undefined) {
    if (!isCaptureChannel(body.channel)) {
      return Response.json({ error: "channel must be one of: web, telegram, openclaw" }, { status: 400 });
    }
    capture.channel = body.channel;
  }

  if (body.userId !== undefined && typeof body.userId !== "string") {
    return Response.json({ error: "userId must be a string" }, { status: 400 });
  }
  if (typeof body.userId === "string") {
    capture.userId = body.userId;
  }

  if (body.project !== undefined && body.project !== null && typeof body.project !== "string") {
    return Response.json({ error: "project must be a string, null, or omitted" }, { status: 400 });
  }
  if (typeof body.project === "string") {
    const project = body.project.trim();
    if (!project) {
      capture.project = null;
    } else {
      try {
        assertSafeProjectSlug(project);
      } catch {
        return Response.json({ error: "project must be a safe bare slug" }, { status: 400 });
      }
      capture.project = project;
    }
  } else if (body.project === null) {
    capture.project = null;
  }

  if (body.kind !== undefined) {
    if (!isCaptureKind(body.kind)) {
      return Response.json({ error: "kind must be a valid capture kind" }, { status: 400 });
    }
    capture.kind = body.kind;
  }

  if (body.privacy !== undefined) {
    if (!isPrivacyMode(body.privacy)) {
      return Response.json({ error: "privacy must be one of: local-only, cloud-ok, execution-ok" }, { status: 400 });
    }
    capture.privacy = body.privacy;
  }

  if (body.transcript !== undefined && typeof body.transcript !== "string") {
    return Response.json({ error: "transcript must be a string" }, { status: 400 });
  }
  if (typeof body.transcript === "string") {
    capture.transcript = body.transcript;
  }

  if (body.attachmentPaths !== undefined && !isStringArray(body.attachmentPaths)) {
    return Response.json({ error: "attachmentPaths must be an array of strings" }, { status: 400 });
  }
  if (Array.isArray(body.attachmentPaths)) {
    capture.attachmentPaths = body.attachmentPaths;
  }

  if (body.sourceRefs !== undefined) {
    if (!Array.isArray(body.sourceRefs) || !body.sourceRefs.every(isSourceRef)) {
      return Response.json({ error: "sourceRefs must be an array of source reference objects" }, { status: 400 });
    }
    capture.sourceRefs = body.sourceRefs;
  }

  try {
    const result = await processCapture({
      brainRoot: configOrError.root,
      ...capture,
      defaultChannel: "web",
      defaultUserId: "web-capture",
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Capture failed";
    const status = message === "Invalid capture channel" || message === "Invalid project slug" ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}
