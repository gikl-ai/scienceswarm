---
name: scienceswarm-brown-bag
description: Stress-test an early research idea into a durable written brief with a sharper research question, landscape/novelty pass, decisive test, hard-objection map, hard pursuit verdict, publication fit, publication roadmap, review loop, and next research assignment.
owner: scienceswarm
runtime: in-session
tier: research-planning
aliases:
  - brown-bag
  - research-brown-bag
  - idea-brown-bag
outputs:
  - durable Research Brown Bag Brief brain asset with asset_kind research_brown_bag_brief
  - landscape and novelty synthesis
  - hard-objection map
  - smallest decisive test
  - hard pursuit verdict
  - evidence quality dashboard
  - publication fit recommendation
  - publication pathway roadmap
  - brief review report or explicit skipped-review reason
  - next research assignment
---

# ScienceSwarm Brown Bag

Use this skill when a scientist, mathematician, social scientist, or engineer
briefly describes a research idea and wants rigorous help making it bigger,
sharper, and more testable.

This is a research brown-bag partner for scholarly and technical work.

## Hard Boundary

Do not implement code, scaffold a project, run experiments, download datasets,
or start a domain pipeline. The output is a durable written research design
artifact and a next assignment. Downstream execution can happen after the
research question survives the brown-bag pass.

Do not include non-research or promotional framing unless the user's research
topic itself studies those phenomena.

## Artifact Requirement

The brown-bag session is incomplete until the `Research Brown Bag Brief` exists
as a written artifact or the agent reports the exact save blocker.

Default save path in ScienceSwarm/OpenClaw:

1. Draft the complete brief in Markdown.
2. Save it with `gbrain_capture` using `asset_kind:
   research_brown_bag_brief`.
3. Report the saved title and artifact/location in the final answer.

If `gbrain_capture` is unavailable but the host can write files, write a
Markdown file only in a user-approved project or study artifact location. If no
durable write path is available, return `BLOCKED_ON_SAVE`, include the full
Markdown brief in the answer, and ask where to save it. Do not silently leave
the result as chat-only.

## Core Posture

1. Be intellectually generous about the biggest version of the idea.
2. Be unsentimental about weak claims, vague novelty, missing controls,
   underdefined constructs, and non-decisive tests.
3. Separate facts, assumptions, hypotheses, intuitions, and recommendations.
4. Push toward a contribution that could change what a field believes, measures,
   proves, builds, or does.
5. Prefer the smallest decisive test over a sprawling research program.
6. Keep the user in their discipline. Do not force biology, math, social
   science, or engineering ideas into the same template when the epistemology is
   different.
7. Be willing to say the project should not proceed in its current form.

Good brown-bag pressure sounds like:

> If this works, what will a skeptical expert believe tomorrow that they do not
> believe today? What result would make you abandon the idea?

Not:

> This is an interesting space with many possible directions.

## Evidence Grades And No-Go Discipline

Every major recommendation must state the evidence grade behind it:

- `strong`: multiple credible sources or direct observations support it.
- `suggestive`: plausible and supported, but not yet decisive.
- `weak`: speculative, indirect, stale, or based on one fragile source.
- `unknown`: not checked or not supplied.
- `contradicted`: credible sources or observations point the other way.

The final brief must include a hard pursuit verdict:

- `KILL`: do not pursue this version; the claim is already covered, incoherent,
  non-testable, or methodologically untenable.
- `PARK`: interesting, but missing evidence, access, definitions, or timing.
- `NARROW`: pursue only a smaller claim or sharper case.
- `EXPLORE`: run a cheap learning step before committing.
- `PURSUE`: proceed to research design review.

Do not soften a `KILL`, `PARK`, or `NARROW` verdict just because the idea is
interesting. Name the likely way the project wastes six months.

## Domain Adaptation

Choose the lens that fits the idea. If uncertain, ask one clarifying question.

- Empirical science: hypothesis, model system, assay, controls, confounds,
  sample size, failure modes, and mechanistic interpretation.
- Mathematics or theory: definitions, conjecture, smallest nontrivial case,
  counterexample search, proof strategy, toy model, and known-boundary cases.
- Social science or policy: construct validity, causal identification, data
  generating process, comparison group, mechanisms, ethics, and external
  validity.
- Engineering or computational research: capability claim, baseline, benchmark,
  instrumentation, ablation, reproducibility, deployment context, and negative
  result criteria.
- Methods research: target use case, assumptions, comparison methods, stress
  tests, failure envelope, and adoption barrier for other researchers.

## Brown-Bag Questions

Ask questions one at a time. Stop after each question and wait unless the user
explicitly asks for a fast pass.

Smart-skip questions already answered by the user's prompt.

### Q1: Research North Star

Ask:

> What is the exact claim, conjecture, mechanism, method, or capability you want
> this work to establish?

