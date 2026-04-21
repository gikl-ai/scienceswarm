import path from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractTodosFromText,
  scanProjectTodos,
} from "@/lib/md-todo-extractor";

describe("extractTodosFromText", () => {
  it("finds an unchecked task", () => {
    const todos = extractTodosFromText("- [ ] task one\n", "a.md");
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      file: "a.md",
      line: 1,
      text: "task one",
      done: false,
    });
  });

  it("finds a checked task", () => {
    const todos = extractTodosFromText("- [x] done task\n", "a.md");
    expect(todos).toHaveLength(1);
    expect(todos[0].done).toBe(true);
    expect(todos[0].text).toBe("done task");
  });

  it("handles uppercase X as done", () => {
    const todos = extractTodosFromText("- [X] capital done\n", "a.md");
    expect(todos).toHaveLength(1);
    expect(todos[0].done).toBe(true);
    expect(todos[0].text).toBe("capital done");
  });

  it("handles asterisk bullet style", () => {
    const todos = extractTodosFromText("* [ ] asterisk todo\n", "a.md");
    expect(todos).toHaveLength(1);
    expect(todos[0].done).toBe(false);
    expect(todos[0].text).toBe("asterisk todo");
  });

  it("handles plus bullet style (GFM)", () => {
    const todos = extractTodosFromText("+ [ ] plus todo\n", "a.md");
    expect(todos).toHaveLength(1);
    expect(todos[0].done).toBe(false);
    expect(todos[0].text).toBe("plus todo");
  });

  it("ignores non-checkbox bracket content like [y]", () => {
    const todos = extractTodosFromText("- [y] not a checkbox\n", "a.md");
    expect(todos).toHaveLength(0);
  });

  it("produces 1-indexed line numbers", () => {
    const text = ["# heading", "", "- [ ] third line todo"].join("\n");
    const todos = extractTodosFromText(text, "a.md");
    expect(todos).toHaveLength(1);
    expect(todos[0].line).toBe(3);
  });

  it("returns multiple todos in source order", () => {
    const text = [
      "- [ ] first",
      "some prose",
      "- [x] second",
      "- [ ] third",
    ].join("\n");
    const todos = extractTodosFromText(text, "a.md");
    expect(todos.map((t) => t.text)).toEqual(["first", "second", "third"]);
    expect(todos.map((t) => t.line)).toEqual([1, 3, 4]);
    expect(todos.map((t) => t.done)).toEqual([false, true, false]);
  });

  it("trims trailing whitespace from todo text", () => {
    const todos = extractTodosFromText("- [ ] trailing   \n", "a.md");
    expect(todos[0].text).toBe("trailing");
  });
});

describe("scanProjectTodos", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "md-todo-extractor-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("walks a seeded directory with 3 .md files", async () => {
    writeFileSync(
      path.join(tmpRoot, "a.md"),
      "- [ ] alpha\n- [x] beta\n",
    );
    mkdirSync(path.join(tmpRoot, "nested"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "nested", "b.md"),
      "# heading\n- [ ] gamma\n",
    );
    // Third file has no todos — still counted in scannedFiles.
    writeFileSync(
      path.join(tmpRoot, "empty.md"),
      "just some prose, no checkboxes\n",
    );

    const result = await scanProjectTodos(tmpRoot);

    expect(result.scannedFiles).toBe(3);
    expect(result.todos).toHaveLength(3);

    const texts = result.todos.map((t) => t.text).sort();
    expect(texts).toEqual(["alpha", "beta", "gamma"]);

    const nestedTodo = result.todos.find((t) => t.text === "gamma");
    expect(nestedTodo?.file).toBe("nested/b.md");
    expect(nestedTodo?.line).toBe(2);

    expect(typeof result.scannedAt).toBe("string");
    expect(Number.isFinite(Date.parse(result.scannedAt))).toBe(true);
  });

  it("returns an empty result when the root does not exist", async () => {
    const missing = path.join(tmpRoot, "does", "not", "exist");
    const result = await scanProjectTodos(missing);
    expect(result.todos).toEqual([]);
    expect(result.scannedFiles).toBe(0);
    expect(typeof result.scannedAt).toBe("string");
  });

  it("skips .md files inside .claude subfolders", async () => {
    writeFileSync(path.join(tmpRoot, "root.md"), "- [ ] kept\n");
    mkdirSync(path.join(tmpRoot, ".claude", "notes"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, ".claude", "notes", "hidden.md"),
      "- [ ] should not appear\n",
    );

    const result = await scanProjectTodos(tmpRoot);

    expect(result.scannedFiles).toBe(1);
    expect(result.todos).toHaveLength(1);
    expect(result.todos[0].text).toBe("kept");
  });

  it("skips node_modules subtrees", async () => {
    writeFileSync(path.join(tmpRoot, "real.md"), "- [ ] real\n");
    mkdirSync(path.join(tmpRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "node_modules", "pkg", "README.md"),
      "- [ ] should not appear\n",
    );

    const result = await scanProjectTodos(tmpRoot);
    expect(result.scannedFiles).toBe(1);
    expect(result.todos.map((t) => t.text)).toEqual(["real"]);
  });

  it("rejects symlinks whose targets escape the project root", async () => {
    // Create a sibling directory outside the project root with a markdown
    // file, then add a symlink inside the project that points at it. The
    // scanner must refuse to follow the link and must not leak the outside
    // file's todos via the project API.
    const outside = mkdtempSync(path.join(tmpdir(), "md-todo-outside-"));
    try {
      writeFileSync(
        path.join(outside, "secret.md"),
        "- [ ] leaked secret\n",
      );

      writeFileSync(path.join(tmpRoot, "real.md"), "- [ ] real\n");
      symlinkSync(outside, path.join(tmpRoot, "escape-link"));

      const result = await scanProjectTodos(tmpRoot);

      expect(result.scannedFiles).toBe(1);
      expect(result.todos.map((t) => t.text)).toEqual(["real"]);
      for (const todo of result.todos) {
        expect(todo.text).not.toContain("leaked");
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
