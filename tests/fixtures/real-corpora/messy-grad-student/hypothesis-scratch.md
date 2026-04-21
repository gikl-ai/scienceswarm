# Hypothesis scratch

Half-formed ideas, not ready to promote to real hypotheses yet.

1. Zero-inflation in scRNA-seq is partly technical dropout and partly
   real biological sparsity. Separating the two should improve any
   downstream model.
2. The first two PCs of a scRNA-seq dataset are usually dominated by
   cell-cycle phase and mitochondrial fraction. Regressing those out
   before clustering might help. (Maybe. Contested.)
3. CRISPR screens and scRNA-seq should be done in the same experiment
   more often — perturb-seq style — to get mechanism alongside phenotype.
