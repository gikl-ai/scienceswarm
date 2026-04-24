---
name: scienceswarm-md-study-design
description: Clarify a molecular dynamics research goal, decide whether MD is the right method, and create an MD Study Brief with missing scientific inputs and confidence boundaries.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-study
outputs:
  - MD Study Brief brain asset with asset_kind md_study_brief
  - missing scientific inputs checklist
  - MD suitability verdict
---

# ScienceSwarm MD Study Design

Use this skill as the first step of the molecular dynamics pipeline when a
scientist wants to know whether and how MD should be used for a programmable
drug, cancer biology, delivery, binding, stability, membrane, or biomolecular
system question.

Do not start from parameters. Start from the scientific decision the user wants
to inform.

## Core Rules

1. Treat MD as a method with limits, not as a default answer.
2. Separate biological goal, simulation question, and claim the user hopes to
   make.
3. Label guidance as `project-literature`, `external-literature`,
   `common-heuristic`, `tool-default`, or `speculative`.
4. Be explicit about uncertainty and missing inputs.
5. Map the desired claim to concrete MD observables before recommending a run.
6. Name what positive, negative, or inconclusive result would change the user's
   biological, therapeutic, or experimental decision.
7. Prefer a durable brain asset over a one-off chat answer when the user wants
   to proceed.

## Questions To Ask

- What biological or therapeutic decision should this simulation inform?
- What molecular system is involved: small molecule, peptide, protein, DNA/RNA,
  nanoparticle, delivery vehicle, membrane, aggregate, or complex?
- What cancer or programmable-therapeutics context matters?
- What objective is being tested: binding pose stability, conformational
  change, structural stability, diffusion, membrane interaction, aggregation,
  delivery, or another question?
- What conclusion would the user like to draw afterward?
- What MD observable would support that conclusion, and what observable would
  argue against it?
- What comparison, control, baseline, or replicate pattern is needed to make
  the result interpretable?
- What result would make the study inconclusive rather than useful?
- What adjacent method would be stronger for the desired claim?
- What structures, sequences, ligands, papers, or prior results are already in
  the project?

## Suitability Verdicts

Return one of:

- `md-fit`: ordinary MD can plausibly answer the scoped simulation question.
- `md-with-caveats`: MD may help, but assumptions or adjacent methods matter.
- `use-adjacent-method-first`: another method should come before MD.
- `under-specified`: the question lacks required scientific inputs.

Adjacent methods can include docking, enhanced sampling, free energy methods,
coarse-grained simulation, QM/MM, structure prediction, assay design, or
experimental validation.

## Output Shape

Produce an `MD Study Brief` with this structure:

```markdown
# MD Study Brief: {study title}

## Research Goal

## Biological / Therapeutic Context

## Simulation Question

## Claim-To-Observable Map

| Desired Claim | MD Observable | Needed Comparison / Control | Decision Threshold | Inconclusive Result |
|---|---|---|---|---|

## MD Suitability Verdict

## Why This Verdict

## Alternatives Considered

| Method | When It Would Be Better | Why It Is Or Is Not First |
|---|---|---|

## Missing Scientific Inputs

| Missing Input | Why It Matters | How To Resolve | Blocking? |
|---|---|---|---|

## Proposed Pipeline Next Step

## Stop Criteria

## Confidence Boundary

What this asset supports:
- ...

What it does not support:
- ...

What would change this recommendation:
- ...
```

Use frontmatter when saving:

```yaml
type: method
asset_kind: md_study_brief
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline]
```

## Stop Conditions

Stop and ask for clarification if the molecular system, desired conclusion, or
simulation objective is unclear. Do not invent a system just to keep the
pipeline moving.
