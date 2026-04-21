import { describe, expect, it } from "vitest";

import { parseClinicalTrialStudy } from "@/lib/skills/db-clinicaltrials";

describe("db-clinicaltrials adapter", () => {
  it("maps a ClinicalTrials.gov study into a trial entity", () => {
    const entity = parseClinicalTrialStudy(
      {
        protocolSection: {
          identificationModule: {
            nctId: "NCT04280705",
            briefTitle: "Remdesivir <i>trial</i>",
          },
          statusModule: { overallStatus: "TERMINATED" },
          sponsorCollaboratorsModule: {
            leadSponsor: { name: "National Institute of Allergy and Infectious Diseases" },
          },
          designModule: { phases: ["PHASE2", "PHASE3"] },
          conditionsModule: { conditions: ["COVID-19"] },
          armsInterventionsModule: {
            interventions: [{ name: "Remdesivir" }],
          },
        },
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("trial");
    if (entity?.type !== "trial") throw new Error("expected trial entity");
    expect(entity).toMatchObject({
      primary_id: { scheme: "nct", id: "NCT04280705" },
      payload: {
        title: "Remdesivir trial",
        sponsor: "National Institute of Allergy and Infectious Diseases",
        phase: "Phase 2, Phase 3",
        status: "terminated",
        conditions: ["COVID-19"],
        interventions: ["Remdesivir"],
      },
    });
  });

  it("normalizes ClinicalTrials.gov phase enum spellings", () => {
    const entity = parseClinicalTrialStudy(
      {
        protocolSection: {
          identificationModule: { nctId: "NCT00000001", briefTitle: "Phase enum study" },
          sponsorCollaboratorsModule: { leadSponsor: { name: "Sponsor" } },
          designModule: { phases: ["EARLY_PHASE1", "PHASE4", "NA"] },
        },
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("trial");
    if (entity?.type !== "trial") throw new Error("expected trial entity");
    expect(entity.payload.phase).toBe("Early Phase 1, Phase 4, N/A");
  });
});
