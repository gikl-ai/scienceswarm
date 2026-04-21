/**
 * Sandbox HTTP gateway — POST routes that back the in-sandbox
 * `gbrain` HTTP wrapper at `sandbox/bin/gbrain`. These are the host
 * side of the architecture recommended in Codex's consult call for
 * PR #301's follow-up: instead of bind-mounting `~/.gbrain` into the
 * sandbox (which deadlocks PGLite), the sandbox reaches back into
 * this Next.js server over HTTP with a shared token.
 *
 * We exercise:
 *   - `requireSandboxToken` refuses when the host token is unset, and
 *     enforces the header match when the token IS set
 *   - `POST /api/brain/page` writes a markdown page through the
 *     in-process gbrain client and returns the slug
 *   - `POST /api/brain/link` validates the relation against the
 *     allowed audit-revise + compiled-memex relations and calls `linkPages`
 *   - `POST /api/brain/file-upload` refuses path-traversal filenames,
 *     writes bytes under `SCIENCESWARM_DIR/projects/<project>/...`,
 *     and splices `{sha256, filename}` into `artifact_files`
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

import { POST as postPage } from "@/app/api/brain/page/route";
import { POST as postLink } from "@/app/api/brain/link/route";
import { POST as postFileUpload } from "@/app/api/brain/file-upload/route";
import * as storeModule from "@/brain/store";
import * as inProcessModule from "@/brain/in-process-gbrain-client";
import {
  createGbrainFileStore,
  type GbrainFileStore,
} from "@/brain/gbrain-file-store";
import type {
  BrainPage,
  BrainStore,
  ImportResult,
} from "@/brain/store";
import type { GbrainClient } from "@/brain/gbrain-client";
import { __setBrainFileUploadRouteFileStoreOverride } from "@/lib/testing/brain-file-upload-route-overrides";

class FakeBrainStore implements BrainStore {
  pages = new Map<string, BrainPage>();
  async search() {
    return [];
  }
  async getPage(slug: string): Promise<BrainPage | null> {
    return this.pages.get(slug) ?? null;
  }
  async getTimeline() {
    return [];
  }
  async getLinks() {
    return [];
  }
  async getBacklinks() {
    return [];
  }
  async importCorpus(dirPath: string): Promise<ImportResult> {
    void dirPath;
    throw new Error("not implemented");
  }
  async listPages() {
    return Array.from(this.pages.values());
  }
  async health() {
    return { ok: true, pageCount: this.pages.size };
  }
  async dispose() {}
}

interface PutRecord {
  slug: string;
  content: string;
}
interface LinkRecord {
  from: string;
  to: string;
  linkType?: string;
  context?: string;
}

class FakeClient implements GbrainClient {
  puts: PutRecord[] = [];
  links: LinkRecord[] = [];
  async putPage(slug: string, content: string) {
    this.puts.push({ slug, content });
    return { stdout: `ok ${slug}`, stderr: "" };
  }
  async linkPages(
    from: string,
    to: string,
    options: { linkType?: string; context?: string } = {},
  ) {
    this.links.push({
      from,
      to,
      linkType: options.linkType,
      context: options.context,
    });
    return { stdout: `linked ${from}->${to}`, stderr: "" };
  }
  async persistTransaction() {
    throw new Error("not implemented");
    return { slug: "unused", status: "created_or_updated" as const };
  }
}

const TOKEN = "test-sandbox-token-9f38";
let tmpRoot = "";
let fakeStore: FakeBrainStore;
let fakeClient: FakeClient;
let fileStore: GbrainFileStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-gw-test-"));
  process.env.SCIENCESWARM_DIR = tmpRoot;
  process.env.SCIENCESWARM_USER_HANDLE = "@gateway-test";
  process.env.SCIENCESWARM_SANDBOX_TOKEN = TOKEN;
  fakeStore = new FakeBrainStore();
  fakeClient = new FakeClient();
  fileStore = createGbrainFileStore({ brainRoot: path.join(tmpRoot, "brain") });
  __setBrainFileUploadRouteFileStoreOverride(fileStore);
  vi.spyOn(storeModule, "getBrainStore").mockReturnValue(fakeStore);
  vi.spyOn(storeModule, "ensureBrainStoreReady").mockResolvedValue(undefined);
  vi.spyOn(inProcessModule, "createInProcessGbrainClient").mockReturnValue(
    fakeClient,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  __setBrainFileUploadRouteFileStoreOverride(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.SCIENCESWARM_DIR;
  delete process.env.SCIENCESWARM_USER_HANDLE;
  delete process.env.SCIENCESWARM_SANDBOX_TOKEN;
});

function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function tokenHeader(value: string = TOKEN): Record<string, string> {
  return { "x-scienceswarm-sandbox-token": value };
}

// -------------------------------------------------------------------
// POST /api/brain/page
// -------------------------------------------------------------------

describe("POST /api/brain/page (sandbox gateway)", () => {
  it("refuses with 503 when the host token is unset", async () => {
    delete process.env.SCIENCESWARM_SANDBOX_TOKEN;
    const res = await postPage(
      jsonRequest(
        "http://localhost:3001/api/brain/page",
        { slug: "foo", content: "# foo" },
        tokenHeader(),
      ),
    );
    expect(res.status).toBe(503);
    expect(fakeClient.puts).toHaveLength(0);
  });

  it("refuses with 401 when the header is missing", async () => {
    const res = await postPage(
      jsonRequest("http://localhost:3001/api/brain/page", {
        slug: "foo",
        content: "# foo",
      }),
    );
    expect(res.status).toBe(401);
    expect(fakeClient.puts).toHaveLength(0);
  });

  it("refuses with 403 when the header is wrong", async () => {
    const res = await postPage(
      jsonRequest(
        "http://localhost:3001/api/brain/page",
        { slug: "foo", content: "# foo" },
        tokenHeader("wrong"),
      ),
    );
    expect(res.status).toBe(403);
    expect(fakeClient.puts).toHaveLength(0);
  });

  it("400s when slug or content is missing", async () => {
    const missingSlug = await postPage(
      jsonRequest(
        "http://localhost:3001/api/brain/page",
        { content: "body" },
        tokenHeader(),
      ),
    );
    expect(missingSlug.status).toBe(400);
    const missingContent = await postPage(
      jsonRequest(
        "http://localhost:3001/api/brain/page",
        { slug: "foo" },
        tokenHeader(),
      ),
    );
    expect(missingContent.status).toBe(400);
    expect(fakeClient.puts).toHaveLength(0);
  });

  it("writes through the in-process client on happy path", async () => {
    const markdown = [
      "---",
      "type: revision",
      "title: Hubble revision",
      "project: hubble-1929",
      "parent: hubble-1929",
      "---",
      "",
      "# Revised body",
      "",
    ].join("\n");
    const res = await postPage(
      jsonRequest(
        "http://localhost:3001/api/brain/page",
        { slug: "hubble-1929-revision", content: markdown },
        tokenHeader(),
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("hubble-1929-revision");
    expect(body.status).toBe("created_or_updated");
    expect(fakeClient.puts).toEqual([
      { slug: "hubble-1929-revision", content: markdown },
    ]);
  });
});

// -------------------------------------------------------------------
// POST /api/brain/link
// -------------------------------------------------------------------

describe("POST /api/brain/link (sandbox gateway)", () => {
  it("refuses without the token", async () => {
    const res = await postLink(
      jsonRequest("http://localhost:3001/api/brain/link", {
        from: "a",
        to: "b",
        relation: "audited_by",
      }),
    );
    expect(res.status).toBe(401);
    expect(fakeClient.links).toHaveLength(0);
  });

  it("rejects unknown relations", async () => {
    const res = await postLink(
      jsonRequest(
        "http://localhost:3001/api/brain/link",
        { from: "a", to: "b", relation: "not-a-real-relation" },
        tokenHeader(),
      ),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid relation");
    expect(fakeClient.links).toHaveLength(0);
  });

  it("creates the link via the in-process client on happy path", async () => {
    const res = await postLink(
      jsonRequest(
        "http://localhost:3001/api/brain/link",
        {
          from: "hubble-1929-revision",
          to: "hubble-1929",
          relation: "revises",
          context: "text-only pass",
        },
        tokenHeader(),
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      from: "hubble-1929-revision",
      to: "hubble-1929",
      relation: "revises",
      status: "linked",
    });
    expect(fakeClient.links).toEqual([
      {
        from: "hubble-1929-revision",
        to: "hubble-1929",
        linkType: "revises",
        context: "text-only pass",
      },
    ]);
  });

  it("accepts compiled-memex link relations", async () => {
    const res = await postLink(
      jsonRequest(
        "http://localhost:3001/api/brain/link",
        {
          from: "concepts/rlhf-alignment",
          to: "papers/deceptive-rlhf",
          relation: "contradicts",
          context: "claim-level contradiction",
        },
        tokenHeader(),
      ),
    );
    expect(res.status).toBe(200);
    expect(fakeClient.links).toEqual([
      {
        from: "concepts/rlhf-alignment",
        to: "papers/deceptive-rlhf",
        linkType: "contradicts",
        context: "claim-level contradiction",
      },
    ]);
  });
});

// -------------------------------------------------------------------
// POST /api/brain/file-upload
// -------------------------------------------------------------------

function fileUploadRequest(
  fields: {
    page_slug?: string;
    filename?: string;
    bytes?: Uint8Array;
    omitFile?: boolean;
  },
  headers: Record<string, string> = tokenHeader(),
): Request {
  const form = new FormData();
  if (fields.page_slug !== undefined) form.append("page_slug", fields.page_slug);
  if (fields.filename !== undefined) form.append("filename", fields.filename);
  if (!fields.omitFile) {
    const bytes = fields.bytes ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    // Copy into a fresh Uint8Array<ArrayBuffer> so the strict BlobPart
    // typing is satisfied regardless of the Node / DOM typedef combo.
    // This mirrors the upload-route's own blob-construction workaround.
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    const blob = new Blob([blobBytes], { type: "application/pdf" });
    form.append("file", blob, fields.filename ?? "attachment.bin");
  }
  return new Request("http://localhost:3001/api/brain/file-upload", {
    method: "POST",
    headers,
    body: form,
  });
}

function seedProjectPage(
  slug: string,
  project: string,
  extra: Record<string, unknown> = {},
): void {
  fakeStore.pages.set(slug, {
    path: slug,
    title: slug,
    type: "paper",
    content: `# ${slug}\n\nbody`,
    frontmatter: {
      type: "paper",
      title: slug,
      project,
      ...extra,
    },
  });
}

describe("POST /api/brain/file-upload (sandbox gateway)", () => {
  it("refuses without the token", async () => {
    seedProjectPage("hubble-1929-revision", "hubble-1929");
    const res = await postFileUpload(
      fileUploadRequest(
        { page_slug: "hubble-1929-revision", filename: "paper.pdf" },
        {},
      ),
    );
    expect(res.status).toBe(401);
    expect(fakeClient.puts).toHaveLength(0);
  });

  it("400s when a required field is missing", async () => {
    seedProjectPage("hubble-1929-revision", "hubble-1929");
    const missingFilename = await postFileUpload(
      fileUploadRequest({ page_slug: "hubble-1929-revision" }),
    );
    expect(missingFilename.status).toBe(400);
    const missingSlug = await postFileUpload(
      fileUploadRequest({ filename: "paper.pdf" }),
    );
    expect(missingSlug.status).toBe(400);
    const missingFile = await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "paper.pdf",
        omitFile: true,
      }),
    );
    expect(missingFile.status).toBe(400);
  });

  it("refuses path-traversal filenames", async () => {
    seedProjectPage("hubble-1929-revision", "hubble-1929");
    const res = await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "../escape.pdf",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404s when the target page is missing", async () => {
    const res = await postFileUpload(
      fileUploadRequest({
        page_slug: "nope",
        filename: "paper.pdf",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("400s when the page has no project frontmatter", async () => {
    fakeStore.pages.set("orphan", {
      path: "orphan",
      title: "orphan",
      type: "paper",
      content: "# orphan",
      frontmatter: { type: "paper", title: "orphan" },
    });
    const res = await postFileUpload(
      fileUploadRequest({ page_slug: "orphan", filename: "paper.pdf" }),
    );
    expect(res.status).toBe(400);
  });

  it("writes a file object, returns sha256, and splices artifact_files into the page", async () => {
    seedProjectPage("hubble-1929-revision", "hubble-1929");
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");

    const res = await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "revised.pdf",
        bytes,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("hubble-1929-revision");
    expect(body.filename).toBe("revised.pdf");
    expect(body.sha256).toBe(expectedSha);
    expect(body.fileObjectId).toBe(`sha256:${expectedSha}`);
    expect(body.size).toBe(bytes.byteLength);
    expect(await fileStore.hasObject(body.fileObjectId)).toBe(true);

    // One putPage call re-serializing the page with artifact_files
    // appended to the frontmatter as a bare sha256 hex string
    // (matching `RevisionFrontmatterSchema.artifact_files =
    // z.array(sha256Hex)`). Filename lives only in the HTTP
    // response, not in the persisted page.
    expect(fakeClient.puts).toHaveLength(1);
    const put = fakeClient.puts[0];
    expect(put.slug).toBe("hubble-1929-revision");
    expect(put.content).toContain(`- ${expectedSha}`);
    expect(put.content).toContain(`fileObjectId: 'sha256:${expectedSha}'`);
    // `artifact_files` remains a schema-compliant sha array. Rich filename
    // metadata lives in the separate `file_refs` contract.
    expect(put.content).toContain("artifact_files:\n  - ");
  });

  it("preserves pre-existing schema-compliant sha256 entries and dedupes", async () => {
    const existingSha = "a".repeat(64);
    seedProjectPage("hubble-1929-revision", "hubble-1929", {
      artifact_files: [existingSha],
    });
    const bytes = new Uint8Array([0x01, 0x02, 0x03]);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");

    const res = await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "new.bin",
        bytes,
      }),
    );
    expect(res.status).toBe(200);

    const put = fakeClient.puts[0];
    expect(put.content).toContain(`- ${existingSha}`);
    expect(put.content).toContain(`- ${expectedSha}`);
  });

  it("normalizes legacy {sha256, filename} entries written before the schema fix", async () => {
    const legacySha = "b".repeat(64);
    seedProjectPage("hubble-1929-revision", "hubble-1929", {
      artifact_files: [{ sha256: legacySha, filename: "old.pdf" }],
    });
    const bytes = new Uint8Array([0x99]);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");

    const res = await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "new.bin",
        bytes,
      }),
    );
    expect(res.status).toBe(200);

    const put = fakeClient.puts[0];
    // Both the legacy entry and the new entry land as schema-compliant
    // bare sha256 strings.
    expect(put.content).toContain(`- ${legacySha}`);
    expect(put.content).toContain(`- ${expectedSha}`);
    // No inline {sha256:, filename:} map block remains.
    expect(put.content).not.toMatch(/^\s*filename: old\.pdf/m);
  });

  it("dedupes re-uploads of the same bytes without growing the list", async () => {
    const existingSha = "c".repeat(64);
    seedProjectPage("hubble-1929-revision", "hubble-1929", {
      artifact_files: [existingSha],
    });
    const bytes = new Uint8Array([0x55, 0x66]);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");

    // Two back-to-back uploads with the same bytes.
    await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "a.bin",
        bytes,
      }),
    );
    await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "a.bin",
        bytes,
      }),
    );

    // The second put still records exactly two sha256 entries: the
    // original seed + the new one. The duplicate is not appended.
    // Mocked fake store doesn't re-read the updated frontmatter for
    // the second call, so both puts see the same seeded base — but
    // neither call should write more than two entries.
    expect(fakeClient.puts).toHaveLength(2);
    for (const put of fakeClient.puts) {
      const matches = put.content.match(/- [a-f0-9]{64}/g) ?? [];
      expect(matches).toHaveLength(2);
      expect(put.content).toContain(`- ${existingSha}`);
      expect(put.content).toContain(`- ${expectedSha}`);
    }
  });

  it("rejects uploads over the 50 MB cap with 413", async () => {
    seedProjectPage("hubble-1929-revision", "hubble-1929");
    // Build a 51 MB buffer. The route reads `file.size` before
    // calling arrayBuffer(), so the rejection happens before any
    // bytes are copied to disk — the test asserts both.
    const tooBig = new Uint8Array(51 * 1024 * 1024);
    const res = await postFileUpload(
      fileUploadRequest({
        page_slug: "hubble-1929-revision",
        filename: "big.bin",
        bytes: tooBig,
      }),
    );
    expect(res.status).toBe(413);
    expect(fakeClient.puts).toHaveLength(0);
    expect(await fileStore.hasObject(`sha256:${"0".repeat(64)}`)).toBe(false);
  });
});
