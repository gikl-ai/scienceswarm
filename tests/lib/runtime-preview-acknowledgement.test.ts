// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import type { TurnPreview } from "@/lib/runtime-hosts/contracts";
import {
  hasRuntimePreviewAcknowledgement,
  rememberRuntimePreviewAcknowledgement,
  runtimePreviewAcknowledgementKey,
  shouldRememberRuntimePreview,
} from "@/lib/runtime-hosts/preview-acknowledgement";

function preview(overrides: Partial<TurnPreview> = {}): TurnPreview {
  return {
    allowed: true,
    projectPolicy: "cloud-ok",
    hostId: "claude-code",
    mode: "chat",
    effectivePrivacyClass: "hosted",
    destinations: [
      { hostId: "claude-code", label: "Claude Code", privacyClass: "hosted" },
    ],
    dataIncluded: [
      { kind: "prompt", label: "User prompt", bytes: 19 },
    ],
    proof: {
      projectGatePassed: true,
      operationPrivacyClass: "hosted",
      adapterProof: "declared-hosted",
    },
    blockReason: null,
    requiresUserApproval: true,
    accountDisclosure: {
      authMode: "subscription-native",
      provider: "anthropic",
      billingClass: "subscription-native",
      accountSource: "host-cli-login",
      estimatedRequestBytes: 19,
      costCopyRequired: false,
    },
    ...overrides,
  };
}

describe("runtime preview acknowledgement", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("remembers hosted chat acknowledgement per project and host", () => {
    const turnPreview = preview();

    expect(shouldRememberRuntimePreview(turnPreview)).toBe(true);
    expect(hasRuntimePreviewAcknowledgement({ projectId: "seiji-project", preview: turnPreview }))
      .toBe(false);

    rememberRuntimePreviewAcknowledgement({ projectId: "seiji-project", preview: turnPreview });

    expect(hasRuntimePreviewAcknowledgement({ projectId: "seiji-project", preview: turnPreview }))
      .toBe(true);
    expect(hasRuntimePreviewAcknowledgement({ projectId: "other-project", preview: turnPreview }))
      .toBe(false);
  });

  it("does not remember blocked, local, or task previews", () => {
    expect(shouldRememberRuntimePreview(preview({ allowed: false }))).toBe(false);
    expect(shouldRememberRuntimePreview(preview({ effectivePrivacyClass: "local-only" }))).toBe(false);
    expect(shouldRememberRuntimePreview(preview({ effectivePrivacyClass: "local-network" })))
      .toBe(false);
    expect(shouldRememberRuntimePreview(preview({ mode: "task" }))).toBe(false);
  });

  it("uses sorted destinations in the acknowledgement key", () => {
    const first = preview({
      destinations: [
        { hostId: "codex", label: "Codex", privacyClass: "hosted" },
        { hostId: "claude-code", label: "Claude Code", privacyClass: "hosted" },
      ],
    });
    const second = preview({
      destinations: [
        { hostId: "claude-code", label: "Claude Code", privacyClass: "hosted" },
        { hostId: "codex", label: "Codex", privacyClass: "hosted" },
      ],
    });

    expect(runtimePreviewAcknowledgementKey({ projectId: "project-alpha", preview: first }))
      .toBe(runtimePreviewAcknowledgementKey({ projectId: "project-alpha", preview: second }));
  });
});
