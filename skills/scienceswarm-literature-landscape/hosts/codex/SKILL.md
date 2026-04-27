---
name: scienceswarm-literature-landscape
description: Map the literature around a research idea using supplied and searched sources, identifying source sufficiency, canonical anchors, closest prior art, frontier work, disagreements, novelty threats, gaps, and publishable positioning.
owner: scienceswarm
runtime: in-session
tier: research-planning
aliases:
  - literature-landscape
  - research-landscape
  - lit-landscape
outputs:
  - Literature Landscape Map brain asset with asset_kind literature_landscape_map
  - source corpus table
  - source sufficiency verdict
  - prior-art and novelty map
  - read-next plan
---

# ScienceSwarm Literature Landscape

Use this skill when the user wants to understand the scholarly landscape around
a research idea, method, claim, dataset, theorem, system, or empirical setting.
The goal is not a generic literature review. The goal is to position the
research idea: what is known, what is contested, what is adjacent, what is
already claimed, and what gap remains scientifically plausible.

## Source And Search Boundary

Prefer primary sources: papers, books, standards, datasets, trial records,
official documentation, working papers, proceedings, preprints, registered
reports, or direct technical artifacts. Reviews and textbooks are useful for
orientation but should not be the only evidence for novelty.

If live search tools are available and the topic is not private or sensitive,
search current literature. If the idea is private, sensitive, embargoed, or
commercially confidential, ask before sending detailed search terms outside the
local context. If needed, use generalized search terms that hide the user's
specific angle.

If live search is unavailable, proceed only from supplied sources and clearly
label the output `SUPPLIED_SOURCES_ONLY`. Do not make current-literature claims
without either search results or supplied sources.

Search status is not enough. Also give a source sufficiency verdict:

- `SUFFICIENT_TO_POSITION`: enough close sources were checked to make a
  defensible positioning recommendation.
- `PARTIAL_BUT_USEFUL`: enough to guide the next reading/design step, but not
  enough to claim novelty.
- `NOT_ENOUGH_EVIDENCE_TO_POSITION`: the corpus is too thin, stale, or broad.
- `BLOCKED_ON_ACCESS`: key sources, databases, or full texts are unavailable.

Default save path in ScienceSwarm/OpenClaw:

1. Draft the full map in Markdown.
2. Save it with `gbrain_capture` using `asset_kind:
   literature_landscape_map`.
3. Report the saved title and artifact/location in the final answer.

If `gbrain_capture` is unavailable but the host can write files, write a
Markdown file only in a user-approved project or study artifact location. If no
durable write path is available, return `BLOCKED_ON_SAVE`, include the complete
Markdown map, and ask where to save it.

## Review Posture

Be skeptical about novelty. The user needs to know the strongest prior-art
threats before investing months of work.

Core instincts:

1. Closest prior art matters more than a long bibliography.
2. A gap is not publishable unless it supports a sharper claim.
3. Recent papers may have moved the field past the user's framing.
4. Disagreements are opportunities only when the proposed design can adjudicate
   them.
5. Do not inflate novelty. State what is incremental, derivative, or already
   done.
6. Separate "important literature to read" from "literature that changes the
   research design."
7. Prefer a short list of novelty-threatening sources over a long bibliography.

## Evidence Grades

Grade every major landscape and novelty claim:

- `strong`: multiple close, credible sources support it.
- `suggestive`: supported but incomplete or partly indirect.
- `weak`: based on thin, stale, broad, or secondary evidence.
- `unknown`: not checked.
- `contradicted`: credible sources point against it.

## Workflow

### Step 1: Clarify The Search Target

Rewrite the idea as:

- research claim or question
- discipline or field
- object of study
- method or evidence type
- likely keywords and synonyms
- likely adjacent fields
- what would count as "already done"

### Step 2: Search Strategy

Build a search plan with at least three query families when possible:

- exact concept or method
- adjacent terminology or older terminology
- competing explanations, rival methods, or neighboring disciplines

Record the query log, inclusion criteria, exclusion criteria, and stop rule.
Do not claim the field is mapped without saying why the search was enough.

Use domain-appropriate sources. Examples:

- biomedical and life sciences: PubMed, bioRxiv, medRxiv, Crossref, OpenAlex
- computer science and engineering: arXiv, ACM, IEEE, Semantic Scholar,
  conference proceedings, standards
- social science and economics: SSRN, NBER, RePEc, SocArXiv, journals,
  datasets, official statistics
- mathematics: arXiv, MathSciNet or zbMATH when available, journals, books,
  theorem/proof references