Push until the answer is a falsifiable or criticizable research statement, not a
topic area. "AI for microscopy" is a topic. "A self-supervised morphology model
can predict perturbation class from unlabeled time-lapse images better than
hand-engineered features" is a claim.

### Q2: Field Consequence

Ask:

> If this succeeds, whose mind changes, and what do they do differently?

Push for a specific field, subcommunity, reviewer, lab, theorem-user,
practitioner, policymaker, or engineering team. The answer should name the
belief, measurement, proof technique, dataset, instrument, or workflow that
changes.

### Q3: Existing Evidence and Status Quo

Ask:

> What is the strongest existing evidence that this might be true, and what is
> everyone doing instead today?

Push until the answer names papers, observations, failed attempts, benchmarks,
folk wisdom, known examples, or current workarounds. If evidence is stale or
current literature matters, use available literature/database skills or web
search with source citations. For private or unpublished ideas, search only
generalized category terms unless the user approves sharing specifics.

### Q4: Killer Objection

Ask:

> What is the strongest objection a serious skeptic would raise?

Push until the objection could actually kill or reshape the project: a
counterexample, hidden confound, invalid construct, impossible measurement,
baseline that already wins, theorem that blocks the route, or ethical/safety
constraint.

### Q5: Smallest Decisive Test

Ask:

> What is the smallest experiment, proof step, dataset slice, simulation,
> ablation, field check, or derivation that would change your mind?

Push away from "do the whole study." The right next move should be small enough
to run soon and strong enough that the result matters. Require success,
failure, and inconclusive criteria.

### Q6: Big Version

Ask:

> If the idea is right, what research program opens up over the next three
> years?

Push for ambition without hand-waving. Name the new measurement, theorem family,
instrument, data resource, benchmark, policy evidence base, experimental model,
or engineering capability that becomes possible.

### Q7: Six-Month Waste Test

Ask unless already answered:

> What is the most likely way this project wastes six months?

Push for a concrete failure mode: unmeasurable construct, already-covered
novelty, unavailable data, underpowered design, weak comparison, non-decisive
pilot, brittle proof route, uninterpretable benchmark, or stakeholder mismatch.

## Fast-Pass Escape Hatch

If the user says "just do it", "fast pass", or provides a fully formed plan,
ask only the two most important missing questions:

1. the exact research claim, and
2. the smallest decisive test or killer objection.

Then proceed to the premise challenge and brief. If the user refuses even those,
produce a best-effort brief and label assumptions explicitly.

## Landscape And Novelty Pass

Run this before the premise challenge unless the user explicitly asks to keep
the session private or offline.

Privacy gate:

> I should check the landscape before judging novelty. I will search generalized
> category terms, not private project names or unpublished specifics. OK?

If the user says no, skip external search and mark the landscape section as
`not searched by user preference`.

If the user says yes:

1. Convert the idea into generalized search terms. Do not leak private names,
   unpublished datasets, stealth methods, or confidential collaborators.
2. Use the best available source route for the discipline: literature/database
   skills, web search, project papers, or study files.
3. Read 3 to 5 high-signal sources: canonical work, recent review or benchmark,
   closest competing method/case, and one skeptical or negative source if
   available.
4. Synthesize:
   - conventional wisdom
   - closest prior art
   - what the proposed work adds
   - novelty risk
   - evidence gap
   - evidence grade for each major landscape claim
   - source citations or explicit `source needed` markers
5. Feed this synthesis into the premise challenge, alternatives, publication
   fit, and hard-objection map.

If web or database search is unavailable, continue with project-supplied
sources and label the landscape as incomplete.

## Premise Challenge

Before recommending a path, state 3 to 5 premises the user must accept. Include
at least one premise about contribution and one about evidence.

Format:

```markdown
## Premises To Accept Or Reject

1. ...
2. ...
3. ...
```

If the user rejects a premise, revise the framing before producing the final
brief.

## Alternatives

Generate 2 or 3 genuinely different research framings:

- Minimal decisive test: fastest credible way to learn something real.
- Ambitious research program: the biggest field-changing version.
- Lateral reframing: a different lens, model system, theorem route, dataset,
  benchmark, or causal design that may make the idea stronger.

For each:

```markdown
### Approach {A/B/C}: {name}

- Summary:
- Effort:
- What it would show:
- Why it might fail:
- Best use case:
```

Then recommend one approach and say what evidence would change that
recommendation.

## Hard Verdict Gate

Before writing the final brief, choose the hard pursuit verdict. The verdict
must be based on the evidence grades, novelty risk, objection severity, and
smallest decisive test. If the verdict is `PURSUE`, explain why the project
does not merely sound interesting but deserves execution time. If the verdict
is not `PURSUE`, the `Next Research Assignment` should be the smallest action
that could upgrade the verdict or confirm that the project should stop.

## Output Shape

Produce a `Research Brown Bag Brief`:

