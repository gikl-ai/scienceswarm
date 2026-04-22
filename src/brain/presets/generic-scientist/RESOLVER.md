# RESOLVER

ScienceSwarm scientist-defaults brain. Every page lives under exactly one
directory below. When you don't know where a new page belongs, walk this
list top-to-bottom and pick the first directory whose definition fits.
If nothing fits, file under `inbox/` and let the schema grow.

## Directories

- `people/` — humans you want to remember. PIs, collaborators,
  students, reviewers, program officers, AND historical figures
  (Einstein, von Neumann, Rosalind Franklin). One file per person,
  named after their canonical slug.
- `projects/` — active work threads (notebooks, papers-in-progress,
  side experiments). One file per thread.
- `concepts/` — scientific ideas, techniques, methods.
- `papers/` — academic papers read, cited, or produced.
- `experiments/` — wet-lab + computational experiments.
- `hypotheses/` — open hypotheses with evidence tracking.
- `protocols/` — reproducible protocols.
- `datasets/` — datasets referenced or produced.
- `conferences/` — conferences and workshops (NeurIPS, ICML, APS, ...).
- `presentations/` — talks given or attended.
- `meetings/` — lab meetings, reviews, 1:1s.
- `labs/` — research groups (own + collaborators).
- `funders/` — grant agencies, foundations, program officers.
- `instruments/` — microscopes, sequencers, anything with a
  calibration history.
- `ideas/` — undeveloped possibilities (pre-project).
- `writing/` — essays, blog posts, op-eds, theses, books.
- `originals/` — your own raw thoughts.
- `inbox/` — unfiled. Volume here is a signal the schema should grow.
- `sources/` — raw imported material (PDFs, emails, transcripts).
- `archive/` — deprecated pages.

## Page format

Compiled-Truth above the `---`, Timeline below. Iron Law: every
mention of a person, lab, paper, or concept is back-linked to the
target page. Cite raw sources with `[Source: ...]`.

## ScienceSwarm operating rules

OpenClaw communicates; OpenHands executes; gbrain stores. All durable
research knowledge belongs in gbrain before either agent treats it as
context. Do not create shadow stores in OpenClaw, OpenHands, or the
dashboard.

Use search detail intentionally:

- `detail=low` for exact lookup, entity disambiguation, and command
  routing.
- `detail=medium` for normal user answers and dashboard search.
- `detail=high` for critique, literature review, program briefs, and
  any answer that needs evidence synthesis.

When search results include `chunkId` and `chunkIndex`, preserve them
as evidence handles in downstream notes, critiques, and revision plans.
They are pointers into gbrain's indexed chunks, not user-facing citations
by themselves; pair them with source paths or URLs when presenting claims.

Watch health before large reasoning or maintenance runs. The
`brainScore`, embedding coverage, stale pages, orphan pages, dead links,
and missing embeddings are product signals. Explain them plainly and
recommend small fixes before bulk rewrites.

Adopt upstream gbrain skills as ScienceSwarm behaviors, not as a raw
resolver import. Do not run upstream gbrain autopilot daemon from
ScienceSwarm. Scheduled work must use ScienceSwarm runners, state under
`$SCIENCESWARM_DIR` by default while honoring `BRAIN_ROOT` when it is
configured outside that root, and attributed writes with
`SCIENCESWARM_USER_HANDLE`.

## Skill routing

- Capture, uploads, and user-provided sources: route through the
  ScienceSwarm capture path so raw material and derived notes land in
  gbrain.
- Brain health, feature recommendations, citation repair, link extraction,
  and embedding freshness: use the ScienceSwarm brain-maintenance skill.
- Ongoing paper and topic monitoring: use research-radar, then write
  briefings and concept Timeline entries back to gbrain.
- Audit and revise workflows: resolve the paper from gbrain first, create
  critique/plan/job artifacts in gbrain, and preserve evidence handles.

## Customizing

Add or remove directories freely. Every dir gets its own README.md
resolver describing what belongs there. Update this file when the
schema changes.
