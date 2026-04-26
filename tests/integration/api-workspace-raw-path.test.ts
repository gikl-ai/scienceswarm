import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/brain/store", () => ({
  ensureBrainStoreReady: vi.fn(async () => {}),
  getBrainStore: vi.fn(() => ({
    listPages: vi.fn(async () => []),
    getPage: vi.fn(async () => null),
  })),
}));

const ROOT = path.join(tmpdir(), "scienceswarm-api-workspace-raw-path");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = ROOT;
  vi.resetModules();
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  if (ORIGINAL_SCIENCESWARM_DIR !== undefined) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
  vi.restoreAllMocks();
});

async function importRawPathRoute() {
  return await import("@/app/api/workspace/raw/[projectId]/[...file]/route");
}

function rawParams(projectId: string, file: string[]) {
  return { params: Promise.resolve({ projectId, file }) };
}

describe("GET /api/workspace/raw/[projectId]/[...file]", () => {
  it("serves sandboxed html previews with sibling JS and CSS assets", async () => {
    const projectId = "test-project";
    const snakeDir = path.join(ROOT, "projects", projectId, "figures", "snake-game");
    mkdirSync(snakeDir, { recursive: true });
    writeFileSync(
      path.join(snakeDir, "index.html"),
      "<!doctype html><title>Snake</title><link\nrel=stylesheet\nmedia=print\nhref=./style.css><script\nsrc=./game.js></script foo=\"bar\">",
    );
    writeFileSync(path.join(snakeDir, "style.css"), "body { background: black; color: white; }");
    writeFileSync(path.join(snakeDir, "game.js"), "globalThis.snakeLoaded = true;");

    const { GET } = await importRawPathRoute();
    const htmlRes = await GET(
      new Request(`http://localhost/api/workspace/raw/${projectId}/figures/snake-game/index.html`),
      rawParams(projectId, ["figures", "snake-game", "index.html"]),
    );

    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(htmlRes.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(htmlRes.headers.get("Content-Security-Policy")).toContain("style-src 'self'");
    expect(htmlRes.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    const html = await htmlRes.text();
    expect(html).toContain("data-scienceswarm-inlined-asset=\"./game.js\"");
    expect(html).toContain("globalThis.snakeLoaded = true;");
    expect(html).toContain("data-scienceswarm-inlined-asset=\"./style.css\"");
    expect(html).toContain("<style media=\"print\"");
    expect(html).toContain("body { background: black; color: white; }");
    expect(html).toContain("data-scienceswarm-html-preview-shim");

    const scriptRes = await GET(
      new Request(`http://localhost/api/workspace/raw/${projectId}/figures/snake-game/game.js`),
      rawParams(projectId, ["figures", "snake-game", "game.js"]),
    );

    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    await expect(scriptRes.text()).resolves.toContain("snakeLoaded");

    const styleRes = await GET(
      new Request(`http://localhost/api/workspace/raw/${projectId}/figures/snake-game/style.css`),
      rawParams(projectId, ["figures", "snake-game", "style.css"]),
    );

    expect(styleRes.status).toBe(200);
    expect(styleRes.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    await expect(styleRes.text()).resolves.toContain("background: black");
  });

  it("rejects traversal attempts via the path-based endpoint", async () => {
    const { GET } = await importRawPathRoute();
    const res = await GET(
      new Request("http://localhost/api/workspace/raw/test-project/../../etc/passwd"),
      rawParams("test-project", ["..", "..", "etc", "passwd"]),
    );

    expect(res.status).toBe(400);
    await expect(res.text()).resolves.toBe("Invalid file path");
  });
});
