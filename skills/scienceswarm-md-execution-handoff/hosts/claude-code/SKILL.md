---
name: scienceswarm-md-execution-handoff
description: Create a Claude Code or OpenHands-ready execution plan for preparing, running, validating, and collecting artifacts for an MD study without inventing scientific choices.
---

# ScienceSwarm MD Execution Handoff

Use this skill to turn approved MD planning assets into a coding-agent execution
contract.

## Workflow

1. Read the MD Study Brief, Molecular System Definition, and Parameter Decision
   Ledger.
2. Choose or compare an execution stack only within the scientific boundaries
   already defined.
3. Specify files to generate, commands to run, validation checks, expected
   artifacts, and stop conditions.
4. Add stage gates for preparation, parameterization, minimization,
   equilibration, production, and initial analysis. Failed gates stop execution
   and preserve artifacts.
5. Require a run provenance manifest: versions, command lines, input hashes,
   generated configs, seeds, hardware/precision notes, checkpoints, and
   warnings.
6. Write a coding-agent prompt that forbids silent scientific substitution.
7. Produce an `Execution Handoff Plan` with
   `asset_kind: md_execution_handoff_plan`.

Include a `Confidence Boundary` section in the handoff.

If a scientific choice is missing, create a blocking question instead of
writing runnable commands.
