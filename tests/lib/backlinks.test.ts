import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBacklinkGraph, extractWikiLinksFromText } from "@/lib/backlinks";

const ROOT = path.join(tmpdir(), "scienceswarm-backlinks-unit");

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("extractWikiLinksFromText", () => {
  it("extracts a single [[target]] link", () => {
    const links = extractWikiLinksFromText("See [[Other Note]] for more.", "a.md");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      src: "a.md",
      target: "Other Note",
      line: 1,
    });
    expect(links[0].alias).toBeUndefined();
  });

  it("extracts an aliased [[target|alias]] link", () => {
    const links = extractWikiLinksFromText("Go to [[target|Nice label]] now.", "a.md");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      src: "a.md",
      target: "target",
      alias: "Nice label",
      line: 1,
    });
  });

  it("captures multiple links on the same line", () => {
    const links = extractWikiLinksFromText(
      "Both [[first]] and [[second|Second!]] appear here.",
      "a.md",
    );
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.target)).toEqual(["first", "second"]);
    expect(links[1].alias).toBe("Second!");
  });

  it("uses 1-indexed line numbers", () => {
    const text = "line one\nline two has [[target]]\nline three";
    const links = extractWikiLinksFromText(text, "a.md");
    expect(links).toHaveLength(1);
    expect(links[0].line).toBe(2);
  });

  it("ignores links inside fenced code blocks", () => {
    const text = [
      "Real link: [[real]]",
      "```",
      "Fake link: [[fake]]",
      "More code: [[also-fake|nope]]",
      "```",
      "Another real: [[also-real]]",
    ].join("\n");

    const links = extractWikiLinksFromText(text, "a.md");
    expect(links.map((l) => l.target)).toEqual(["real", "also-real"]);
  });

  it("handles a text with no wiki links", () => {
    const links = extractWikiLinksFromText("just some markdown, no links\n", "a.md");
    expect(links).toEqual([]);
  });
});

