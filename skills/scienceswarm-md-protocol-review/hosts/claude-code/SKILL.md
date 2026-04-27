---
name: scienceswarm-md-protocol-review
description: Review an MD setup before execution and flag blocking assumptions, unsafe defaults, missing controls, reproducibility gaps, and overclaim risks.
---

# ScienceSwarm MD Protocol Review

Use this skill as the pre-run quality gate for an MD setup.

## Workflow

1. Review the study brief, evidence packet, system definition, parameter ledger,
   and execution handoff.
2. Check scientific assumptions, parameter traceability, reproducibility, stop
   conditions, and overclaim risk.
3. Review controls, replicas, convergence expectations, go/no-go criteria, and
   common failure modes with detection signals and rescue actions.
4. Return `approved-to-run`, `approved-with-caveats`, or `blocked`.
5. Produce a `Protocol Review Note` with
   `asset_kind: md_protocol_review_note`.

When the `scienceswarm` MCP tools are available, save the review note with
`gbrain_capture` before answering. Use a clear title, the asset kind above,
the active study, and links or references to the reviewed planning assets.
If saving fails, report the exact save failure and do not present the review as
durable.

Include a `Confidence Boundary` section in the review note.

If the verdict is `blocked`, do not produce runnable commands. Produce required
fixes and questions.
