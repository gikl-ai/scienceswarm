---
name: audit-revise
description: Drive the audit-and-revise flow — ingest → critique → plan → approve → run — for a scientific paper dropped into the ScienceSwarm dashboard. Nine-tool surface locked in plan §1.1.
owner: scienceswarm
runtime: in-session
secrets:
  - SCIENCESWARM_USER_HANDLE
  - STRUCTURED_CRITIQUE_SERVICE_URL
  - STRUCTURED_CRITIQUE_SERVICE_TOKEN
tools:
  - resolve_artifact
  - read_artifact
  - critique_artifact
  - draft_revision_plan
  - approve_revision_plan
  - run_job
  - check_job
  - cancel_job
  - link_artifact
---

# audit-revise

## Purpose

The scientist drops a paper into the ScienceSwarm dashboard and asks for
an audit. This skill guides the manager agent (OpenClaw) through the
four-phase flow that plan §0.1 calls the shared product contract:
ingest → critique → plan + approval → delegated execution. Every
capability output lands in gbrain as a linked page so the existing
`/dashboard/reasoning` and FileTree surfaces can render it without new
routes. Use this skill whenever the user mentions auditing, critiquing,
reviewing, revising, or drafting a cover letter for a paper.

## Tool surface

This skill binds the manager agent to exactly nine tools. Do not call
anything outside this list, even if the ScienceSwarm MCP server exposes
other tools (`brain_search`, `brain_read`, etc. stay reserved for
research-radar and ad-hoc queries).

| Tool | When to call | Must-have preconditions |
|---|---|---|
| `resolve_artifact(project, hint?)` | At the start of every request to find the paper/critique/plan/revision the user is referring to. Always the first call unless the user already gave a slug. | project is set |
| `read_artifact(slug)` | Before `critique_artifact` or `draft_revision_plan` to confirm the artifact's type and current state. | slug returned by `resolve_artifact` |
| `critique_artifact(slug, style?)` | To materialize the first-class critique for a paper. MUST precede `draft_revision_plan`. | `slug` points at a `type: paper` page |
| `draft_revision_plan(parent_slug, critique_slug, scope_hints?)` | After the user has seen a critique and wants a revision plan drafted. MUST come after `critique_artifact`. | a `type: critique` page exists for `parent_slug` |
| `approve_revision_plan(plan_slug)` | Only after the user explicitly approves a plan. Never auto-approve. | plan is `status: draft` |
| `run_job(kind, input_refs, expected_artifacts)` | To dispatch `revise_paper`, `write_cover_letter`, `rerun_stats_and_regenerate_figure`, or `translate_paper`. MUST come after `approve_revision_plan`. | referenced plan is `status: approved` |
| `check_job(handle)` | To surface job progress or final artifact slugs. | `handle` from `run_job` |
| `cancel_job(handle)` | When the user asks to stop a running job. Cooperative flag — the job may take up to 5 s to notice. | `handle` from `run_job` |
| `link_artifact(from, to, relation)` | Only to create structural links between audit-revise artifacts. Relations: `audited_by`, `addresses`, `revises`, `cover_letter_for`. | both slugs are audit-revise artifacts |

## Hard preconditions (never violate)

1. **`critique_artifact` must run before `draft_revision_plan`** whenever
   a critique page does not already exist for the paper. If one exists,
   the agent should still prefer `read_artifact(<critique-slug>)` first
   so the plan references real findings.
2. **`run_job` is refused without an approved plan.** Do not call it if
   the referenced `revision_plan` is not `status: approved`. The tool
   itself enforces this, but you should never even attempt the call.
3. **`approve_revision_plan` waits for the user.** Never approve a plan
   on the user's behalf unless they say so in the current turn.
4. **Hallucinated tool names are forbidden.** If you feel the urge to
   call `get_page`, `put_page`, `upsertChunks`, `traverse_graph`, or
   anything else — stop. Those are gbrain primitives the audit-revise
   flow deliberately doesn't expose.

## Four phases

### 1. Audit

When the user drops a paper or asks "what's wrong with this," tell them
the critique usually takes **8-10 minutes** before you make the call.
No silent spinners. Then:

