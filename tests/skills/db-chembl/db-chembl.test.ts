import { describe, expect, it } from "vitest";

import { parseChemblMolecule } from "@/lib/skills/db-chembl";

describe("db-chembl adapter", () => {
  it("maps a ChEMBL molecule into a compound entity with lifecycle status", () => {
    const entity = parseChemblMolecule(
      {
        molecule_chembl_id: "CHEMBL25",
        pref_name: "Aspirin <script>x</script>",
        molecule_properties: { full_molformula: "C9H8O4" },
        molecule_structures: { standard_inchi_key: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N" },
        max_phase: 4,
        withdrawn_flag: true,
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("compound");
    if (entity?.type !== "compound") throw new Error("expected compound entity");
    expect(entity).toMatchObject({
      primary_id: { scheme: "chembl", id: "CHEMBL25" },
      ids: { chembl: "CHEMBL25", inchi_key: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N" },
      payload: {
        name: "Aspirin",
        molecular_formula: "C9H8O4",
        inchi_key: "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
        status: "discontinued",
        max_phase: 4,
      },
    });
  });
});
