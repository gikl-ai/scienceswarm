import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POST } from "@/app/api/workspace/upload/route";
import type { GbrainClient } from "@/brain/gbrain-client";
import { createGbrainFileStore } from "@/brain/gbrain-file-store";
import { createIngestService } from "@/brain/ingest/service";
import { ensureBrainStoreReady, getBrainStore, resetBrainStore } from "@/brain/store";
import { __setIngestServiceOverride } from "@/lib/testing/workspace-upload-route-overrides";

const FIXTURES = join(process.cwd(), "tests/fixtures/audit-revise");

class FakeGbrainClient implements GbrainClient {
  calls: Array<{ slug: string; content: string }> = [];
  links: Array<{ from: string; to: string }> = [];
  async putPage(slug: string, content: string) {
    this.calls.push({ slug, content });
    return { stdout: `created ${slug}`, stderr: "" };
  }
  async linkPages(from: string, to: string) {
    this.links.push({ from, to });
    return { stdout: `linked ${from} -> ${to}`, stderr: "" };
  }
}

function buildFormData(
  entries: Array<{ name: string; bytes: Buffer; type: string }>,
  projectId: string,
): FormData {
  const fd = new FormData();
  for (const entry of entries) {
    const bytes = new Uint8Array(entry.bytes);
    const file = new File([bytes], entry.name, { type: entry.type });
    fd.append("files", file);
  }
  fd.append("projectId", projectId);
  return fd;
}

function makeRequest(fd: FormData): Request {
  return new Request("http://localhost:3001/api/workspace/upload", {
    method: "POST",
    body: fd,
  });
}

function imageOnlyPdfBytes(): Buffer {
  return Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj\n" +
      "xref\n0 4\n0000000000 65535 f \n" +
      "0000000010 00000 n \n0000000053 00000 n \n0000000093 00000 n \n" +
      "trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF\n",
    "utf8",
  );
}

let fake: FakeGbrainClient;
let brainRoot: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  fake = new FakeGbrainClient();
  brainRoot = await mkdtemp(join(tmpdir(), "scienceswarm-upload-brain-"));
  __setIngestServiceOverride(
    createIngestService({
      gbrain: fake,
      fileStore: createGbrainFileStore({ brainRoot }),
    }),
  );
  vi.stubEnv("SCIENCESWARM_USER_HANDLE", "@scienceswarm-demo");
  process.env.SCIENCESWARM_DIR = "/tmp/scienceswarm-upload-test";
});

afterEach(async () => {
  __setIngestServiceOverride(null);
  await resetBrainStore();
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
  await rm(brainRoot, { recursive: true, force: true });
});

