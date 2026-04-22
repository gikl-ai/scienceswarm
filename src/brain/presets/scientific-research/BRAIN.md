# BRAIN.md — ScienceSwarm Research Brain

## Owner
Name: {researcher name}
Field: {e.g., Computational Biology}
Institution: {e.g., MIT CSAIL}
Active Projects: {comma-separated list}

## Research-First Structure
- papers/        — canonical pages for papers you read, cite, or write
- topics/        — durable research topics, problem areas, and synthesized themes
- surveys/       — literature reviews, landscape scans, and comparison tables
- methods/       — techniques, protocols, and reusable analytical recipes
- hypotheses/    — active hypotheses with evidence tracking
- originals/     — your own raw ideas and first-pass syntheses
- projects/      — active research threads and deliverables
- packets/       — deterministic literature packets and landscape artifacts
- journals/      — overnight journals, run logs, and research job traces
- datasets/      — datasets used or produced
- people/        — researchers, collaborators, reviewers, and labs
- sources/       — raw imported material and provenance anchors
- inbox/         — uncategorized material pending review
- archive/       — deprecated or completed material

## Classification Rules
- Prefer `topics/` over a generic concept bucket when the page is a research area, framing, or recurring question.
- Prefer `surveys/` for structured literature syntheses and comparison artifacts.
- Prefer `methods/` for procedures, evaluators, assay designs, pipelines, and reusable techniques.
- Prefer `packets/` for deterministic literature packets built from multi-source collection and triage.
- Prefer `journals/` for durable run logs, overnight reports, and host-owned job traces.

## Writing Rules
- Every factual claim should point to a real paper, dataset, source file, or URL.
- Use explicit source provenance and preserve chunk/evidence handles when available.
- Cross-link papers, topics, methods, hypotheses, and projects whenever one informs another.
- Keep compiled truth concise; put chronology, new evidence, and revisions in the timeline section.

## Preferences
serendipity_rate: 0.20    # probability of "Did You Know?" in chat (0.0-1.0)
paper_watch_budget: 50    # monthly $ budget for auto-ingestion
ripple_cap: 15            # max pages updated per ingest

## Active Context
{LLM updates this section with current focus, recent ingests, open questions.}

## Custom Instructions
{Researcher-specific preferences go here. Examples:}
{- "Default to exact-title resolution before citing a paper."}
{- "Prefer method comparisons over generic summaries."}
{- "Treat negative results as first-class evidence."}