describe("buildBacklinkGraph", () => {
  it("builds correct forward + backward maps across 3 interlinked files", async () => {
    writeFileSync(path.join(ROOT, "alpha.md"), "Link to [[beta]] and [[gamma]].");
    writeFileSync(path.join(ROOT, "beta.md"), "Back to [[alpha]].");
    writeFileSync(path.join(ROOT, "gamma.md"), "Also [[alpha]] and [[beta]].");

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.scannedFiles).toBe(3);
    expect(graph.forward["alpha.md"]).toEqual(["beta", "gamma"]);
    expect(graph.forward["beta.md"]).toEqual(["alpha"]);
    expect(graph.forward["gamma.md"]).toEqual(["alpha", "beta"]);

    expect(graph.backward["alpha"]?.sort()).toEqual(["beta.md", "gamma.md"].sort());
    expect(graph.backward["beta"]?.sort()).toEqual(["alpha.md", "gamma.md"].sort());
    expect(graph.backward["gamma"]).toEqual(["alpha.md"]);

    expect(graph.brokenLinks).toEqual([]);
  });

  it("collects broken links into brokenLinks and does not add them to backward", async () => {
    writeFileSync(path.join(ROOT, "page.md"), "Goes to [[nowhere]].");

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.forward["page.md"]).toEqual(["nowhere"]);
    expect(graph.backward["nowhere"]).toBeUndefined();
    expect(graph.brokenLinks).toHaveLength(1);
    expect(graph.brokenLinks[0]).toMatchObject({
      src: "page.md",
      target: "nowhere",
      line: 1,
    });
  });

  it("resolves targets case-insensitively against basenames", async () => {
    writeFileSync(path.join(ROOT, "My-Note.md"), "content");
    writeFileSync(path.join(ROOT, "other.md"), "See [[my-note]] here.");

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.brokenLinks).toEqual([]);
    expect(graph.backward["my-note"]).toEqual(["other.md"]);
  });

  it("normalizes backward keys across case variants", async () => {
    writeFileSync(path.join(ROOT, "My-Note.md"), "content");
    writeFileSync(path.join(ROOT, "first.md"), "See [[My-Note]].");
    writeFileSync(path.join(ROOT, "second.md"), "See [[my-note]].");

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.backward["my-note"]?.sort()).toEqual(["first.md", "second.md"]);
    expect(graph.backward["My-Note"]).toBeUndefined();
  });

  it("does not duplicate entries in forward[src] when a source links to the same target twice", async () => {
    writeFileSync(path.join(ROOT, "target.md"), "hi");
    writeFileSync(
      path.join(ROOT, "src.md"),
      "First [[target]] and again [[target]] and once more [[target|alias]].",
    );

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.forward["src.md"]).toEqual(["target"]);
    expect(graph.backward["target"]).toEqual(["src.md"]);
  });

  it("returns an empty graph when root does not exist", async () => {
    const missing = path.join(ROOT, "does-not-exist");
    const graph = await buildBacklinkGraph(missing);

    expect(graph.scannedFiles).toBe(0);
    expect(graph.forward).toEqual({});
    expect(graph.backward).toEqual({});
    expect(graph.brokenLinks).toEqual([]);
    expect(typeof graph.scannedAt).toBe("string");
  });

  it("recursively walks subdirectories and skips dotfiles / node_modules / .claude", async () => {
    mkdirSync(path.join(ROOT, "nested"), { recursive: true });
    mkdirSync(path.join(ROOT, "node_modules"), { recursive: true });
    mkdirSync(path.join(ROOT, ".claude"), { recursive: true });
    mkdirSync(path.join(ROOT, ".hidden"), { recursive: true });

    writeFileSync(path.join(ROOT, "top.md"), "Link to [[deep]].");
    writeFileSync(path.join(ROOT, "nested", "deep.md"), "Link to [[top]].");
    writeFileSync(path.join(ROOT, "node_modules", "skip.md"), "[[top]]");
    writeFileSync(path.join(ROOT, ".claude", "skip.md"), "[[top]]");
    writeFileSync(path.join(ROOT, ".hidden", "skip.md"), "[[top]]");

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.scannedFiles).toBe(2);
    // backward[top] must only reference nested/deep.md, not the skipped dirs.
    expect(graph.backward["top"]).toEqual([path.join("nested", "deep.md")]);
    expect(graph.backward["nested/deep"]).toEqual(["top.md"]);
  });

  it("ignores links inside fenced code blocks when walking the corpus", async () => {
    writeFileSync(path.join(ROOT, "target.md"), "hi");
    writeFileSync(
      path.join(ROOT, "page.md"),
      ["Real: [[target]]", "```", "Fake: [[target]]", "```"].join("\n"),
    );

    const graph = await buildBacklinkGraph(ROOT);

    // Only one unique link target even though the regex would match twice.
    expect(graph.forward["page.md"]).toEqual(["target"]);
    // And backward should only see page.md once, not twice.
    expect(graph.backward["target"]).toEqual(["page.md"]);
  });

  it("resolves slash-containing targets against relative paths on disk", async () => {
    mkdirSync(path.join(ROOT, "sub"), { recursive: true });
    writeFileSync(path.join(ROOT, "sub", "leaf.md"), "leaf content");
    writeFileSync(path.join(ROOT, "root.md"), "See [[sub/leaf]].");

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.brokenLinks).toEqual([]);
    expect(graph.backward["sub/leaf"]).toEqual(["root.md"]);
  });

  it("does not resolve path-style links that escape the scan root", async () => {
    writeFileSync(path.join(ROOT, "inside.md"), "Looks at [[../outside]].");
    writeFileSync(path.join(path.dirname(ROOT), "outside.md"), "outside");

    const graph = await buildBacklinkGraph(ROOT);

    expect(graph.backward["../outside"]).toBeUndefined();
    expect(graph.brokenLinks).toHaveLength(1);
    expect(graph.brokenLinks[0].target).toBe("../outside");
  });
});
