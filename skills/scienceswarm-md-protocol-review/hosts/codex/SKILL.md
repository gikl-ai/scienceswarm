---
name: scienceswarm-md-protocol-review
description: Review an MD setup before execution and flag blocking assumptions, unsafe defaults, missing controls, reproducibility gaps, and overclaim risks.
---

# ScienceSwarm MD Protocol Review

Use this skill when an MD execution plan needs a scientific and reproducibility
review before code or simulation work starts.

## Workflow

1. Compare the handoff against upstream MD assets.
2. Identify blocking issues, caveats, unsafe defaults, missing controls, and
   overclaim risks.
3. Check whether parameters are traceable to evidence or clearly labeled
   heuristics.
4. Produce a `Protocol Review Note` with
   `asset_kind: md_protocol_review_note`, a verdict, and a
   `Confidence Boundary`.

`blocked` means execution stops.
