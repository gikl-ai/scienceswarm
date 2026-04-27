import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/analyze-folder", () => {
  it("preserves AI-backed analysis/backend fields while adding preview data", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        response: "AI project overview",
        backend: "unified-ai",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { POST } = await import("@/app/api/analyze-folder/route");
    const request = new Request("http://localhost/api/analyze-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Imported: Alpha Project (2 files)",
        fileContents: [
          { path: "README.md", type: "md", content: "# Alpha Project" },
          { path: "data/results.csv", type: "csv", content: "gene,score\nfoo,1" },
        ],
        previewFiles: [
          { path: "README.md", type: "md", size: 15, content: "# Alpha Project" },
          { path: "data/results.csv", type: "csv", size: 16, content: "gene,score\nfoo,1" },
        ],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.analysis).toBe("AI project overview");
    expect(data.backend).toBe("unified-ai");
    expect(data.preview.analysis).toBe("AI project overview");
    expect(data.preview.backend).toBe("unified-ai");
    expect(data.preview.files).toHaveLength(2);
    expect(data.projects[0].slug).toBe("alpha-project");
    expect(data.duplicateGroups).toEqual([]);
    expect(data.warnings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(String(init.body)).toContain("Analyze this research study folder");
    expect(String(init.body)).not.toContain("Analyze this research project folder");
  });

  it("preserves local fallback analysis/backend fields while adding preview data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("chat unavailable");
    }));

    const { POST } = await import("@/app/api/analyze-folder/route");
    const request = new Request("http://localhost/api/analyze-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Folder: Beta Folder (2 files)",
        fileContents: [
          { path: "paper.pdf", type: "pdf", content: "Extracted paper text" },
          { path: "src/train.py", type: "py", content: "# train model\nprint('ok')" },
        ],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.backend).toBe("local");
    expect(data.analysis).toContain("Study Analysis");
    expect(data.analysis).toContain("Folder: Beta Folder (2 files)");
    expect(data.preview.analysis).toBe(data.analysis);
    expect(data.preview.backend).toBe("local");
    expect(data.preview.files).toHaveLength(2);
    expect(data.projects[0].slug).toBe("beta-folder");
  });

  it("returns 400 for invalid request bodies", async () => {
    const { POST } = await import("@/app/api/analyze-folder/route");
    const request = new Request("http://localhost/api/analyze-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Imported: Gamma",
        fileContents: [{ path: "README.md", type: "md", content: 42 }],
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
