---
name: scienceswarm-md-execution-handoff
description: Create a Claude Code or OpenHands-ready execution plan for preparing, running, validating, and collecting artifacts for an MD study without inventing scientific choices.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-handoff
outputs:
  - Execution Handoff Plan brain asset with asset_kind md_execution_handoff_plan
  - coding-agent prompt
  - expected artifact checklist
---

# ScienceSwarm MD Execution Handoff

Use this skill when the scientific plan is ready to hand to Claude Code,
OpenHands, or another coding agent.

The handoff can be operationally specific, but it must be scientifically
conservative. A coding agent may generate files and run commands. It must not
quietly make MD judgment calls.

## Required Inputs

- MD Study Brief.
- Molecular System Definition.
- Parameter Decision Ledger.
- Preferred or allowed MD stack.
- Local compute constraints.

## Execution Boundary

The coding agent may:

- Generate config files and scripts.
- Run local validation commands.
- Collect logs and artifacts.
- Report failed assumptions or missing inputs.

The coding agent must not:

- Invent missing scientific parameters.
- Silently substitute force fields, protonation states, ligands, structures, or
  membrane composition.
- Treat a successful run as scientific validation.

## Output Shape

Produce an `MD Execution Handoff Plan`:

```markdown
# MD Execution Handoff Plan: {Study Title}

## Purpose

## Linked Brain Assets

## Execution Boundary

## Recommended Stack

| Stack | Recommendation | Why | Tradeoff |
|---|---|---|---|

## Inputs Required

| Input | Status | Source | Blocking? |
|---|---|---|---|

## Files To Generate

| File | Purpose | Generated From |
|---|---|---|

## Execution Stages

### 1. Environment Check
### 2. System Preparation
### 3. Parameterization
### 4. Minimization
### 5. Equilibration
### 6. Production Run
### 7. Initial Analysis

## Stage Gate Checklist

Each stage must have explicit pass and fail signals. Failed validation gates stop
execution and preserve artifacts for review rather than flowing into the next
stage.

| Stage | Pass Signal | Fail Signal | Stop Action | Artifacts To Save |
|---|---|---|---|---|

## Expected Artifacts

| Artifact | Required? | Brain Asset Target |
|---|---|---|

## Run Provenance Manifest

Record enough detail for another scientist to reproduce or audit the run:

- Software, package, and workflow versions.
- Exact command lines and working directory.
- Input file hashes and generated config files.
- Random seeds and replica identifiers.
- Hardware, accelerator, precision, and parallelization notes.
- Checkpoint and restart policy.
- Warnings, failed assumptions, and validation-gate outcomes.

## Stop Conditions

## Coding Agent Prompt

## Confidence Boundary

What this execution plan supports:
- A reproducible local starter run.

What it does not support:
- Scientific validity of the model by itself.
- Binding affinity claims.
- Mechanistic cancer biology claims without interpretation and validation.

What would change this plan:
- ...
```

Use frontmatter when saving:

```yaml
type: artifact
asset_kind: md_execution_handoff_plan
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline, execution-handoff]
```

## Stop Conditions

Stop if the handoff requires guessing scientific choices, the protocol review is
blocked, or required inputs are absent.
