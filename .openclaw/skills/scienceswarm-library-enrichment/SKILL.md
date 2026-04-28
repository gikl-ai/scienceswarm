---
name: scienceswarm-library-enrichment
description: Suggest and import legally available missing papers from the local paper graph while preserving gbrain provenance.
owner: scienceswarm
runtime: in-session
tier: research
entity_types: [paper, study]
network: optional
tools:
  - paper_library_enrichment_context
  - paper_library_acquisition
  - openhands_delegate
  - brain_capture
secrets: []
outputs:
  - paper entity pages in gbrain
  - paper-library enrichment provenance
metadata:
  openclaw:
    emoji: "LE"
aliases:
  - library-enrichment
  - enrich-library
---

# ScienceSwarm Library Enrichment

Use this skill when the user asks a research question and wants to know which
missing papers would improve the answer, or when they explicitly ask
ScienceSwarm to find/import missing papers from the paper library graph.

## Procedure

1. Start from the user's current research question. Do not rank the whole
   literature universe without a question or explicit graph-gap request.
2. Load the study graph context from
   `/api/brain/paper-library/enrichment?study=<study>&question=<question>`.
   Use graph summaries, identifiers, abstracts/excerpts, source URLs, and short
   graph paths. Do not send raw PDFs to hosted tools under local-only policy.
3. Return a short list of suggestions with title, known identifiers/source URL,
   why the paper helps this question, local graph evidence, legal download
   status, and a recommended action.
4. Before downloading PDFs, ask for per-session consent to download legal open
   PDFs for this research turn. Never bypass paywalls or hide license
   uncertainty.
5. For obvious arXiv/open PDF records, use the paper-library acquisition API so
   the result writes through the canonical gbrain `persistTransaction()` path.
   Metadata-only records should still become paper pages marked not downloaded.
6. For long browse/download/import loops, delegate to OpenHands with
   `openhands_delegate`. Instruct it to write results through ScienceSwarm APIs
   or gbrain tools, never direct gbrain file edits.
7. After import, refresh or re-read graph context so the imported paper is
   treated as local in future research turns.

## Output Contract

Suggestions should include:

- title
- identifiers or source URL if known
- why it helps this question
- local paper or graph-path evidence
- legal download status
- recommended action: `download_now`, `save_for_later`, `cite_only`, or
  `ignore`

Acquisition records must preserve:

- originating question
- tool used
- source URL
- local downloaded path and checksum when downloaded
- gbrain slug
- graph evidence
- consent scope

Do not create a separate acquisition dashboard, queue, or direct file writer for
this workflow.
