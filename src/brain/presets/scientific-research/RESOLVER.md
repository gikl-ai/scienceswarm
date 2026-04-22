# RESOLVER

ScienceSwarm scientific-research brain. Every page lives under exactly one
directory below. When in doubt, choose the most research-specific home that
matches the page's long-term role. If nothing fits yet, file under `inbox/`
and let the schema grow deliberately.

## Directories

- `papers/` — canonical pages for papers read, cited, monitored, or produced.
- `topics/` — research areas, active questions, synthesized themes, and long-lived conceptual frames.
- `surveys/` — literature landscapes, comparison tables, review artifacts, and scoped research overviews.
- `methods/` — techniques, assays, protocols, evaluators, and reusable analytical procedures.
- `hypotheses/` — open hypotheses with evidence, predictions, and status tracking.
- `originals/` — your own raw ideas, first-pass syntheses, and unconsolidated insight.
- `projects/` — active work threads with clear deliverables or decision pressure.
- `packets/` — deterministic literature packets and source-triage artifacts.
- `journals/` — overnight journals, research job traces, and durable run logs.
- `datasets/` — datasets referenced, curated, or produced.
- `people/` — collaborators, authors, reviewers, labs, and other recurring actors.
- `sources/` — raw imported material, PDFs, transcripts, notes, and provenance anchors.
- `inbox/` — uncategorized material waiting for a durable home.
- `archive/` — completed or deprecated pages kept for reference.

## Page format

Compiled-Truth above the `---`, Timeline below. Link claims to their evidence.
When search exposes `chunkId` and `chunkIndex`, preserve them in derived notes
and plans as evidence handles.

## ScienceSwarm operating rules

OpenClaw communicates; OpenHands executes; gbrain stores. All durable
research memory belongs in gbrain before either agent treats it as settled
context. Do not create shadow stores in OpenClaw, OpenHands, or the dashboard.

Use search detail intentionally:

- `detail=low` for exact lookup, entity disambiguation, and routing.
- `detail=medium` for normal answers and dashboard search.
- `detail=high` for literature review, critique, synthesis, and audit work.

Prefer deterministic collection before synthesis. For literature work:

1. gather candidate papers in bulk
2. resolve exact titles and canonical identifiers
3. dedupe across sources
4. record failures and backoff decisions
5. write a packet or survey artifact
6. only then do selective deep reads and synthesis

Watch health before large reasoning or maintenance runs. Explain stale pages,
missing embeddings, orphan pages, and dead links plainly, then recommend small
repairs before bulk rewrites.

Adopt upstream gbrain capabilities as ScienceSwarm behaviors, not as a raw
resolver import. Do not run upstream gbrain autopilot daemon from
ScienceSwarm. Scheduled work must use ScienceSwarm runners, state under
`$SCIENCESWARM_DIR` by default while honoring `BRAIN_ROOT`, and attribute
writes with `SCIENCESWARM_USER_HANDLE`.

## Skill routing

- Capture, uploads, and user-provided sources: route through the
  ScienceSwarm capture path so raw material and derived notes land in
  gbrain.
- Literature landscapes and packet building: gather deterministically first,
  then write `packets/` or `surveys/` artifacts with explicit provenance.
- Ongoing paper and topic monitoring: use research-radar, then write briefings
  and topic timeline entries back to gbrain.
- Overnight jobs: write durable journal artifacts, not just transient output.
- Audit and revise workflows: resolve the paper from gbrain first, create
  critique/plan/job artifacts in gbrain, and preserve evidence handles.

## Customizing

Add or remove directories freely. Every dir gets its own README.md resolver
describing what belongs there. Update this file when the schema changes.
