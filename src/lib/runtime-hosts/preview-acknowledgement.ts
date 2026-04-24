import type { TurnPreview } from "./contracts";

const ACKNOWLEDGEMENT_PREFIX = "scienceswarm.runtimePreview.chatAcknowledged.v1";

function isLocalPrivacyClass(privacyClass: TurnPreview["effectivePrivacyClass"]): boolean {
  return privacyClass === "local-only" || privacyClass === "local-network";
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage ?? null;
}

export function shouldRememberRuntimePreview(preview: TurnPreview): boolean {
  return (
    preview.mode === "chat"
    && preview.allowed
    && preview.requiresUserApproval
    && !isLocalPrivacyClass(preview.effectivePrivacyClass)
  );
}

export function runtimePreviewAcknowledgementKey(input: {
  projectId: string | null | undefined;
  preview: TurnPreview;
}): string {
  const destinations = input.preview.destinations
    .map((destination) => `${destination.hostId}:${destination.privacyClass}`)
    .sort()
    .join(",");

  return [
    ACKNOWLEDGEMENT_PREFIX,
    input.projectId || "global",
    input.preview.projectPolicy,
    input.preview.mode,
    input.preview.effectivePrivacyClass,
    destinations || input.preview.hostId,
  ].join(":");
}

export function hasRuntimePreviewAcknowledgement(input: {
  projectId: string | null | undefined;
  preview: TurnPreview;
}): boolean {
  if (!shouldRememberRuntimePreview(input.preview)) return false;

  try {
    return storage()?.getItem(runtimePreviewAcknowledgementKey(input)) === "true";
  } catch {
    return false;
  }
}

export function rememberRuntimePreviewAcknowledgement(input: {
  projectId: string | null | undefined;
  preview: TurnPreview;
}): void {
  if (!shouldRememberRuntimePreview(input.preview)) return;

  try {
    storage()?.setItem(runtimePreviewAcknowledgementKey(input), "true");
  } catch {
    // Local storage is an optimization for reducing repeated interruptions.
  }
}
