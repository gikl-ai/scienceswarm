// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataPanel } from "@/components/research/data-panel";

describe("DataPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "csv",
      initialFile: {
        path: "workspace/metrics.csv",
        name: "metrics.csv",
        extension: "csv",
      },
      projectId: "project-alpha",
      workspaceContent: "name,score\nalpha,7\nbeta,9\n",
      expectedFormat: "csv",
      parsedTable: {
        columns: ["name", "score"],
        rows: [
          ["alpha", 7],
          ["beta", 9],
        ],
      },
      expectedWorkspaceUrl:
        "/api/workspace?action=read&file=workspace%2Fmetrics.csv&projectId=project-alpha",
    },
    {
      name: "json",
      initialFile: {
        path: "workspace/metrics.json",
        name: "metrics.json",
        extension: "json",
      },
      projectId: "project-beta",
      workspaceContent:
        '[{"name":"alpha","score":7},{"name":"beta","score":9}]',
      expectedFormat: "json",
      parsedTable: {
        columns: ["name", "score"],
        rows: [
          ["alpha", 7],
          ["beta", 9],
        ],
      },
      expectedWorkspaceUrl:
        "/api/workspace?action=read&file=workspace%2Fmetrics.json&projectId=project-beta",
    },
  ])(
    "auto-loads an initial $name workspace file and renders the parsed table",
    async ({
      initialFile,
      parsedTable,
      expectedFormat,
      expectedWorkspaceUrl,
      projectId,
      workspaceContent,
    }) => {
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);

          if (url === expectedWorkspaceUrl) {
            expect(init).toBeUndefined();
            return Response.json({ content: workspaceContent });
          }

          if (url === "/api/transform") {
            expect(init?.method).toBe("POST");
            expect(init?.headers).toEqual({
              "Content-Type": "application/json",
            });

            const body = JSON.parse(String(init?.body));
            expect(body).toEqual({
              action: "parse",
              data: workspaceContent,
              format: expectedFormat,
            });

            return Response.json({ table: parsedTable });
          }

          throw new Error(`Unexpected fetch url: ${url}`);
        },
      );

      vi.stubGlobal("fetch", fetchMock);

      render(<DataPanel dataFiles={[initialFile]} projectId={projectId} />);

      await waitFor(() => {
        expect(
          screen.getByText(new RegExp(`${parsedTable.rows.length}\\s+rows,\\s*${parsedTable.columns.length}\\s+cols`, "i")),
        ).toBeInTheDocument();
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedWorkspaceUrl);
      expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/transform");

      const table = screen.getByRole("table");
      expect(within(table).getByText("name")).toBeInTheDocument();
      expect(within(table).getByText("score")).toBeInTheDocument();
      expect(within(table).getByText("alpha")).toBeInTheDocument();
      expect(within(table).getByText("beta")).toBeInTheDocument();
      expect(within(table).getByText("7")).toBeInTheDocument();
      expect(within(table).getByText("9")).toBeInTheDocument();
    },
  );

  it("lists all workspace data files and parses workbook previews into a sheet view", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/workspace?action=read&file=data%2Fmetrics.csv&projectId=project-alpha") {
        return Response.json({ content: "name,score\nalpha,7\nbeta,9\n" });
      }

      if (url === "/api/workspace?action=read&file=data%2Fresults.xlsx&projectId=project-alpha") {
        return Response.json({
          content: "Workbook: results.xlsx\n\nSheet: Results\nsample_id | value\nSRG-A01 | 4.82\nSRG-A02 | 5.10\n",
          parsed: true,
          format: "xlsx",
        });
      }

      if (url === "/api/transform") {
        const body = JSON.parse(String(init?.body));
        if (body.action === "parse") {
          return Response.json({
            table: {
              columns: ["name", "score"],
              rows: [
                ["alpha", 7],
                ["beta", 9],
              ],
            },
          });
        }
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <DataPanel
        dataFiles={[
          { path: "data/metrics.csv", name: "metrics.csv", extension: "csv" },
          { path: "data/results.xlsx", name: "results.xlsx", extension: "xlsx" },
        ]}
        projectId="project-alpha"
      />,
    );

    const fileButtons = await screen.findAllByRole("button", { name: /metrics\.csv|results\.xlsx/i });
    expect(fileButtons).toHaveLength(2);
    expect(screen.queryByText("Drop a data file here")).not.toBeInTheDocument();

    expect(await screen.findByText(/2 rows,\s*2 cols/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /results.xlsx/i }));

    await waitFor(() => {
      expect(screen.getByText("sample_id")).toBeInTheDocument();
      expect(screen.getByText("SRG-A01")).toBeInTheDocument();
      expect(screen.getByText("4.82")).toBeInTheDocument();
    });
  });

  it("shows a chart input preview before persisting generated charts", async () => {
    const onGeneratedCharts = vi.fn(async () => {});
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/workspace?action=read&file=data%2Fmetrics.csv&projectId=project-alpha") {
        return Response.json({ content: "name,score\nalpha,7\nbeta,9\n" });
      }

      if (url !== "/api/transform") {
        throw new Error(`Unexpected fetch url: ${url}`);
      }

      const body = JSON.parse(String(init?.body));

      if (body.action === "parse") {
        return Response.json({
          table: {
            columns: ["name", "score"],
            rows: [
              ["alpha", 7],
              ["beta", 9],
            ],
            metadata: { source: "csv", rowCount: 2, transformsApplied: ["parseCSV"] },
          },
        });
      }

      if (body.action === "export") {
        return Response.json({ output: "name,score\nalpha,7\nbeta,9\n" });
      }

      if (body.action === "auto-analyze") {
        return Response.json({
          insights: "Scores improved.",
          charts: [{ title: "Score chart", type: "bar", xColumn: "name", yColumn: "score" }],
        });
      }

      if (body.action === "chart") {
        return Response.json({ svg: "<svg><text>score chart</text></svg>" });
      }

      throw new Error(`Unexpected transform action: ${body.action as string}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <DataPanel
        dataFiles={[{ path: "data/metrics.csv", name: "metrics.csv", extension: "csv" }]}
        projectId="project-alpha"
        onGeneratedCharts={onGeneratedCharts}
      />,
    );

    expect(await screen.findByText(/2 rows,\s*2 cols/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Auto Analyze" }));

    await waitFor(() => {
      expect(screen.getByText("Confirm chart inputs")).toBeInTheDocument();
    });

    expect(onGeneratedCharts).not.toHaveBeenCalled();
    expect(screen.getByText(/Bar chart · 2 rows selected/i)).toBeInTheDocument();
    expect(screen.getAllByText("name").length).toBeGreaterThan(0);
    expect(screen.getAllByText("score").length).toBeGreaterThan(0);
    expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Generate 1 chart" }));

    await waitFor(() => {
      expect(onGeneratedCharts).toHaveBeenCalledWith("metrics.csv", [
        "<svg><text>score chart</text></svg>",
      ]);
    });
  });

  it("adds the selected workspace table to chat context with one click", async () => {
    const onUseInChat = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/workspace?action=read&file=data%2Fmetrics.csv&projectId=project-alpha") {
        return Response.json({ content: "name,score\nalpha,7\nbeta,9\n" });
      }

      if (url === "/api/transform") {
        const body = JSON.parse(String(init?.body));
        if (body.action === "parse") {
          return Response.json({
            table: {
              columns: ["name", "score"],
              rows: [
                ["alpha", 7],
                ["beta", 9],
              ],
              metadata: { source: "csv", rowCount: 2, transformsApplied: ["parseCSV"] },
            },
          });
        }
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    render(
      <DataPanel
        dataFiles={[{ path: "data/metrics.csv", name: "metrics.csv", extension: "csv" }]}
        projectId="project-alpha"
        onUseInChat={onUseInChat}
      />,
    );

    expect(await screen.findByText("2 rows, 2 cols")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use in chat" }));

    expect(onUseInChat).toHaveBeenCalledWith("data/metrics.csv");
  });

  it("re-loads the selected workspace table when the project data files change", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/workspace?action=read&file=data%2Fmetrics.csv&projectId=project-alpha") {
        return Response.json({ content: "name,score\nalpha,7\nbeta,9\n" });
      }

      if (url === "/api/workspace?action=read&file=data%2Fbenchmarks.tsv&projectId=project-alpha") {
        return Response.json({ content: "run\tloss\nbaseline\t0.4\ncandidate\t0.2\n" });
      }

      if (url === "/api/transform") {
        const body = JSON.parse(String(init?.body));
        if (body.action !== "parse") {
          throw new Error(`Unexpected action: ${body.action as string}`);
        }

        if (body.format === "csv") {
          return Response.json({
            table: {
              columns: ["name", "score"],
              rows: [
                ["alpha", 7],
                ["beta", 9],
              ],
              metadata: { source: "metrics.csv", rowCount: 2, transformsApplied: ["parseCSV"] },
            },
          });
        }

        if (body.format === "tsv") {
          return Response.json({
            table: {
              columns: ["run", "loss"],
              rows: [
                ["baseline", 0.4],
                ["candidate", 0.2],
              ],
              metadata: { source: "benchmarks.tsv", rowCount: 2, transformsApplied: ["parseTSV"] },
            },
          });
        }
      }

      throw new Error(`Unexpected fetch url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      <DataPanel
        dataFiles={[
          { path: "data/metrics.csv", name: "metrics.csv", extension: "csv" },
        ]}
        projectId="project-alpha"
      />,
    );

    expect(await screen.findByText("2 rows, 2 cols")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();

    view.rerender(
      <DataPanel
        dataFiles={[
          { path: "data/benchmarks.tsv", name: "benchmarks.tsv", extension: "tsv" },
        ]}
        projectId="project-alpha"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /benchmarks\.tsv/i })).toBeInTheDocument();
      expect(screen.getByText("baseline")).toBeInTheDocument();
      expect(screen.getByText("candidate")).toBeInTheDocument();
    });
  });
});
