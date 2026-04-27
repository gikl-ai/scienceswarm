import crypto from "node:crypto";
import type { ArtifactCreateRequest, PrivacyMode } from "@/brain/types";
import { slugifyWorkspaceSegment } from "@/lib/workspace-manager";

export const ARTIFACT_TYPES = [
  "notebook",
  "memo",
  "literature-table",
  "plan",
  "draft-section",
  "checklist",
] as const;

export type SupportedArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ValidatedArtifactRequest {
  project: string;
  projectSlug: string;
  artifactType: SupportedArtifactType;
  intent: string;
  conversationId?: string;
  messageIds: string[];
  requestedPrivacy?: PrivacyMode;
  idempotencyKey: string;
}

export interface ArtifactValidationResult {
  ok: boolean;
  status: number;
  error?: string;
  value?: ValidatedArtifactRequest;
}

const EXPLICIT_CREATE_PATTERN =
  /\b(create|make|write|draft|generate|prepare|produce|build|compile)\b/i;
const LOW_SIGNAL_PATTERN =
  /\b(brainstorm|explore|think about|talk about|discuss|maybe|idea)\b/i;
const PRIVACY_MODES: PrivacyMode[] = ["local-only", "cloud-ok", "execution-ok"];

export function validateArtifactCreateRequest(input: unknown): ArtifactValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, status: 400, error: "JSON body required" };
  }

  const body = input as Partial<ArtifactCreateRequest>;
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const projectSlug = slugifyWorkspaceSegment(project);
  const artifactType = body.artifactType;
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  const messageIds = Array.isArray(body.messageIds)
    ? body.messageIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.trim().length > 0
      ? body.conversationId.trim()
      : undefined;
  const hasPrivacyField = Object.prototype.hasOwnProperty.call(body, "privacy");

  if (!project || !projectSlug) {
    return { ok: false, status: 400, error: "study is required" };
  }

  if (!artifactType || !ARTIFACT_TYPES.includes(artifactType)) {
    return { ok: false, status: 400, error: "artifactType must be a supported artifact class" };
  }

  if (!intent) {
    return { ok: false, status: 400, error: "intent is required" };
  }

  if (!hasExplicitArtifactIntent(intent, artifactType)) {
    return {
      ok: false,
      status: 400,
      error: "Artifact creation requires an explicit make-the-artifact request, not a vague brainstorming prompt",
    };
  }

  if (
    hasPrivacyField &&
    (typeof body.privacy !== "string" || !PRIVACY_MODES.includes(body.privacy as PrivacyMode))
  ) {
    return { ok: false, status: 400, error: "privacy must be local-only, cloud-ok, or execution-ok" };
  }

  const requestedPrivacy = hasPrivacyField ? body.privacy as PrivacyMode : undefined;

  const normalizedPayload = {
    project: projectSlug,
    artifactType,
    intent,
    conversationId: conversationId ?? null,
    messageIds: [...messageIds].sort(),
    privacy: requestedPrivacy ?? null,
  };

  return {
    ok: true,
    status: 200,
    value: {
      project,
      projectSlug,
      artifactType,
      intent,
      conversationId,
      messageIds,
      requestedPrivacy,
      idempotencyKey: crypto
        .createHash("sha256")
        .update(JSON.stringify(normalizedPayload))
        .digest("hex"),
    },
  };
}

export function hasExplicitArtifactIntent(
  intent: string,
  artifactType: SupportedArtifactType,
): boolean {
  const trimmed = intent.trim();
  if (trimmed.length < 12) return false;

  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount < 3) return false;

  const typePhrase = artifactType.replace(/-/g, " ");
  if (EXPLICIT_CREATE_PATTERN.test(trimmed)) return true;
  if (trimmed.toLowerCase().includes(typePhrase)) return true;
  if (LOW_SIGNAL_PATTERN.test(trimmed)) return false;
  return true;
}
