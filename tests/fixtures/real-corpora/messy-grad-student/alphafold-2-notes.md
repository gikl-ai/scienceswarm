---
title: "AlphaFold 2 notes"
project: protein-structure
hypothesis: "Coevolution signal is sufficient for accurate structure prediction"
---

# AlphaFold 2 notes

The evoformer is the interesting block — operates on a pair representation
(residue × residue) and an MSA representation (sequence × residue) and
repeatedly exchanges information between them via row/column attention.

Structure module uses invariant point attention to produce 3D coordinates
that are equivariant to global rigid transformations.

Key insight: the model is trained end-to-end from sequence to structure,
and the intermediate representations (pair distances, torsion angles) are
supervised directly.
