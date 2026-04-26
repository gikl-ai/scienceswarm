---
name: scienceswarm-research-reasoning
description: Use optional reasoning prompt patterns for research questions without committing the study to a fixed UI workflow.
---

# ScienceSwarm Research Reasoning

Use this skill when the user asks for deeper reasoning over study evidence,
but do not assume they want a wizard, a preset workflow, or a new dashboard
surface. Treat these as prompt patterns that can be run from chat and saved to
gbrain only when the user asks for a durable artifact.

## Principles

1. Start from the user's question, not a predetermined workflow.
2. Use the current study files, selected gbrain artifacts, and cited sources
   as evidence. Say when evidence is missing or stale.
3. Keep outputs short enough to act on unless the user asks for a full report.
4. Distinguish facts, assumptions, hypotheses, and recommendations.
5. Prefer saving reusable conclusions as brain artifacts or decision records
   over adding UI-specific state.

## Optional patterns

- `Evidence map`: claims, supporting evidence, tensions, unknowns, confidence,
  and the next check.
- `Next experiment or proof step`: current bottleneck, candidate moves, best
  next move, prerequisites, and stop criteria.
- `Experimental design critique`: hypothesis, design summary, confounds,
  controls, sample limits, failure modes, and revision.
- `Model-system applicability`: target question, model strengths, model gaps,
  external-validity risks, alternatives, and decision.
- `Target or biomarker prioritization`: candidates, criteria, evidence, risks,
  ranking, and what would change the ranking.
- `Multimodal result interpretation`: observed signal, what it supports, what
  it does not show, possible artifacts, and follow-up.
- `Decision update`: previous view, new evidence, belief change, decision,
  confidence, and review trigger.

If the user asks to save, capture the result in the brain as a normal artifact
or decision record with source provenance. Do not create a new specialized UI
state for these patterns.
