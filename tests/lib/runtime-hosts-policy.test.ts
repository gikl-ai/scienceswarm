import { describe, expect, it } from "vitest";

import {
  RuntimePreviewApprovalRequired,
  RuntimePrivacyBlocked,
  assertHostSupportsTurnMode,
  assertTurnPreviewAllowsPromptConstruction,
  computeTurnPreview,
  requireRuntimeHostProfile,
  type RuntimeDataIncluded,
  type RuntimeProjectPolicy,
} from "@/lib/runtime-hosts";

const projectData: RuntimeDataIncluded[] = [
  { kind: "prompt", label: "User prompt", bytes: 40 },
  { kind: "gbrain-excerpt", label: "project-alpha memory", bytes: 120 },
  { kind: "workspace-file", label: "notes.md", bytes: 80 },
];

describe("runtime host TurnPreview policy", () => {
  it("evaluates the project policy x host privacy x mode matrix", () => {
    const openclaw = requireRuntimeHostProfile("openclaw");
    const claude = requireRuntimeHostProfile("claude-code");
    const codex = requireRuntimeHostProfile("codex");
    const gemini = requireRuntimeHostProfile("gemini-cli");

    expect(
      computeTurnPreview({
        projectPolicy: "local-only",
        host: openclaw,
        mode: "chat",
        dataIncluded: projectData,
      }),
    ).toMatchObject({
      allowed: true,
      requiresUserApproval: false,
      effectivePrivacyClass: "local-network",
    });

    for (const host of [claude, codex, gemini]) {
      expect(
        computeTurnPreview({
          projectPolicy: "local-only",
          host,
          mode: "chat",
          dataIncluded: projectData,
        }),
      ).toMatchObject({
        allowed: false,
        requiresUserApproval: false,
        effectivePrivacyClass: "hosted",
        blockReason: expect.stringContaining("would send data to a third party"),
      });
    }

    expect(
      computeTurnPreview({
        projectPolicy: "cloud-ok",
        host: claude,
        mode: "chat",
        dataIncluded: projectData,
      }),
    ).toMatchObject({
      allowed: true,
      requiresUserApproval: true,
      effectivePrivacyClass: "hosted",
      accountDisclosure: {
        provider: "anthropic",
        billingClass: "subscription-native",
        accountSource: "host-cli-login",
      },
    });

    expect(
      computeTurnPreview({
        projectPolicy: "cloud-ok",
        host: codex,
        mode: "task",
        dataIncluded: projectData,
      }),
    ).toMatchObject({
      allowed: false,
      blockReason: expect.stringContaining("switch to execution-ok first"),
    });

    expect(
      computeTurnPreview({
        projectPolicy: "execution-ok",
        host: codex,
        mode: "task",
        dataIncluded: projectData,
      }),
    ).toMatchObject({
      allowed: true,
      requiresUserApproval: true,
      effectivePrivacyClass: "hosted",
    });
  });

  it("blocks local-only project content before hosted prompt construction", () => {
    const preview = computeTurnPreview({
      projectPolicy: "local-only",
      host: requireRuntimeHostProfile("codex"),
      mode: "chat",
      dataIncluded: projectData,
    });

    expect(preview.allowed).toBe(false);
    expect(preview.blockReason).toContain("would send data to a third party");
    expect(() => assertTurnPreviewAllowsPromptConstruction(preview)).toThrow(
      RuntimePrivacyBlocked,
    );
  });

  it("requires explicit approval for cloud-ok hosted chat", () => {
    const preview = computeTurnPreview({
      projectPolicy: "cloud-ok",
      host: requireRuntimeHostProfile("claude-code"),
      mode: "chat",
      dataIncluded: projectData,
    });

    expect(preview).toMatchObject({
      allowed: true,
      requiresUserApproval: true,
    });
    expect(() => assertTurnPreviewAllowsPromptConstruction(preview)).toThrow(
      RuntimePreviewApprovalRequired,
    );
    expect(() =>
      assertTurnPreviewAllowsPromptConstruction(preview, true)
    ).not.toThrow();
  });

  it("requires execution-ok approval for task-capable third-party destinations", () => {
    const preview = computeTurnPreview({
      projectPolicy: "execution-ok",
      host: requireRuntimeHostProfile("gemini-cli"),
      mode: "task",
      dataIncluded: projectData,
    });

    expect(preview).toMatchObject({
      allowed: true,
      requiresUserApproval: true,
      accountDisclosure: {
        provider: "google-ai",
      },
    });
    expect(() => assertTurnPreviewAllowsPromptConstruction(preview)).toThrow(
      RuntimePreviewApprovalRequired,
    );
    expect(() =>
      assertTurnPreviewAllowsPromptConstruction(preview, true)
    ).not.toThrow();
  });

  it("uses compare intersection and blocks when any selected host violates policy", () => {
    const openclaw = requireRuntimeHostProfile("openclaw");
    const claude = requireRuntimeHostProfile("claude-code");

    expect(
      computeTurnPreview({
        projectPolicy: "local-only",
        host: openclaw,
        selectedHosts: [openclaw],
        mode: "compare",
        dataIncluded: projectData,
      }),
    ).toMatchObject({
      allowed: true,
      requiresUserApproval: false,
      accountDisclosure: {
        compareFanOutCount: 1,
      },
    });

    const blocked = computeTurnPreview({
      projectPolicy: "local-only",
      host: openclaw,
      selectedHosts: [openclaw, claude],
      mode: "compare",
      dataIncluded: projectData,
    });
    expect(blocked).toMatchObject({
      allowed: false,
      blockReason: expect.stringContaining("Local-only projects can compare"),
      accountDisclosure: {
        compareFanOutCount: 2,
      },
    });

    expect(
      computeTurnPreview({
        projectPolicy: "cloud-ok",
        host: openclaw,
        selectedHosts: [openclaw, claude],
        mode: "compare",
        dataIncluded: projectData,
      }),
    ).toMatchObject({
      allowed: true,
      requiresUserApproval: true,
      effectivePrivacyClass: "hosted",
      accountDisclosure: {
        compareFanOutCount: 2,
      },
    });
  });

  it("treats compare synthesis as its own preview with child outputs included", () => {
    const childOutputs: RuntimeDataIncluded[] = [
      {
        kind: "runtime-output",
        label: "OpenClaw comparison child output",
        bytes: 250,
      },
      {
        kind: "runtime-output",
        label: "Claude Code comparison child output",
        bytes: 300,
      },
    ];

    const localSynthesis = computeTurnPreview({
      projectPolicy: "local-only",
      host: requireRuntimeHostProfile("openclaw"),
      mode: "chat",
      dataIncluded: childOutputs,
    });

    expect(localSynthesis).toMatchObject({
      allowed: true,
      requiresUserApproval: false,
      dataIncluded: childOutputs,
    });

    const hostedSynthesis = computeTurnPreview({
      projectPolicy: "local-only",
      host: requireRuntimeHostProfile("claude-code"),
      mode: "chat",
      dataIncluded: childOutputs,
    });

    expect(hostedSynthesis).toMatchObject({
      allowed: false,
      blockReason: expect.stringContaining("would send data to a third party"),
      dataIncluded: childOutputs,
    });
  });

  it("lets adapter proof narrow hosted profiles only when the operation is declared local", () => {
    const claude = requireRuntimeHostProfile("claude-code");
    const narrowed = computeTurnPreview({
      projectPolicy: "local-only",
      host: claude,
      mode: "chat",
      dataIncluded: projectData,
      adapterProof: {
        privacyClass: "local-network",
        adapterProof: "declared-local",
      },
    });

    expect(narrowed).toMatchObject({
      allowed: true,
      effectivePrivacyClass: "local-network",
      proof: {
        adapterProof: "declared-local",
      },
    });

    const widened = computeTurnPreview({
      projectPolicy: "local-only",
      host: claude,
      mode: "chat",
      dataIncluded: projectData,
      adapterProof: {
        privacyClass: "external-network",
        adapterProof: "declared-hosted",
      },
    });

    expect(widened).toMatchObject({
      allowed: false,
      effectivePrivacyClass: "external-network",
    });
  });

  it("throws typed capability errors for unsupported controls", () => {
    const openclaw = requireRuntimeHostProfile("openclaw");

    expect(() => assertHostSupportsTurnMode(openclaw, "task")).toThrow(
      "AI destination openclaw does not support task.",
    );
  });

  it.each<RuntimeProjectPolicy>(["local-only", "cloud-ok", "execution-ok"])(
    "keeps OpenClaw chat available for %s projects",
    (projectPolicy) => {
      expect(
        computeTurnPreview({
          projectPolicy,
          host: requireRuntimeHostProfile("openclaw"),
          mode: "chat",
          dataIncluded: projectData,
        }),
      ).toMatchObject({
        allowed: true,
        effectivePrivacyClass: "local-network",
      });
    },
  );
});
