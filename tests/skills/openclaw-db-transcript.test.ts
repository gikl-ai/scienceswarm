import { describe, expect, it } from "vitest";

import { createBrainMcpServer } from "@/brain/mcp-server";

interface SearchTranscriptTurn {
  user: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults: Array<{ source: string; title: string; id: string }>;
  assistant: string;
}

interface SaveTranscriptTurn {
  user: string;
  selected: { source: string; id: string };
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  toolResults: Array<{
    slug: string;
    diskPath: string;
    entity: {
      type: string;
      primary_id: { scheme: string; id: string };
      source_db: string[];
      payload: { title: string };
    };
  }>;
}

interface ReadTranscriptTurn {
  user: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  assistant: string;
}

const transcript: {
  turns: [SearchTranscriptTurn, SaveTranscriptTurn, ReadTranscriptTurn];
} = {
  turns: [
    {
      user: "Find papers about CRISPR base editing from PubMed, Crossref, and OpenAlex",
      toolCalls: [
        { name: "pubmed_search", args: { query: "CRISPR base editing", page: 1, page_size: 10 } },
        { name: "crossref_search", args: { query: "CRISPR base editing", page: 1, page_size: 10 } },
        {
          name: "openalex_search",
          args: { query: "CRISPR base editing", entity_type: "paper", page: 1, page_size: 10 },
        },
      ],
      toolResults: [
        { source: "pubmed", title: "Prime editing in mammalian cells", id: "PMID-1" },
        { source: "crossref", title: "Base editors and prime editors", id: "10.1000/base" },
        { source: "openalex", title: "Programmable base editing review", id: "W2741809807" },
      ],
      assistant:
        "I found Prime editing in mammalian cells (PMID-1), Base editors and prime editors (10.1000/base), and Programmable base editing review (W2741809807).",
    },
    {
      user: "Save this one to my brain",
      selected: { source: "pubmed", id: "PMID-1" },
      toolCalls: [{ name: "pubmed_fetch", args: { id: "PMID-1", scheme: "pmid" } }],
      toolResults: [{
        slug: "paper-doi-10.1000-base",
        diskPath: "/tmp/scienceswarm/literature/paper-doi-10.1000-base.md",
        entity: {
          type: "paper",
          primary_id: { scheme: "doi", id: "10.1000/base" },
          source_db: ["pubmed"],
          payload: { title: "Prime editing in mammalian cells" },
        },
      }],
    },
    {
      user: "Read back the PubMed paper you just fetched",
      toolCalls: [{ name: "brain_read", args: { path: "literature/paper-doi-10.1000-base.md" } }],
      assistant: "Prime editing in mammalian cells is a paper from pubmed with primary id doi:10.1000/base.",
    },
  ],
};

describe("OpenClaw database transcript acceptance", () => {
  it("selects database MCP tools for literature search instead of answering from memory", () => {
    const registeredTools = readPrivateRecord(createBrainMcpServer(), "_registeredTools");
    const first = transcript.turns[0];
    const calls = first.toolCalls.map((call) => call.name);

    expect(calls).toEqual(["pubmed_search", "crossref_search", "openalex_search"]);
    for (const call of calls) {
      expect(registeredTools, `MCP tool ${call} should be registered`).toHaveProperty(call);
    }
    for (const result of first.toolResults ?? []) {
      expect(first.assistant).toContain(result.title);
      expect(first.assistant).toContain(result.id);
    }
    expect(first.assistant).not.toContain("unsupported memory");
  });

  it("saves a selected search result by exact source fetch and reads the persisted slug back", () => {
    const save = transcript.turns[1];
    expect(save.toolCalls).toEqual([
      { name: "pubmed_fetch", args: { id: "PMID-1", scheme: "pmid" } },
    ]);
    expect(save.toolResults?.[0]).toMatchObject({
      slug: "paper-doi-10.1000-base",
      entity: {
        type: "paper",
        primary_id: { scheme: "doi", id: "10.1000/base" },
        source_db: ["pubmed"],
      },
    });

    const read = transcript.turns[2];
    expect(read.toolCalls).toEqual([
      { name: "brain_read", args: { path: "literature/paper-doi-10.1000-base.md" } },
    ]);
    expect(read.assistant).toContain("Prime editing in mammalian cells");
    expect(read.assistant).toContain("doi:10.1000/base");
    expect(read.assistant).toContain("pubmed");
  });
});

function readPrivateRecord(source: object, key: string): Record<string, unknown> {
  const value: unknown = Reflect.get(source, key);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}
