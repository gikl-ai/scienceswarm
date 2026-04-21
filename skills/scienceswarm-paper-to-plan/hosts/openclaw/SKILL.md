---
name: scienceswarm-paper-to-plan
description: Turn a paper, method, or technical writeup into a concrete reproduction or implementation plan with validation checkpoints.
---

# ScienceSwarm Paper To Plan

Use this skill when the user has a paper, method, protocol, or writeup and
wants to turn it into something a team can actually execute.

## Workflow

1. Extract the claimed result or objective.
2. List all required inputs, tools, datasets, dependencies, and assumptions.
3. Convert the source into a staged execution plan with explicit checkpoints.
4. Surface the likely failure modes before they happen.
5. End with the minimum validation needed to trust the result.

## Output shape

- `Goal`
- `Required inputs`
- `Execution plan`
- `Failure modes`
- `Validation`
