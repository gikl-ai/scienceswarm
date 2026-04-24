---
name: scienceswarm-md-parameter-planning
description: Recommend MD parameters with rationale, confidence, assumptions, alternatives, expert-sensitivity labels, and risks if chosen incorrectly.
---

# ScienceSwarm MD Parameter Planning

Use this skill when a coding or execution plan would require scientific MD
parameter choices.

## Workflow

1. Review upstream MD brain assets.
2. Produce a parameter table covering force field, solvent, ions, box,
   minimization, equilibration, runtime, timestep, thermostat/barostat,
   restraints, sampling, and analysis.
3. For each parameter, state recommendation, rationale, evidence class,
   confidence, assumptions, risks, alternatives, source refs, teaching note, and
   expert note.
4. Mark `do-not-default` choices as blockers.
5. Save or return a `Parameter Decision Ledger` with
   `asset_kind: md_parameter_decision_ledger` and a `Confidence Boundary`.

Do not choose expert-sensitive parameters without evidence or a clear caveat.
