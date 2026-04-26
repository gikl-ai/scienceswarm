import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { execFileSync } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gzipSync } from "zlib";

import {
  ArxivSourceError,
  assertSafeTarListing,
  downloadArxivSource,
  extractArxivSource,
  resetArxivSourceRateLimit,
} from "@/brain/arxiv-source";

// ── Fixtures ─────────────────────────────────────────

let testDir: string;

function tmpPath(rel: string): string {
  return join(testDir, rel);
}

/** Build a real tar.gz on disk from `{relPath: contents}` map. */
function makeTarball(rel: string, files: Record<string, string>): string {
  const stagingDir = tmpPath(`__staging__/${rel.replace(/[^a-zA-Z0-9]/g, "_")}`);
  mkdirSync(stagingDir, { recursive: true });
  for (const [relPath, body] of Object.entries(files)) {
    const dest = join(stagingDir, relPath);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body);
  }
  const archivePath = tmpPath(rel);
  mkdirSync(join(archivePath, ".."), { recursive: true });
  // -czf with -C drops the staging-prefix so entries are relative.
  execFileSync("tar", ["-czf", archivePath, "-C", stagingDir, "."], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return archivePath;
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `arxiv-source-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(testDir, { recursive: true });
  resetArxivSourceRateLimit();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ── extractArxivSource ───────────────────────────────

describe("extractArxivSource", () => {
  it("extracts a tar.gz e-print and discovers .tex / .bbl / .bib", () => {
    const eprint = makeTarball("2309.08600.eprint.bin", {
      "main.tex": "\\documentclass{article}\\begin{document}hi\\end{document}",
      "refs.bib": "@article{x,title={X}}",
      "main.bbl": "\\begin{thebibliography}{1}\\bibitem{x}X.\\end{thebibliography}",
    });
    const dest = tmpPath("out-tarball");

    const result = extractArxivSource("2309.08600", eprint, dest);

    expect(result.kind).toBe("tarball");
    expect(result.arxivId).toBe("2309.08600");
    expect(result.files.tex.map((p) => p.split("/").pop())).toContain("main.tex");
    expect(result.files.bbl.map((p) => p.split("/").pop())).toContain("main.bbl");
    expect(result.files.bib.map((p) => p.split("/").pop())).toContain("refs.bib");
  });

  it("extracts a bare gzipped .tex into <bareId>.tex", () => {
    const tex = "\\documentclass{article}\\begin{document}hi\\end{document}\n";
    const eprint = tmpPath("9999.99999.eprint.bin");
    writeFileSync(eprint, gzipSync(Buffer.from(tex, "utf8")));
    const dest = tmpPath("out-bare-gz");

    const result = extractArxivSource("9999.99999", eprint, dest);

    expect(result.kind).toBe("gzipped-tex");
    expect(result.files.tex).toEqual([join(dest, "9999.99999.tex")]);
    expect(readFileSync(result.files.tex[0], "utf8")).toBe(tex);
    expect(result.files.bbl).toEqual([]);
    expect(result.files.bib).toEqual([]);
  });

  it("rejects a bare PDF e-print with ArxivSourceError", () => {
    const eprint = tmpPath("withheld.eprint.bin");
    writeFileSync(eprint, Buffer.from("%PDF-1.4\n%bytes\n", "ascii"));

    expect(() => extractArxivSource("withheld", eprint, tmpPath("out"))).toThrow(
      ArxivSourceError,
    );
  });

  it("throws when the e-print payload is missing", () => {
    expect(() =>
      extractArxivSource("missing", tmpPath("nope.bin"), tmpPath("out")),
    ).toThrow(ArxivSourceError);
  });

  it("walks nested subdirectories when listing source files", () => {
    const eprint = makeTarball("nested.eprint.bin", {
      "paper/main.tex": "\\documentclass{article}",
      "paper/sections/intro.tex": "intro",
      "paper/bibliography/refs.bib": "@article{a,title={A}}",
    });
    const dest = tmpPath("out-nested");

    const result = extractArxivSource("nested", eprint, dest);

    expect(result.files.tex.length).toBeGreaterThanOrEqual(2);
    expect(result.files.bib.length).toBeGreaterThanOrEqual(1);
  });
});

// ── downloadArxivSource ──────────────────────────────

describe("downloadArxivSource", () => {
  it("rejects an unrecognizable arXiv id without hitting the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadArxivSource("not-an-arxiv-id", tmpPath("nope")),
    ).rejects.toThrow(ArxivSourceError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads, saves, and extracts a tar.gz e-print", async () => {
    // Build a real tar.gz buffer to serve as the fake response body.
    const archivePath = makeTarball("response-staging.tar.gz", {
      "paper.tex": "\\documentclass{article}",
      "paper.bbl": "\\begin{thebibliography}{0}\\end{thebibliography}",
    });
    const archiveBytes = readFileSync(archivePath);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/x-gzip" }),
      arrayBuffer: () =>
        Promise.resolve(
          archiveBytes.buffer.slice(
            archiveBytes.byteOffset,
            archiveBytes.byteOffset + archiveBytes.byteLength,
          ),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const dest = tmpPath("dl-out");
    const result = await downloadArxivSource("2309.08600", dest);

    expect(result.kind).toBe("tarball");
    expect(result.arxivId).toBe("2309.08600");
    expect(result.eprintPath).toBe(join(dest, "2309.08600.eprint.bin"));
    expect(existsSync(result.eprintPath)).toBe(true);
    expect(result.files.tex.length).toBe(1);
    expect(result.files.bbl.length).toBe(1);

    // URL and User-Agent
    expect(fetchMock).toHaveBeenCalledWith(
      "https://arxiv.org/e-print/2309.08600",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("ScienceSwarm"),
        }),
      }),
    );
  });

  it("throws ArxivSourceError on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
      }),
    );

    await expect(
      downloadArxivSource("9999.99999", tmpPath("dl-fail")),
    ).rejects.toThrow(ArxivSourceError);
  });

  it("throws ArxivSourceError on empty payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/x-gzip" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    );

    await expect(
      downloadArxivSource("2309.08600", tmpPath("dl-empty")),
    ).rejects.toThrow(/empty/i);
  });

  it("returns cached extraction without re-downloading when payload exists", async () => {
    // Pre-seed a cached tar.gz
    const archivePath = makeTarball("response-staging-2.tar.gz", {
      "cached.tex": "\\documentclass{article}",
    });
    const archiveBytes = readFileSync(archivePath);

    const dest = tmpPath("dl-cached");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "2309.08600.eprint.bin"), archiveBytes);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadArxivSource("2309.08600", dest);
    expect(result.kind).toBe("tarball");
    expect(result.files.tex.length).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("strips a vN suffix when naming the cached payload", async () => {
    const archivePath = makeTarball("response-staging-3.tar.gz", {
      "v.tex": "\\documentclass{article}",
    });
    const archiveBytes = readFileSync(archivePath);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/x-gzip" }),
      arrayBuffer: () =>
        Promise.resolve(
          archiveBytes.buffer.slice(
            archiveBytes.byteOffset,
            archiveBytes.byteOffset + archiveBytes.byteLength,
          ),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    const dest = tmpPath("dl-versioned");
    const result = await downloadArxivSource("2309.08600v2", dest);
    expect(result.arxivId).toBe("2309.08600");
    expect(result.eprintPath).toBe(join(dest, "2309.08600.eprint.bin"));
  });
});

// ── ArxivSourceError ─────────────────────────────────

describe("ArxivSourceError", () => {
  it("carries arxivId and optional httpStatus", () => {
    const err = new ArxivSourceError("nope", "2309.08600", 503);
    expect(err.name).toBe("ArxivSourceError");
    expect(err.arxivId).toBe("2309.08600");
    expect(err.httpStatus).toBe(503);
    expect(err.message).toBe("nope");
  });
});

// ── assertSafeTarListing ─────────────────────────────

describe("assertSafeTarListing", () => {
  it("accepts a clean listing", () => {
    expect(() =>
      assertSafeTarListing("paper.tex\nrefs.bib\nfigures/fig1.pdf\n"),
    ).not.toThrow();
  });

  it("rejects an absolute path entry", () => {
    expect(() =>
      assertSafeTarListing("paper.tex\n/etc/passwd_x\n"),
    ).toThrow(/suspect path/i);
  });

  it("rejects a parent-relative entry", () => {
    expect(() =>
      assertSafeTarListing("paper.tex\n../escape.tex\n"),
    ).toThrow(/suspect path/i);
  });

  it("rejects a `..` segment in the middle of a path", () => {
    expect(() =>
      assertSafeTarListing("paper/sub/../../../escape.tex\n"),
    ).toThrow(/suspect path/i);
  });

  it("ignores blank lines", () => {
    expect(() =>
      assertSafeTarListing("\npaper.tex\n\nrefs.bib\n\n"),
    ).not.toThrow();
  });
});
