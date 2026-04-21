// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareFolderForAnalysis, processFolder } from "@/lib/folder-processor";

describe("folder-processor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps browser-picked research formats readable for preview analysis", async () => {
    const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
      const [, init] = args;
      const formData = init?.body;
      if (!(formData instanceof FormData)) {
        throw new Error("Expected FormData body");
      }

      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new Error("Expected uploaded file");
      }

      if (file.name === "explore.ipynb") {
        return Response.json({
          text: "Notebook: explore.ipynb\n\nCell 1 [markdown]\nHypothesis\n\nCell 2 [code]\nprint('ok')",
          metadata: { cells: 2, markdownCells: 1, codeCells: 1 },
        });
      }

      if (file.name === "metadata.xlsx") {
        return Response.json({
          text: "Workbook: metadata.xlsx\n\nSheet: Samples\nsample_id | treatment",
          metadata: { sheets: ["Samples"], rows: 12, columns: 2 },
        });
      }

      if (file.name === "draft.pdf") {
        return Response.json({
          text: "Draft PDF text",
          pages: 4,
        });
      }

      throw new Error(`Unexpected parse request for ${file.name}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const notebook = withRelativePath(
      new File(["{}"], "explore.ipynb", { type: "application/x-ipynb+json" }),
      "picked-archive/analysis/explore.ipynb",
    );
    const workbook = withRelativePath(
      new File(["PK\x03\x04"], "metadata.xlsx"),
      "picked-archive/data/metadata.xlsx",
    );
    const stats = withRelativePath(
      new File(["DATA LIST FREE /x y.\nBEGIN DATA\n1 2\nEND DATA."], "model.sps"),
      "picked-archive/stats/model.sps",
    );
    const paper = withRelativePath(
      new File(["%PDF-1.7"], "draft.pdf", { type: "application/pdf" }),
      "picked-archive/papers/draft.pdf",
    );

    const folder = await processFolder([notebook, workbook, stats, paper]);

    expect(folder.name).toBe("picked-archive");
    expect(folder.files.map((file) => file.path)).toEqual([
      "analysis/explore.ipynb",
      "data/metadata.xlsx",
      "stats/model.sps",
      "papers/draft.pdf",
    ]);

    expect(folder.files[0]).toMatchObject({
      type: "ipynb",
      content: expect.stringContaining("Notebook: explore.ipynb"),
      metadata: { cells: 2, markdownCells: 1, codeCells: 1 },
    });
    expect(folder.files[1]).toMatchObject({
      type: "xlsx",
      content: expect.stringContaining("Workbook: metadata.xlsx"),
      metadata: { sheets: ["Samples"], rows: 12, columns: 2 },
    });
    expect(folder.files[2]).toMatchObject({
      type: "sps",
      content: expect.stringContaining("BEGIN DATA"),
    });
    expect(folder.files[3]).toMatchObject({
      type: "pdf",
      content: "Draft PDF text",
      metadata: { pages: 4 },
    });

    expect(folder.tree).toMatchObject([
      {
        name: "analysis",
        type: "directory",
        children: [{ name: "explore.ipynb", type: "file", size: expect.any(String) }],
      },
      {
        name: "data",
        type: "directory",
        children: [{ name: "metadata.xlsx", type: "file", size: expect.any(String) }],
      },
      {
        name: "stats",
        type: "directory",
        children: [{ name: "model.sps", type: "file", size: expect.any(String) }],
      },
      {
        name: "papers",
        type: "directory",
        children: [{ name: "draft.pdf", type: "file", size: expect.any(String) }],
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(3);

    const analysisInput = prepareFolderForAnalysis(folder);
    expect(analysisInput.previewFiles).toHaveLength(4);
    expect(analysisInput.previewFiles.every((file) => typeof file.hash === "string" && file.hash.length > 0)).toBe(true);
  });
});

function withRelativePath(file: File, webkitRelativePath: string): File {
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: webkitRelativePath,
  });
  return file;
}
