import { afterEach, describe, expect, it, vi } from "vitest";

import { resetDbBaseStateForTests } from "@/lib/skills/db-base";
import {
  fetchOpenAlexEntity,
  parseOpenAlexAuthor,
  parseOpenAlexWork,
} from "@/lib/skills/db-openalex";

afterEach(() => {
  vi.unstubAllGlobals();
  resetDbBaseStateForTests();
});

describe("db-openalex adapter", () => {
  it("maps an OpenAlex work into a paper entity", () => {
    const entity = parseOpenAlexWork(
      {
        id: "https://openalex.org/W123",
        doi: "https://doi.org/10.1000/Test",
        display_name: "OpenAlex <i>work</i>",
        abstract_inverted_index: { Real: [0], abstract: [1] },
        authorships: [
          {
            author: {
              display_name: "Ada Lovelace",
              orcid: "https://orcid.org/0000-0002-1825-0097",
            },
          },
        ],
        primary_location: { source: { display_name: "Science" } },
        type: "article",
        publication_year: 2026,
        is_retracted: true,
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("paper");
    if (entity?.type !== "paper") throw new Error("expected paper entity");
    expect(entity).toMatchObject({
      primary_id: { scheme: "doi", id: "10.1000/test" },
      payload: {
        title: "OpenAlex work",
        abstract: "Real abstract",
        venue: { name: "Science", type: "article" },
        year: 2026,
        retraction_status: "retracted",
      },
    });
    expect(entity.payload.authors).toEqual([
      { name: "Ada Lovelace", orcid: "0000-0002-1825-0097" },
    ]);
  });

  it("maps an OpenAlex author into a person entity", () => {
    const entity = parseOpenAlexAuthor(
      {
        id: "https://openalex.org/A123",
        display_name: "Ada Lovelace",
        orcid: "https://orcid.org/0000-0002-1825-0097",
        last_known_institutions: [{ display_name: "Analytical Engine Lab" }],
        works_count: 42,
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("person");
    if (entity?.type !== "person") throw new Error("expected person entity");
    expect(entity).toMatchObject({
      primary_id: { scheme: "orcid", id: "0000-0002-1825-0097" },
      payload: {
        name: "Ada Lovelace",
        affiliations: ["Analytical Engine Lab"],
        works_count: 42,
      },
    });
  });

  it("normalizes OpenAlex API-style author URLs before fetch", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(
      JSON.stringify({
        id: "https://openalex.org/A123",
        display_name: "Ada Lovelace",
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenAlexEntity("https://api.openalex.org/authors/A123", "person");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("https://api.openalex.org/authors/A123");
    expect(url).not.toContain("https%3A");
  });
});
