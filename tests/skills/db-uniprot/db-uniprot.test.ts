import { afterEach, describe, expect, it, vi } from "vitest";

import { resetDbBaseStateForTests } from "@/lib/skills/db-base";
import { parseUniprotRecord, uniprotSearch } from "@/lib/skills/db-uniprot";

afterEach(() => {
  vi.unstubAllGlobals();
  resetDbBaseStateForTests();
});

describe("db-uniprot adapter", () => {
  it("maps a UniProtKB record into a protein entity", () => {
    const entity = parseUniprotRecord(
      {
        primaryAccession: "P04637",
        uniProtkbId: "P53_HUMAN",
        entryType: "UniProtKB reviewed (Swiss-Prot)",
        proteinDescription: {
          recommendedName: { fullName: { value: "Cellular tumor antigen p53 <script>x</script>" } },
        },
        organism: { scientificName: "Homo sapiens" },
        genes: [{ geneName: { value: "TP53" } }],
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("protein");
    if (entity?.type !== "protein") throw new Error("expected protein entity");
    expect(entity).toMatchObject({
      primary_id: { scheme: "uniprot", id: "P04637" },
      payload: {
        recommended_name: "Cellular tumor antigen p53",
        organism: "Homo sapiens",
        reviewed: true,
        status: "active",
        genes: ["TP53"],
      },
    });
  });

  it("surfaces inactive UniProt records as deprecated", () => {
    const entity = parseUniprotRecord(
      {
        primaryAccession: "Q00000",
        entryType: "Inactive",
        inactiveReason: { inactiveReasonType: "DEMERGED" },
      },
      "2026-04-18T12:00:00.000Z",
    );

    expect(entity?.type).toBe("protein");
    if (entity?.type !== "protein") throw new Error("expected protein entity");
    expect(entity.payload.status).toBe("deprecated");
  });

  it("threads UniProt cursor pagination through page_token", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(
      JSON.stringify({
        results: [
          {
            primaryAccession: "P04637",
            proteinDescription: { recommendedName: { fullName: { value: "p53" } } },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          link: '<https://rest.uniprot.org/uniprotkb/search?cursor=next-token&size=20>; rel="next"',
          "x-total-results": "85176",
        },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uniprotSearch(
      { query: "TP53", page_token: "input-token", page_size: 20 },
      { persist: false },
    );

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("cursor")).toBe("input-token");
    expect(url.searchParams.has("offset")).toBe(false);
    expect(url.searchParams.get("size")).toBe("20");
    expect(result.cursor).toBe("next-token");
    expect(result.total).toBe(85176);
  });

  it("falls back to the parsed entity count when UniProt omits a total header", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(
      JSON.stringify({
        results: [
          {
            primaryAccession: "P04637",
            proteinDescription: { recommendedName: { fullName: { value: "p53" } } },
          },
        ],
      }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uniprotSearch({ query: "TP53", page_size: 20 }, { persist: false });

    expect(result.total).toBe(1);
    expect(result.cursor).toBeUndefined();
  });

  it("parses next cursors from Link headers with commas inside URL values", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(
      JSON.stringify({
        results: [
          {
            primaryAccession: "P04637",
            proteinDescription: { recommendedName: { fullName: { value: "p53" } } },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          link: [
            '<https://rest.uniprot.org/uniprotkb/search?cursor=previous,token&size=20>; rel="prev"',
            '<https://rest.uniprot.org/uniprotkb/search?cursor=next,token&size=20>; rel="next"',
          ].join(", "),
        },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uniprotSearch({ query: "TP53", page_size: 20 }, { persist: false });

    expect(result.cursor).toBe("next,token");
  });

  it("keeps malformed fallback cursor decoding local to Link parsing", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(
      JSON.stringify({
        results: [
          {
            primaryAccession: "P04637",
            proteinDescription: { recommendedName: { fullName: { value: "p53" } } },
          },
        ],
      }),
      {
        status: 200,
        headers: {
          link: '<not-a-valid-url?cursor=%ZZ>; rel="next"',
        },
      },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uniprotSearch({ query: "TP53", page_size: 20 }, { persist: false });

    expect(result.cursor).toBe("%ZZ");
  });
});
