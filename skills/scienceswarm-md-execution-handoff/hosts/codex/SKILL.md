---
name: scienceswarm-md-execution-handoff
description: Create a Claude Code or OpenHands-ready execution plan for preparing, running, validating, and collecting artifacts for an MD study without inventing scientific choices.
---

# ScienceSwarm MD Execution Handoff

Use this skill when implementation should proceed from an MD plan. The output is
a handoff document, not direct simulation code unless the user asks for code
after accepting the handoff.

## Workflow

1. Verify upstream MD assets exist and do not conflict.
2. Define stack, files, commands, validation checks, artifacts, and stop
   conditions.
3. State what the coding agent may and must not do.
4. Produce an `Execution Handoff Plan` with
   `asset_kind: md_execution_handoff_plan`, a `Coding Agent Prompt`, and a
   `Confidence Boundary`.

The coding agent must not invent force fields, protonation states, ligands,
structures, or membrane composition.
