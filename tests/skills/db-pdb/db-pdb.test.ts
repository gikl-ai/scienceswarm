import { describe, expect, it } from "vitest";

import { parsePdbEntry } from "@/lib/skills/db-pdb";

describe("db-pdb adapter", () => {
  it("maps an RCSB entry into a structure entity", () => {
    const entity = parsePdbEntry(
      {
        rcsb_id: "1ABC",
        polymer_entities: [{
          rcsb_polymer_entity: { pdbx_description: "Tumor suppressor p53" },
          rcsb_entity_source_organism: [
            { ncbi_scientific_name: "Homo sapiens" },
            { ncbi_scientific_name: null },
            { bogus: "not an organism" },
          ],
        }],
        struct: { title: "Example kinase structure" },
        rcsb_entry_info: { resolution_combined: [2.1] },
        rcsb_accession_info: { initial_release_date: "2025-01-02" },
        pdbx_database_status: { status_code: "REL" },
        exptl: [{ method: "X-RAY DIFFRACTION" }],
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("structure");
    if (entity?.type !== "structure") throw new Error("expected structure entity");
    expect(entity).toMatchObject({
      type: "structure",
      primary_id: { scheme: "pdb", id: "1ABC" },
      source_db: ["pdb"],
      payload: {
        title: "Example kinase structure",
        method: "X-RAY DIFFRACTION",
        resolution_angstrom: 2.1,
        release_date: "2025-01-02",
        status: "active",
        macromolecules: ["Tumor suppressor p53"],
        source_organisms: ["Homo sapiens"],
      },
    });
  });

  it("maps obsolete status into lifecycle metadata", () => {
    const entity = parsePdbEntry(
      {
        rcsb_id: "2XYZ",
        struct: { title: "Old structure" },
        pdbx_database_status: { status_code: "OBS" },
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("structure");
    if (entity?.type !== "structure") throw new Error("expected structure entity");
    expect(entity.payload.status).toBe("obsolete");
  });
});
