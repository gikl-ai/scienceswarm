// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactApproval } from "@/components/runtime/artifact-approval";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ArtifactApproval", () => {
  it("validates, imports, and retries artifact writeback through the runtime API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        validation: { ok: true },
        artifact: { artifactId: "artifact-1" },
        writeback: { phaseStatus: "gbrain-writeback-pending" },
      }),
    );
    const onImported = vi.fn();

    render(
      <ArtifactApproval
        request={{
          projectId: "project-alpha",
          hostId: "codex",
          sessionId: "rt-session-1",
          sourcePath: "outputs/result.md",
          sourcePathKind: "project-relative",
          importReason: "host-declared-artifact",
          projectPolicy: "cloud-ok",
        }}
        onImported={onImported}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await screen.findByText("Artifact path is allowed.");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/runtime/artifacts",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("\"action\":\"validate\""),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Retry writeback" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(2));
  });
});