```
resolve_artifact(project, hint=<paper-title>)
read_artifact(<paper-slug>)                  # confirm type: paper
critique_artifact(<paper-slug>)              # default style: professional
```

Return the brief (1-2 paragraphs from `author_feedback.overall_summary`)
plus a link to `/dashboard/reasoning?brain_slug=<critique-slug>` so the
user can read the full findings. Do not truncate the brief silently.

### 2. Plan + approval

If the user wants a revision plan, draft it after the critique exists:

```
read_artifact(<paper-slug>)
read_artifact(<critique-slug>)
draft_revision_plan(
  parent_slug=<paper-slug>,
  critique_slug=<critique-slug>,
  scope_hints=<what the user said>
)
```

Surface the draft plan to the user with a link to
`/dashboard/reasoning?brain_slug=<plan-slug>`. Say explicitly that the
plan is in `status: draft` and that `run_job` will refuse until they
approve. When the user approves:

```
approve_revision_plan(<plan-slug>)
```

If the user wants to edit findings out or change the scope, re-draft
instead of editing the approved plan.

### 3. Execute

Only after an approved plan. The v1 demo ships four job kinds:

| `kind` | Inputs | Outputs |
|---|---|---|
| `revise_paper` | `paper_slug`, `plan_slug`, `critique_slug` | `type: revision` + revised PDF |
| `write_cover_letter` | `revision_slug`, optional `target_journal` | `type: cover_letter` |
| `rerun_stats_and_regenerate_figure` | `paper_slug`, `data_slug`, `code_slug` | `type: code` (new script) + PNG + stats summary page |
| `translate_paper` | `paper_slug`, `source_lang`, `target_lang` | `type: paper` translation page |

Template:

```
run_job(
  kind="revise_paper",
  input_refs={paper: <slug>, plan: <plan-slug>, critique: <critique-slug>},
  expected_artifacts=["revision"]
)
```

Tell the user the wall time for each kind: `revise_paper` 5-15 min,
`write_cover_letter` 1-3 min, `rerun_stats_and_regenerate_figure`
3-10 min, `translate_paper` 5-20 min. Poll via `check_job(handle)` at
30-60 s intervals, never faster. If the user asks to cancel, call
`cancel_job(handle)`; the runner checks the flag every 5 s.

### 4. Cover letter

After a revision exists the user can ask for a cover letter. Call:

```
run_job(
  kind="write_cover_letter",
  input_refs={revision: <revision-slug>},
  expected_artifacts=["cover_letter"]
)
```

Link the cover letter back to the revision:

```
link_artifact(<cover-letter-slug>, <revision-slug>, "cover_letter_for")
```

## Communication patterns

- **Wall time**: always set expectation BEFORE the long call.
  "Usually 8-10 minutes — I'll ping you when it's ready."
- **Brief**: 1-2 paragraphs. If the critique body is > 500 words, give
  the `overall_summary` and the reasoning-page link.
- **Plan drafts**: render the finding-disposition table as markdown
  inline so the user can scan it; never ask them to click a link to see
  the plan before they approve.
- **Failures**: when a tool returns an error, quote the error message
  verbatim and suggest the next step. Do not rewrite or soften the
  upstream message.
- **Ambiguity**: if `resolve_artifact` returns `{ multiple: [...] }`,
  ask the user which one they mean before proceeding.
- **Verbatim persistence** (principle 6): never complain that the
  critique has duplicates or overlap. That is an upstream service
  issue; file it with the critique service team, not as a workaround
  inside ScienceSwarm.

## Boundary reminders

- Never call tools outside the nine-tool surface above.
- Never write to the workspace directory; that is Bucket A's surface.
- Never start long-running jobs in-process; delegate through `run_job`.
- Never block the user on a silent spinner — always announce wall time.
- Never auto-approve a plan, never resume a cancelled job, never
  retry a failed job without the user saying so.
- Dashboard surfaces you can reference: `/dashboard/project` (FileTree
  + chat), `/dashboard/reasoning?brain_slug=<slug>` (critique + plan
  viewer).
