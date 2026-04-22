import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { interpretMultimodalResultPacket } from "@/brain/multimodal-result-interpreter";

const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

afterEach(() => {
  if (ORIGINAL_SCIENCESWARM_DIR === undefined) {
    delete process.env.SCIENCESWARM_DIR;
  } else {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  }
});

describe("interpretMultimodalResultPacket", () => {
  it("ignores internal project bookkeeping files and preserves binary inputs honestly", async () => {
    const scienceswarmDir = await mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-multimodal-"),
    );
    process.env.SCIENCESWARM_DIR = scienceswarmDir;

    const projectRoot = path.join(scienceswarmDir, "projects", "packet-alpha");
    await mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await mkdir(path.join(projectRoot, "data"), { recursive: true });
    await mkdir(path.join(projectRoot, "figures"), { recursive: true });
    await mkdir(path.join(projectRoot, ".brain", "state"), { recursive: true });

    await writeFile(
      path.join(projectRoot, "docs", "oncology_note.txt"),
      "Residual cells regained sensitivity after washout.\n",
      "utf-8",
    );
    await writeFile(
      path.join(projectRoot, "data", "viability_table.csv"),
      "condition,viability\ncombo,0.2\nwashout,0.8\n",
      "utf-8",
    );
    await writeFile(
      path.join(projectRoot, "figures", "residual_cells.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await writeFile(
      path.join(projectRoot, "figures", "residual_cells.png.md"),
      "# residual_cells.png\n\n[Binary file: residual_cells.png]\n",
      "utf-8",
    );
    await writeFile(
      path.join(projectRoot, ".brain", "state", "chat.json"),
      "{\"messages\":[]}\n",
      "utf-8",
    );
    await writeFile(path.join(projectRoot, ".references.json"), "{}\n", "utf-8");
    await writeFile(path.join(projectRoot, "project.json"), "{}\n", "utf-8");

    const result = await interpretMultimodalResultPacket({
      llm: {
        complete: vi.fn(async () => {
          throw new Error("fallback");
        }),
      },
      project: "packet-alpha",
      prompt: "Interpret this packet.",
    });

    expect(result.filesConsidered).toEqual([
      "data/viability_table.csv",
      "docs/oncology_note.txt",
      "figures/residual_cells.png",
    ]);
    expect(result.unsupportedInputs).toEqual(["figures/residual_cells.png"]);

    const savedPath = path.join(scienceswarmDir, "workspace", result.savePath);
    const saved = await readFile(savedPath, "utf-8");
    expect(saved).toContain("docs/oncology_note.txt");
    expect(saved).toContain("figures/residual_cells.png");
    expect(saved).not.toContain(".brain/state/chat.json");
  });

  it("combines explicit file hints with the rest of the visible packet", async () => {
    const scienceswarmDir = await mkdtemp(
      path.join(os.tmpdir(), "scienceswarm-multimodal-"),
    );
    process.env.SCIENCESWARM_DIR = scienceswarmDir;

    const projectRoot = path.join(scienceswarmDir, "projects", "packet-beta");
    await mkdir(path.join(projectRoot, "docs"), { recursive: true });
    await mkdir(path.join(projectRoot, "data"), { recursive: true });
    await mkdir(path.join(projectRoot, "figures"), { recursive: true });

    await writeFile(
      path.join(projectRoot, "docs", "figure_caption.txt"),
      "Caption says residual structures stay quiescent during washout.\n",
      "utf-8",
    );
    await writeFile(
      path.join(projectRoot, "docs", "oncology_note.txt"),
      "Note says the survivors become sensitive again on rechallenge.\n",
      "utf-8",
    );
    await writeFile(
      path.join(projectRoot, "data", "viability_table.csv"),
      "condition,viability\ncombo,0.2\n",
      "utf-8",
    );
    await writeFile(
      path.join(projectRoot, "figures", "residual_cells.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    await writeFile(
      path.join(projectRoot, "figures", "residual_cells.png.md"),
      "# residual_cells.png\n\n[Binary file: residual_cells.png]\n",
      "utf-8",
    );

    const result = await interpretMultimodalResultPacket({
      llm: {
        complete: vi.fn(async () => {
          throw new Error("fallback");
        }),
      },
      project: "packet-beta",
      prompt: "Interpret the table and image in context.",
      files: [
        { workspacePath: "data/viability_table.csv" },
        { workspacePath: "figures/residual_cells.png" },
      ],
    });

    expect(result.filesConsidered).toEqual([
      "data/viability_table.csv",
      "figures/residual_cells.png",
      "docs/figure_caption.txt",
      "docs/oncology_note.txt",
    ]);
  });
});
