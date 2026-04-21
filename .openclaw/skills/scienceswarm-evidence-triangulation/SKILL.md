---
name: scienceswarm-evidence-triangulation
description: Cross-check a scientific, mathematical, or engineering claim across independent primary sources before acting on it.
---

# ScienceSwarm Evidence Triangulation

Use this skill when the user asks whether a technical claim is true, mature,
safe, or worth acting on and the answer should come from multiple sources
rather than one confident paragraph.

## Workflow

1. Rewrite the claim in operational terms so the check has a clear scope.
2. Pull at least three independent sources, preferring primary papers,
   standards, official docs, trial records, or direct datasets.
3. Separate what all sources agree on from where they conflict.
4. Explain confidence, unknowns, and what new evidence would change the answer.
5. End with a recommendation that matches the evidence strength.

## Output shape

- `Claim`
- `Agreement`
- `Conflicts`
- `Confidence`
- `Recommendation`
