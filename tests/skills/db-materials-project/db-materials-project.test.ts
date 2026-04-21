import { afterEach, describe, expect, it } from "vitest";

import { getRequiredDatabaseKey } from "@/lib/skills/db-base";
import { parseMaterialsProjectSummary } from "@/lib/skills/db-materials-project";

describe("db-materials-project adapter", () => {
  afterEach(() => {
    delete process.env.MATERIALS_PROJECT_API_KEY;
  });

  it("maps a Materials Project summary into a material entity", () => {
    const entity = parseMaterialsProjectSummary(
      {
        material_id: "mp-149",
        formula_pretty: "Si",
        symmetry: { crystal_system: "Cubic" },
        band_gap: 1.1,
        energy_above_hull: 0,
        is_stable: true,
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity).toMatchObject({
      type: "material",
      ids: { mp: "mp-149", materials_project: "mp-149" },
      primary_id: { scheme: "mp", id: "mp-149" },
      payload: {
        material_id: "mp-149",
        formula: "Si",
        crystal_system: "Cubic",
        band_gap_ev: 1.1,
        energy_above_hull_ev: 0,
        is_stable: true,
      },
    });
  });

  it("returns an actionable missing-key error", () => {
    delete process.env.MATERIALS_PROJECT_API_KEY;

    expect(() => getRequiredDatabaseKey("MATERIALS_PROJECT_API_KEY")).toThrow(
      /Add MATERIALS_PROJECT_API_KEY=.*\.env.*\/api\/health/,
    );
  });
});