describe("POST /api/workspace/upload", () => {
  it("rejects a request without multipart body", async () => {
    const request = new Request("http://localhost:3001/api/workspace/upload", {
      method: "POST",
      body: JSON.stringify({ foo: "bar" }),
      headers: { "content-type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/multipart|No files/);
  });

  it("rejects a request without a projectId", async () => {
    const fd = new FormData();
    fd.append("files", new File([Buffer.from("hello")], "a.py"));
    const response = await POST(makeRequest(fd));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("projectId");
  });

  it("ingests a text-bearing PDF as a paper", async () => {
    const hubbleBytes = readFileSync(join(FIXTURES, "hubble-1929.pdf"));
    const fd = buildFormData(
      [{ name: "hubble-1929.pdf", bytes: hubbleBytes, type: "application/pdf" }],
      "hubble-demo",
    );
    const response = await POST(makeRequest(fd));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toEqual([]);
    expect(body.slugs).toHaveLength(1);
    const [entry] = body.slugs;
    expect(entry.slug).toBe("hubble-1929");
    expect(entry.type).toBe("paper");
    expect(entry.fileObjectId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry.page_count).toBeGreaterThan(0);
    expect(entry.word_count).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].content).toContain("type: paper");
    expect(fake.calls[0].content).toContain("project: hubble-demo");
    expect(fake.calls[0].content).toContain("source_file_object_id: 'sha256:");
  });

  it("rejects an image-only PDF with text_layer_too_thin and leaves no project-folder orphan", async () => {
    const fd = buildFormData(
      [
        {
          name: "scan-only.pdf",
          bytes: imageOnlyPdfBytes(),
          type: "application/pdf",
        },
      ],
      "scan-demo",
    );
    const response = await POST(makeRequest(fd));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.slugs).toEqual([]);
    expect(body.errors).toHaveLength(1);
    const [err] = body.errors;
    expect(["text_layer_too_thin", "invalid_pdf"]).toContain(err.code);
    expect(err.filename).toBe("scan-only.pdf");
    expect(err.message.length).toBeGreaterThan(10);

    const orphanPath = join(
      process.env.SCIENCESWARM_DIR ?? "",
      "projects/scan-demo/scan-only.pdf",
    );
    expect(existsSync(orphanPath)).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("ingests a CSV as a dataset page using the filename-derived slug", async () => {
    const csv = "seed,color,count\nround,yellow,315\nround,green,101\n";
    const fd = buildFormData(
      [
        {
          name: "mendel-counts.csv",
          bytes: Buffer.from(csv),
          type: "text/csv",
        },
      ],
      "mendel-demo",
    );
    const response = await POST(makeRequest(fd));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toEqual([]);
    expect(body.slugs).toHaveLength(1);
    const [entry] = body.slugs;
    expect(entry.slug).toBe("mendel-counts");
    expect(entry.type).toBe("dataset");
    expect(entry.fileObjectId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry.row_count).toBe(2);
    expect(entry.column_count).toBe(3);
    expect(fake.calls[0].content).toContain("type: dataset");
    expect(fake.calls[0].content).toContain("row_count: 2");
  });

  it("ingests a Python source file as a code page using the filename-derived slug", async () => {
    const fd = buildFormData(
      [
        {
          name: "chisq.py",
          bytes: Buffer.from("import scipy\nprint('hi')\n"),
          type: "text/x-python",
        },
      ],
      "mendel-demo",
    );
    const response = await POST(makeRequest(fd));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toEqual([]);
    const [entry] = body.slugs;
    expect(entry.slug).toBe("chisq");
    expect(entry.type).toBe("code");
    expect(entry.fileObjectId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry.language).toBe("python");
    expect(fake.calls[0].content).toContain("language: python");
    expect(fake.calls[0].content).toContain("```python");
  });

  it("does not collide when two files share a base name across types", async () => {
    const fd = buildFormData(
      [
        {
          name: "analysis.csv",
          bytes: Buffer.from("a,b\n1,2\n"),
          type: "text/csv",
        },
        {
          name: "analysis.py",
          bytes: Buffer.from("print('ok')\n"),
          type: "text/x-python",
        },
      ],
      "demo",
    );
    const response = await POST(makeRequest(fd));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toEqual([]);
    const slugs = body.slugs.map((entry: { slug: string }) => entry.slug);
    expect(slugs).toEqual(["analysis", "analysis-code"]);
    expect(fake.calls.map((call) => call.slug)).toEqual([
      "analysis",
      "analysis-code",
    ]);
  });

  it("rejects an unsupported file type with unsupported_type", async () => {
    const fd = buildFormData(
      [
        {
          name: "image.jpg",
          bytes: Buffer.from("not really an image"),
          type: "image/jpeg",
        },
      ],
      "demo",
    );
    const response = await POST(makeRequest(fd));
    const body = await response.json();
    expect(body.slugs).toEqual([]);
    const [err] = body.errors;
    expect(err.code).toBe("unsupported_type");
  });

  it("mixes successes and failures in a single multi-file upload", async () => {
    const fd = buildFormData(
      [
        {
          name: "chisq.py",
          bytes: Buffer.from("print('ok')\n"),
          type: "text/x-python",
        },
        {
          name: "image.jpg",
          bytes: Buffer.from("bogus"),
          type: "image/jpeg",
        },
      ],
      "demo",
    );
    const response = await POST(makeRequest(fd));
    const body = await response.json();
    expect(body.slugs).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].code).toBe("unsupported_type");
  });

  it("uses the shared in-process gbrain client by default", async () => {
    __setIngestServiceOverride(null);
    await resetBrainStore();

    const root = mkdtempSync(join(tmpdir(), "scienceswarm-upload-real-"));
    process.env.SCIENCESWARM_DIR = join(root, "scienceswarm");
    process.env.BRAIN_ROOT = join(root, "brain");
    process.env.BRAIN_PGLITE_PATH = join(root, "brain", "brain.pglite");

    try {
      const fd = buildFormData(
        [
          {
            name: "chisq.py",
            bytes: Buffer.from("import scipy\nprint('ok')\n"),
            type: "text/x-python",
          },
        ],
        "demo",
      );

      const response = await POST(makeRequest(fd));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.errors).toEqual([]);
      expect(body.slugs.map((entry: { slug: string }) => entry.slug)).toEqual([
        "chisq",
      ]);
      expect(body.slugs[0].fileObjectId).toMatch(/^sha256:[a-f0-9]{64}$/);

      await ensureBrainStoreReady();
      const page = await getBrainStore().getPage("chisq");
      expect(page?.frontmatter.project).toBe("demo");
      expect(page?.frontmatter.type).toBe("code");
      expect(page?.frontmatter.source_file_object_id).toBe(body.slugs[0].fileObjectId);
      expect(page?.content).toContain("```python");
    } finally {
      await resetBrainStore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