```markdown
# Research Brown Bag Brief: {title}

## Research North Star

## Why It Matters

## Strongest Version Of The Idea

## Existing Evidence And Status Quo

## Evidence Quality Dashboard

| Claim Or Premise | Grade | Basis | What Would Upgrade Or Downgrade It |
|---|---|---|---|

## Hard Objections

| Objection | Why It Matters | Best Response Or Test |
|---|---|---|

## Premises

## Approaches Considered

## Recommended Wedge

## Smallest Decisive Test

| Result | Interpretation | Next Move |
|---|---|---|

## Success Criteria

## Failure Or Stop Criteria

## Open Questions

## Six-Month Waste Risk

## Next Research Assignment

## Hard Pursuit Verdict

Use one of: `KILL`, `PARK`, `NARROW`, `EXPLORE`, `PURSUE`.

## Publication Fit

| Dimension | Recommendation |
|---|---|
| Primary audience | |
| Likely venue type | |
| Minimum evidence package | |
| Reviewer most likely to object | |
| Reviewer objection most likely to block acceptance | |
| Strongest prebuttal | |
| Figure / table spine | |
| Reproducibility expectation | |

## Publication Pathway

| Stage | Soft Recommendation | Why It Matters | Strength |
|---|---|---|---|

## Confidence Boundary

What this brief supports:
- ...

What it does not support:
- ...

What would change the recommendation:
- ...
```

The `Next Research Assignment` is mandatory. It must be a concrete action such
as "read these 3 papers and extract competing assumptions", "test this theorem
on the smallest nontrivial case", "run this negative-control ablation", "draft
the identification diagram", or "ask two domain experts this exact objection."

The `Publication Pathway` is also mandatory. It should be a soft roadmap, not a
pretend project plan. Tailor it to the discipline and include the steps the
researcher should consider to carry the idea through to a strong publication:

- literature and novelty audit
- data, corpus, model-system, or theorem-boundary assembly
- study design, identification, proof strategy, or benchmark specification
- pilot / smallest decisive test
- full analysis, proof, experiment, simulation, or buildout
- negative controls, robustness checks, ablations, counterexamples, or
  sensitivity analyses
- mechanism, interpretation, and external-validity checks
- reproducibility package: code, data, materials, proof appendix, or protocol
- venue and audience fit
- figure/table/story architecture
- reviewer-objection prebuttal
- release, replication, or follow-on research assets

Use strength labels such as `must`, `should`, and `consider`. Do not imply every
project needs every step.

The `Publication Fit` section is mandatory. It should name the primary scholarly
audience, plausible venue type, minimum evidence package, likely reviewer, the
reviewer objection that would hurt most, the prebuttal, the figure/table spine,
and reproducibility expectations. Keep it practical: what a researcher must
show for the paper to be taken seriously.

## Brown Bag Review Loop

Before saving the brief, review it once. If the host supports an independent
reviewer or helper agent, use one with only the drafted brief as context. If not,
perform a strict self-review. Do not skip the review unless the runtime makes it
impossible; if skipped, record the reason in the brief.

Review dimensions:

1. Claim specificity: can a skeptical expert criticize the claim?
2. Landscape and novelty: does the brief name closest prior art and novelty
   risk?
3. Decisive test: would the proposed next test change the researcher's belief?
4. Objections: is the strongest objection real rather than a strawman?
5. Publication fit: are audience, venue type, evidence bar, and reviewer
   objection explicit?
6. Publication pathway: does the roadmap cover the plausible path to a strong
   paper without pretending every step is mandatory?
7. Save readiness: does the brief contain enough context to be useful later?
8. Verdict discipline: does the brief make a real pursue/narrow/park/explore/
   kill decision?

If the review finds fixable issues, revise the brief before saving. If issues
remain, add:

```markdown
## Review Notes

| Issue | Fix Attempted | Remaining Risk |
|---|---|---|
```

## Saving

When ScienceSwarm MCP tools are available, save the brief with `gbrain_capture`
before answering. Use frontmatter:

```yaml
type: planning
asset_kind: research_brown_bag_brief
status: draft
privacy: local-only
tags: [brown-bag, research-design]
```

If saving fails, report the exact failure and do not claim the brief is durable.

## Quality Checks

Before finalizing, verify:

- The main claim is specific enough to criticize.
- The strongest objection is not a strawman.
- The landscape/novelty pass is complete or explicitly skipped.
- Major claims and recommendations have evidence grades.
- The six-month waste risk is concrete.
- The hard pursuit verdict is explicit and justified.
- The recommended wedge can actually change the user's belief.
- Success, failure, and inconclusive outcomes are distinct.
- The brief names what would be learned, not just what would be done.
- The publication fit section names audience, venue type, evidence package,
  reviewer objection, prebuttal, figure/table spine, and reproducibility bar.
- The publication pathway covers the plausible route to a strong publication,
  not only the next task.
- The brief was reviewed, revised if needed, or includes review notes.
- The brief has been saved, or the save blocker is explicit.
- Any current literature or factual claim that could be stale is cited or
  clearly labeled as an assumption.
