---
name: scienceswarm-evidence-triangulation
description: Cross-check a scientific, mathematical, or engineering claim across independent primary sources before acting on it.
---

# ScienceSwarm Evidence Triangulation

Use this skill when a user needs a high-signal answer to a technical claim and
plain prompting would likely overfit to one source or one interpretation.

## Workflow

1. Restate the claim and define the exact question to verify.
2. Gather at least three independent primary or official sources.
3. Extract the strongest supporting and contradicting evidence from each.
4. Distinguish observed fact from inference.
5. Return a confidence-weighted recommendation and the main open question.

## Output shape

- `Claim`
- `Best supporting evidence`
- `Best contradicting evidence`
- `Confidence`
- `Recommendation`
