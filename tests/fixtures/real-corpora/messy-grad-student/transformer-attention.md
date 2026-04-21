---
title: "Vaswani 2017 — Attention is All You Need"
project: ml-transformers
hypothesis: "Attention alone can replace recurrence for sequence modeling"
tags: [transformer, attention, nlp]
---

# Attention is All You Need

The paper that killed RNNs for large-scale NLP. Scaled dot-product attention
with query, key, value matrices, parallelized across a sequence instead of
stepwise. Multi-head attention lets the model attend to different subspaces.

Positional encoding via sine/cosine at different frequencies — later
replaced by learned or rotary embeddings in most descendants.
