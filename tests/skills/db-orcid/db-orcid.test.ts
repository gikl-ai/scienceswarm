import { describe, expect, it } from "vitest";

import { parseOrcidRecord, parseOrcidSearchResult } from "@/lib/skills/db-orcid";

describe("db-orcid adapter", () => {
  it("maps an ORCID public record into a person entity", () => {
    const entity = parseOrcidRecord(
      {
        "orcid-identifier": { path: "0000-0002-1825-0097" },
        person: {
          name: {
            "given-names": { value: "Ada" },
            "family-name": { value: "Lovelace <script>x</script>" },
          },
        },
        "activities-summary": {
          employments: {
            "affiliation-group": [
              {
                summaries: [
                  {
                    "employment-summary": {
                      organization: { name: "Analytical Engine Lab" },
                    },
                  },
                ],
              },
            ],
          },
          works: { group: [{}, {}] },
        },
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("person");
    if (entity?.type !== "person") throw new Error("expected person entity");
    expect(entity).toMatchObject({
      primary_id: { scheme: "orcid", id: "0000-0002-1825-0097" },
      payload: {
        name: "Ada Lovelace",
        orcid: "0000-0002-1825-0097",
        affiliations: ["Analytical Engine Lab"],
        works_count: 2,
      },
    });
  });

  it("maps ORCID expanded search results into person entities", () => {
    const entity = parseOrcidSearchResult(
      {
        "orcid-id": "0000-0002-1825-0097",
        "given-names": "Ada",
        "family-names": "Lovelace",
        "institution-name": ["Analytical Engine Lab"],
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("person");
    if (entity?.type !== "person") throw new Error("expected person entity");
    expect(entity.payload.name).toBe("Ada Lovelace");
    expect(entity.payload.affiliations).toEqual(["Analytical Engine Lab"]);
  });
});
