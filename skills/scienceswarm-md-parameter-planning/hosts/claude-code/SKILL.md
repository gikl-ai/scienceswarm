---
name: scienceswarm-md-parameter-planning
description: Recommend MD parameters with rationale, confidence, assumptions, alternatives, expert-sensitivity labels, and risks if chosen incorrectly.
---

# ScienceSwarm MD Parameter Planning

Use this skill to create the Parameter Decision Ledger. This is the main
scientific judgment step for non-expert MD users.

## Workflow

1. Read the MD Study Brief, Evidence Grounding Packet, and Molecular System
   Definition.
2. Recommend force field, solvent, ions, box, minimization, equilibration,
   runtime, timestep, thermostat/barostat, restraints, sampling strategy, and
   analysis metrics.
3. For every choice, include rationale, evidence class, confidence,
   assumptions, risks if wrong, alternatives, and what would change the choice.
4. For every choice, state validation signals and failure indicators.
5. Include replicates/seeds, controls/comparators, sampling adequacy,
   convergence criteria, and sensitivity checks when the conclusion depends on
   stability or convergence.
6. Label each choice as `standard-default`, `expert-sensitive`, or
   `do-not-default`.
7. Produce a `Parameter Decision Ledger` with
   `asset_kind: md_parameter_decision_ledger`.

When the `scienceswarm` MCP tools are available, save the ledger with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active study, and links or references to the upstream study, evidence,
and system-definition assets. If saving fails, report the exact save failure
and do not present the ledger as durable.

Include a `Confidence Boundary` section in the ledger.

Every parameter needs both a plain-English teaching note and an expert caveat.
