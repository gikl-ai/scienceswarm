import { describe, expect, it, vi } from "vitest";

const { parseFile } = vi.hoisted(() => ({
  parseFile: vi.fn(),
}));

vi.mock("@/lib/file-parser", () => ({
  parseFile,
}));

import { POST } from "@/app/api/parse-file/route";

describe("POST /api/parse-file", () => {
  it("returns parsed text for a CSV file", async () => {
    parseFile.mockResolvedValueOnce({
      text: "name,age\nAlice,30",
    });

    const formData = new FormData();
    formData.append(
      "file",
      new File(["name,age\nAlice,30"], "data.csv", { type: "text/csv" }),
    );

    const request = new Request("http://localhost/api/parse-file", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.text).toBe("name,age\nAlice,30");
    expect(body.name).toBe("data.csv");
  });

  it("returns 400 when no file is provided", async () => {
    const formData = new FormData();

    const request = new Request("http://localhost/api/parse-file", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("No file provided");
  });

  it("returns 500 when parsing throws", async () => {
    parseFile.mockRejectedValueOnce(new Error("Parse failure"));

    const formData = new FormData();
    formData.append("file", new File(["bad data"], "test.xyz"));

    const request = new Request("http://localhost/api/parse-file", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe("Parse failure");
  });

  it("returns page count for PDF files", async () => {
    parseFile.mockResolvedValueOnce({
      text: "Abstract: ...",
      pages: 12,
    });

    const formData = new FormData();
    formData.append(
      "file",
      new File(["pdf bytes"], "paper.pdf", { type: "application/pdf" }),
    );

    const request = new Request("http://localhost/api/parse-file", {
      method: "POST",
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pages).toBe(12);
    expect(body.name).toBe("paper.pdf");
  });

  it("rejects cross-site browser requests", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File(["name,age\nAlice,30"], "data.csv", { type: "text/csv" }),
    );

    const request = new Request("http://localhost/api/parse-file", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: formData,
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });
});
