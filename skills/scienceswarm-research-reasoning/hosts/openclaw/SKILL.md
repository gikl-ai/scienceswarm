---
name: scienceswarm-research-reasoning
description: Use optional reasoning prompt patterns for research questions without committing the project to a fixed UI workflow.
---

# ScienceSwarm Research Reasoning

Use this skill when the user asks for deeper reasoning over project evidence,
but do not assume they want a wizard, a preset workflow, or a new dashboard
surface. Treat these as prompt patterns that can be run from chat and saved to
gbrain only when the user asks for a durable artifact.

## Principles

1. Start from the user's question, not a predetermined workflow.
2. Use the current project files, selected gbrain artifacts, and cited sources
   as evidence. Say when evidence is missing or stale.
3. Keep outputs short enough to act on unless the user asks for a full report.
4. Distinguish facts, assumptions, hypotheses, and recommendations.
5. Prefer saving reusable conclusions as brain artifacts or decision records
   over adding UI-specific state.

## Optional patterns

### Evidence map

Use when the user asks what the project evidence supports, contradicts, or
leaves uncertain.

Output:

- `Question`
- `Claims`
- `Supporting evidence`
- `Tensions`
- `Unknowns`
- `Confidence`
- `Next check`

### Next experiment or proof step

Use when the user wants the next action after reading papers, notes, failed
runs, or partial results.

Output:

- `Current bottleneck`
- `Candidate moves`
- `Best next move`
- `Why this move`
- `Materials or prerequisites`
- `Stop criteria`

### Experimental design critique

Use when the user asks whether a protocol, assay, benchmark, or study design
would actually test the intended hypothesis.

Output:

- `Hypothesis`
- `Design summary`
- `Confounds`
- `Controls`
- `Power or sample limits`
- `Failure modes`
- `Revision`

### Model-system applicability

Use when the user asks whether a cell line, animal model, benchmark, dataset,
or mathematical abstraction is appropriate for a target question.

Output:

- `Target question`
- `Model strengths`
- `Model gaps`
- `External validity risks`
- `Better alternatives`
- `Decision`

### Target or biomarker prioritization

Use when the user needs to rank candidate mechanisms, biomarkers, targets,
lemmas, or approaches.

Output:

- `Candidates`
- `Selection criteria`
- `Evidence by candidate`
- `Risks`
- `Ranking`
- `What would change the ranking`

### Multimodal result interpretation

Use when the user shares figures, tables, images, logs, or result packets and
wants an interpretation tied back to the research question.

Output:

- `Observed signal`
- `What it supports`
- `What it does not show`
- `Possible artifacts`
- `Follow-up`

### Decision update

Use when a user wants to know whether new evidence should change the working
plan, or wants a durable record of why they changed direction.

Output:

- `Previous view`
- `New evidence`
- `Belief change`
- `Decision`
- `Confidence`
- `Review trigger`

## Saving

If the user asks to save, capture the result in the brain as a normal artifact
or decision record with source provenance. Do not create a new specialized UI
state for these patterns.
