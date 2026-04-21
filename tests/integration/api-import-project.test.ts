import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tempDir: string | null = null;

async function createImportDirectory() {
  const tmpRoot = path.join(os.homedir(), "tmp");
  await mkdir(tmpRoot, { recursive: true });
  tempDir = await mkdtemp(path.join(tmpRoot, "scienceswarm-import-route-"));
  await writeFile(path.join(tempDir, "README.md"), "# Import Alpha\n\nCorpus notes.\n", "utf-8");
  return tempDir;
}

function buildRequest(targetPath: string): Request {
  return new Request("http://localhost/api/import-project", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: targetPath }),
  });
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("POST /api/import-project", () => {
  it("imports a directory from an absolute path", async () => {
    const absolutePath = await createImportDirectory();
    await writeFile(path.join(absolutePath, ".DS_Store"), "Finder metadata", "utf-8");
    const { POST } = await import("@/app/api/import-project/route");

    const response = await POST(buildRequest(absolutePath));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.basePath).toBe(absolutePath);
    expect(data.name).toBe(path.basename(absolutePath));
    expect(data.totalFiles).toBe(1);
    expect(data.detectedFiles).toBe(1);
    expect(data.detectedItems).toBe(1);
    expect(data.analysis).toContain("Local scan preview (local-scan)");
    expect(data.analysis).toContain("Files: 1 prepared for import");
    expect(data.preview.analysis).toContain("Local scan:");
    expect(data.files[0]?.path).toBe("README.md");
    expect(data.files.map((file: { path: string }) => file.path)).not.toContain(".DS_Store");
  });

  it("rejects cross-site browser requests", async () => {
    const absolutePath = await createImportDirectory();
    const { POST } = await import("@/app/api/import-project/route");

    const response = await POST(
      new Request("http://localhost/api/import-project", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({ path: absolutePath }),
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("expands tilde-prefixed paths before importing", async () => {
    const absolutePath = await createImportDirectory();
    const tildePath = `~${absolutePath.slice(os.homedir().length)}`;
    const { POST } = await import("@/app/api/import-project/route");

    const response = await POST(buildRequest(tildePath));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.basePath).toBe(absolutePath);
    expect(data.name).toBe(path.basename(absolutePath));
    expect(data.totalFiles).toBe(1);
    expect(data.detectedFiles).toBe(1);
    expect(data.detectedItems).toBe(1);
    expect(data.analysis).toContain("Local scan preview (local-scan)");
    expect(data.analysis).toContain("Files: 1 prepared for import");
    expect(data.files[0]?.path).toBe("README.md");
  });

  it("reports full folder totals while capping prepared imports", async () => {
    const tmpRoot = path.join(os.homedir(), "tmp");
    await mkdir(tmpRoot, { recursive: true });
    tempDir = await mkdtemp(path.join(tmpRoot, "scienceswarm-import-route-cap-"));
    for (let index = 0; index < 505; index += 1) {
      await writeFile(
        path.join(tempDir, `note-${index.toString().padStart(3, "0")}.md`),
        `# Note ${index}\n`,
        "utf-8",
      );
    }

    const { POST } = await import("@/app/api/import-project/route");
    const response = await POST(buildRequest(tempDir));
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.totalFiles).toBe(500);
    expect(data.detectedFiles).toBe(505);
    expect(data.detectedItems).toBe(505);
    expect(data.analysis).toContain("Local scan preview (local-scan)");
    expect(data.analysis).toContain("Files: 100 shown / 500 prepared for import");
    expect(data.preview.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "scan-limit" }),
        expect.objectContaining({ code: "file-limit" }),
      ]),
    );
    expect(data.preview.warnings[0].message).toContain("Local scan found 505 items");
  });
});
