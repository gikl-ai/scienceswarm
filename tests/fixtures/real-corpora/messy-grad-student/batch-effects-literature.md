# Batch effects literature

Quick survey of the scRNA-seq batch-correction landscape.

- **ComBat (Johnson 2007)** — classical empirical Bayes, developed for
  microarrays, still widely used. Assumes Gaussian errors.
- **Harmony (Korsunsky 2019)** — iterative soft-clustering in PCA space.
  Fast, scales well.
- **Seurat integration (Stuart 2019)** — canonical correlation analysis
  plus mutual nearest neighbors to anchor cells across datasets.
- **scVI (Lopez 2018)** — variational autoencoder with batch as a
  conditioning variable. Principled but GPU-hungry.
