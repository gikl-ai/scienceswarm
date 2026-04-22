// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchedulerPanel } from "@/components/research/scheduler-panel";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SchedulerPanel", () => {
  it("creates project-scoped recurring jobs with explicit expected outputs", async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({ jobs: [], pipelines: [] }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ id: "job-1", status: "scheduled" }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ jobs: [], pipelines: [] }),
      });

    render(
      <SchedulerPanel
        projectId="project-alpha"
        defaultJobName="Nightly project rerun"
        defaultJobType="recurring"
        defaultSchedule="0 0 * * *"
        defaultOutputPath="results/nightly-rerun-result.md"
      />,
    );

    await screen.findByText("No scheduled jobs or pipelines yet");
    fireEvent.click(screen.getByRole("button", { name: "+ New Job" }));
    fireEvent.change(screen.getByDisplayValue("Nightly project rerun"), {
      target: { value: "Nightly Project Alpha rerun" },
    });
    fireEvent.change(screen.getByPlaceholderText(/python experiments/i), {
      target: {
        value:
          "python experiments/project_alpha_eval.py --dataset data/original-observations.csv --output results/nightly-rerun-result.md",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Job" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/scheduler",
      expect.objectContaining({ method: "POST" }),
    ));

    const postBody = JSON.parse(
      fetchMock.mock.calls.find((call) => call[1]?.method === "POST")?.[1]?.body as string,
    ) as {
      job: {
        name: string;
        type: string;
        schedule?: string;
        action: {
          script?: string;
          config?: Record<string, unknown>;
        };
      };
    };

    expect(postBody.job).toMatchObject({
      name: "Nightly Project Alpha rerun",
      type: "recurring",
      schedule: "0 0 * * *",
      action: {
        script:
          "python experiments/project_alpha_eval.py --dataset data/original-observations.csv --output results/nightly-rerun-result.md",
        config: {
          projectId: "project-alpha",
          expectedOutputPath: "results/nightly-rerun-result.md",
        },
      },
    });

    await screen.findByText("No scheduled jobs or pipelines yet");
    fireEvent.click(screen.getByRole("button", { name: "+ New Job" }));
    expect(screen.getByDisplayValue("Nightly project rerun")).toBeInTheDocument();
    expect(screen.getByDisplayValue("0 0 * * *")).toBeInTheDocument();
    expect(screen.getByDisplayValue("results/nightly-rerun-result.md")).toBeInTheDocument();
  });

  it("shows what scheduled jobs will run and where outputs should appear", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        jobs: [
          {
            id: "job-1",
            name: "Nightly Project Alpha rerun",
            type: "recurring",
            schedule: "0 0 * * *",
            action: {
              type: "run-script",
              script:
                "python experiments/project_alpha_eval.py --dataset data/original-observations.csv --output results/nightly-rerun-result.md",
              config: {
                projectId: "project-alpha",
                expectedOutputPath: "results/nightly-rerun-result.md",
              },
            },
            status: "pending",
            nextRun: "2026-04-23T07:00:00.000Z",
            logs: ["[2026-04-22T22:00:00.000Z] Job created"],
            createdAt: "2026-04-22T22:00:00.000Z",
          },
        ],
        pipelines: [],
      }),
    });

    render(<SchedulerPanel projectId="project-alpha" />);

    fireEvent.click(await screen.findByText("Nightly Project Alpha rerun"));

    expect(screen.getByText("What This Job Will Run")).toBeInTheDocument();
    expect(screen.getByText("project-alpha")).toBeInTheDocument();
    expect(
      screen.getByText(/python experiments\/project_alpha_eval\.py/),
    ).toBeInTheDocument();
    expect(screen.getByText("results/nightly-rerun-result.md")).toBeInTheDocument();
    expect(screen.getByText("0 0 * * *")).toBeInTheDocument();
  });

  it("clears hidden script state when switching away from run-script actions", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ jobs: [], pipelines: [] }),
    });

    render(<SchedulerPanel projectId="project-alpha" />);

    await screen.findByText("No scheduled jobs or pipelines yet");
    fireEvent.click(screen.getByRole("button", { name: "+ New Job" }));
    fireEvent.change(screen.getByPlaceholderText(/python experiments/i), {
      target: { value: "python stale_script.py" },
    });
    fireEvent.click(screen.getByRole("button", { name: "ai-analysis" }));
    expect(screen.queryByDisplayValue("python stale_script.py")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "run-script" }));
    expect(screen.queryByDisplayValue("python stale_script.py")).not.toBeInTheDocument();
  });
});
