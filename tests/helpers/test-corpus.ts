/**
 * Inline test corpus — small set of research fixtures for testing
 * import, search, and briefing flows.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CorpusFile {
  relativePath: string;
  content: string;
}

export const AI_RESEARCHER_CORPUS: CorpusFile[] = [
  {
    relativePath: "notes/sae-ideas.md",
    content: `---
title: SAE Research Ideas
tags: [sparse-autoencoders, mechanistic-interpretability]
---

# SAE Research Ideas

The key question is whether TopK activation works better than L1 penalty.

## Hypothesis
L1 penalty creates a smoothness bias that suppresses rare features.
TopK preserves rare feature activation patterns.

## Next steps
- Run feature frequency distribution analysis
- Compare TopK vs L1 on Pythia-70M
`,
  },
  {
    relativePath: "notes/meeting-2026-03.md",
    content: `---
title: Lab Meeting March 2026
date: 2026-03-15
tags: [meeting, interpretability]
---

# Lab Meeting - March 15

Attendees: Dr. Smith, Alice, Bob

## Decisions
- Prioritize feature splitting experiments this sprint
- Order compute allocation for TopK runs

## Follow-ups
- Alice to run probing classifier baselines by Friday
- Bob to review Bricken et al. Section 4.2 methodology
`,
  },
  {
    relativePath: "notes/assay-drift.md",
    content: `---
title: Assay Drift Observations
date: 2026-03-20
tags: [observation, experiment]
---

# Assay Drift

The fresh batch fixed the signal drift. Might be storage temperature,
not sequence design. Need to run a controlled comparison.

Previous batch stored at 4C for 3 weeks. New batch stored at -20C.
`,
  },
  {
    relativePath: "papers/topk-saes.md",
    content: `---
title: "Scaling and Evaluating Sparse Autoencoders"
authors: [Gao et al.]
year: 2024
arxiv: "2406.04093"
type: paper
tags: [sparse-autoencoders, TopK, scaling]
---

# Scaling and Evaluating Sparse Autoencoders

This paper introduces TopK sparse autoencoders. The TopK activation function
directly controls sparsity by keeping only the top K activations per input.

Key finding: TopK SAEs outperform L1-penalized SAEs at equivalent sparsity
levels across multiple metrics including loss recovered and downstream task
performance.
`,
  },
  {
    relativePath: "data/probe-results.csv",
    content: `model,layer,accuracy,f1_score,method
pythia-70m,6,0.82,0.79,linear-probe
pythia-70m,12,0.91,0.88,linear-probe
pythia-70m,6,0.85,0.83,topk-sae
pythia-70m,12,0.94,0.92,topk-sae
`,
  },
];

export function writeCorpusToDisk(corpusDir: string, files: CorpusFile[] = AI_RESEARCHER_CORPUS): void {
  for (const file of files) {
    const fullPath = join(corpusDir, file.relativePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, file.content, "utf-8");
  }
}