- humanities or qualitative fields: books, journals, archives, bibliographies,
  field-defining essays

### Step 3: Build The Corpus

Create a concise source corpus:

```markdown
| Source | Type | Source Tier | Why It Matters | Relationship To Idea | Evidence Grade |
|---|---|---|---|---|---|
```

Use source tiers:

- `T1`: closest prior art, primary evidence, canonical proof, direct dataset,
  or official technical artifact.
- `T2`: adjacent primary source, benchmark, method paper, or high-quality
  review that changes positioning.
- `T3`: background, commentary, broad review, blog, or source useful only for
  orientation.

### Step 4: Map The Field

Identify:

- canonical anchors
- closest prior art
- current frontier
- schools of thought or method families
- datasets, benchmarks, cases, systems, or proof techniques the field relies on
- live disagreements
- neglected cases or assumptions

Separately name the 3 to 7 sources most likely to make the user's idea less
novel. These are the novelty threats; they matter more than general background.

### Step 5: Novelty And Positioning

Classify the idea:

- `CLEAR_GAP`: important gap not addressed by closest sources.
- `REFRAMING`: similar materials exist, but the user's framing may be new.
- `METHOD_TRANSFER`: method exists elsewhere and may transfer to this domain.
- `INCREMENTAL`: useful extension but contribution must be narrowed.
- `CROWDED`: many close papers; needs a stronger wedge.
- `ALREADY_DONE`: closest prior art appears to cover the claim.
- `UNCLEAR`: source coverage is insufficient.

For each classification, state the evidence.

### Step 6: Research Design Implications

Translate the literature map into design advice:

- claim to keep
- claim to narrow
- claim to avoid
- evidence the field will expect
- method or comparison required by prior art
- first papers to read
- expert audience most likely to care
- likely reviewer objection

## Required Output

Produce a `Literature Landscape Map`:

````markdown
# Literature Landscape Map: {title}

## Scope

## Search Status

Use one of: `SEARCHED_CURRENT_SOURCES`, `SUPPLIED_SOURCES_ONLY`,
`BLOCKED_ON_SEARCH`.

## Source Sufficiency Verdict

Use one of: `SUFFICIENT_TO_POSITION`, `PARTIAL_BUT_USEFUL`,
`NOT_ENOUGH_EVIDENCE_TO_POSITION`, `BLOCKED_ON_ACCESS`.

## Search Strategy

| Query Family | Terms / Sources | Purpose | Result |
|---|---|---|---|

## Search Audit

| Item | Detail |
|---|---|
| Inclusion criteria | |
| Exclusion criteria | |
| Stop rule | |
| Known blind spots | |

## Source Corpus

| Source | Type | Source Tier | Why It Matters | Relationship To Idea | Evidence Grade |
|---|---|---|---|---|---|

## Canonical Anchors

## Closest Prior Art

| Source | Overlap | Difference | Threat To Novelty | Evidence Grade | Design Implication |
|---|---|---|---|---|---|

## Top Novelty Threats

| Source | Why It Threatens Novelty | What Would Distinguish The New Work |
|---|---|---|

## Current Frontier

## Schools Of Thought Or Method Families

## Live Disagreements

| Disagreement | Main Positions | What Evidence Would Decide It | Relevance |
|---|---|---|---|

## Novelty And Gap Assessment

Use one of: `CLEAR_GAP`, `REFRAMING`, `METHOD_TRANSFER`, `INCREMENTAL`,
`CROWDED`, `ALREADY_DONE`, `UNCLEAR`.

## Positioning Options

| Option | Contribution Claim | Evidence Needed | Risk |
|---|---|---|---|

## Claims To Avoid

## Design Implications

## Read Next

| Priority | Source | Why Read It Now |
|---|---|---|

## Open Questions
````

## Quality Checks

Before finalizing, verify:

- The map distinguishes closest prior art from general background.
- The map names a source sufficiency verdict and search blind spots.
- The source corpus includes tiers and evidence grades.
- The top novelty threats are explicit.
- Current-literature claims are backed by live search or supplied sources.
- The novelty verdict is explicit and evidence-based.
- The user gets concrete design implications, not just bibliography.
- Private or sensitive ideas were not searched externally without consent.
- The final map is saved, or the save blocker is explicit.

## Saving

When ScienceSwarm MCP tools are available, save the map with `gbrain_capture`
before answering. Use frontmatter:

```yaml
type: research
asset_kind: literature_landscape_map
status: draft
privacy: local-only
tags: [literature-landscape, novelty, prior-art]
```

If saving fails, report the exact failure and do not claim the map is durable.
