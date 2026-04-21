// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const brainProgressSpy = vi.fn();

vi.mock("@/components/progress/brain-progress", () => ({
  BrainProgress: (props: { requestBody?: Record<string, unknown> }) => {
    brainProgressSpy(props);
    return (
      <div data-testid="brain-progress-request">
        {JSON.stringify(props.requestBody ?? null)}
      </div>
    );
  },
}));

import { WarmStartSection } from "@/components/setup/warm-start-section";

describe("WarmStartSection", () => {
  beforeEach(() => {
    brainProgressSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("routes warm-start imports into the active project slug when provided", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/brain/coldstart") {
        return Response.json({
          files: [
            {
              path: "/tmp/project-alpha/notes/summary.md",
              type: "note",
              size: 24,
              classification: "note",
              projectCandidates: ["project-alpha"],
              warnings: [],
            },
          ],
          projects: [
            {
              slug: "detected-preview-bucket",
              title: "Detected Preview Bucket",
              confidence: "medium",
              reason: "Folder grouping",
              sourcePaths: ["notes/summary.md"],
            },
          ],
          duplicateGroups: [],
          warnings: [],
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<WarmStartSection projectSlug="project-alpha" />);

    expect(screen.getByText("project-alpha")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("warm-start-path-input"), {
      target: { value: "/tmp/project-alpha" },
    });
    fireEvent.click(screen.getByTestId("warm-start-scan-button"));

    expect(await screen.findByTestId("warm-start-summary")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("warm-start-import-button"));

    await waitFor(() => {
      expect(brainProgressSpy).toHaveBeenCalled();
    });

    const [{ requestBody }] = brainProgressSpy.mock.calls.at(-1) as [
      { requestBody?: Record<string, unknown> },
    ];
    expect(requestBody).toMatchObject({
      options: {
        skipDuplicates: true,
        projectSlug: "project-alpha",
      },
    });
  });
});
