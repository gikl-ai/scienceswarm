---
name: scienceswarm-md-system-definition
description: Define the exact molecular system for an MD study, including entities, structures, states, cofactors, protonation, membranes, ions, and preparation risks.
owner: scienceswarm
runtime: in-session
tier: molecular-dynamics-pipeline
aliases:
  - md-system
outputs:
  - Molecular System Definition brain asset with asset_kind md_system_definition
  - unresolved system choices
  - preparation risk list
---

# ScienceSwarm MD System Definition

Use this skill before parameter planning. The goal is to define exactly what is
being simulated so later skills do not hide scientific uncertainty inside
force-field or setup defaults.

## Inputs

- MD Study Brief.
- Evidence Grounding Packet.
- User-provided structures, sequences, ligands, membranes, or delivery vehicle
  notes.
- PDB, UniProt, ChEMBL, or other database identifiers when available.

## Define These Dimensions

- Molecular entities: protein, peptide, DNA/RNA, ligand, nanoparticle,
  membrane, delivery vehicle, complex, or aggregate.
- Structure source, resolution or confidence, chain IDs, missing residues, and
  missing atoms.
- Mutations, isoforms, cofactors, metals, post-translational modifications,
  nucleotide state, and bound partners.
- Ligand identity, charge, stereochemistry, tautomer, and protonation state.
- pH, ionic strength, salt identity, and physiological context assumptions.
- Membrane composition, leaflet asymmetry, or delivery vehicle composition when
  relevant.
- Cancer or programmable-therapeutics context that changes system choice.

## Output Shape

Produce a `Molecular System Definition`:

```markdown
# Molecular System Definition: {study title}

## System Summary

## Entities

| Entity | Identity | Source | State | Confidence | Notes |
|---|---|---|---|---|---|

## Structure And Preparation

## Protonation, Charge, Cofactors, And Ions

## Membrane / Solvent / Environment

## Cancer Or Therapeutic Context

## Unresolved Choices

| Choice | Why It Matters | Options | Blocking? |
|---|---|---|---|

## Preparation Risks

## Downstream Parameter Implications

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
asset_kind: md_system_definition
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline, system-definition]
```

## Stop Conditions

Stop if molecular identity, charge/protonation, required cofactors, membrane
composition, or structure provenance is unknown and material to the simulation
question.
