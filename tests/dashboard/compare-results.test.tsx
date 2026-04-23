// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CompareResults } from "@/components/runtime/compare-results";

describe("CompareResults", () => {
  it("keeps per-host provenance and partial failures visible", () => {
    const onApproveSynthesis = vi.fn();

    render(
      <CompareResults
        result={{
          parentSession: { id: "parent-1", status: "completed" },
          partialFailure: true,
          childResults: [
            {
              sessionId: "child-openclaw",
              hostId: "openclaw",
              status: "completed",
              message: "OpenClaw answer",
              error: null,
            },
            {
              sessionId: "child-codex",
              hostId: "codex",
              status: "failed",
              message: null,
              error: "Auth expired",
            },
          ],
          synthesisPreview: {
            allowed: true,
            projectPolicy: "cloud-ok",
            hostId: "openclaw",
            mode: "chat",
            effectivePrivacyClass: "local-network",
            destinations: [
              { hostId: "openclaw", label: "OpenClaw", privacyClass: "local-network" },
            ],
            dataIncluded: [
              { kind: "runtime-output", label: "Compare output from openclaw", bytes: 15 },
            ],
            proof: {
              projectGatePassed: true,
              operationPrivacyClass: "local-network",
              adapterProof: "declared-local",
            },
            blockReason: null,
            requiresUserApproval: false,
            accountDisclosure: {
              authMode: "local",
              provider: "openclaw",
              billingClass: "local-compute",
              accountSource: "local-service",
              costCopyRequired: false,
            },
          },
        }}
        onApproveSynthesis={onApproveSynthesis}
      />,
    );

    expect(screen.getByText("openclaw")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw answer")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("Auth expired")).toBeInTheDocument();
    expect(screen.getByText("Partial failure")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve synthesis" }));
    expect(onApproveSynthesis).toHaveBeenCalled();
  });
});
