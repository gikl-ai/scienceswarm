---
name: brain-maintenance
description: Use when the user asks about brain health, brain score, missing embeddings, stale or orphan pages, broken links, citation cleanup, search quality, feature recommendations, or keeping gbrain up to date inside ScienceSwarm.
owner: scienceswarm
runtime: in-session
tools:
  - brain_maintenance
  - brain_search
  - brain_read
  - brain_capture
routes:
  - /api/brain/maintenance
  - /api/brain/status
  - /api/brain/health-report
  - /api/brain/search
secrets:
  - SCIENCESWARM_USER_HANDLE
  - BRAIN_ROOT
---

# brain-maintenance

## Purpose

Keep the user's ScienceSwarm brain healthy and useful. This skill adapts
gbrain v0.10 maintenance ideas to ScienceSwarm's product boundary:
OpenClaw explains and coordinates, OpenHands executes approved work, and
gbrain remains the durable data system.

Use this skill for:
- Brain score or health questions
- Search quality checks after imports or upgrades
- Missing embeddings, stale pages, orphan pages, and dead links
- Citation and evidence cleanup
- Link or timeline extraction requests
- "What gbrain features am I missing?" or "how do I improve my brain?"

## Boundary Rules

1. **gbrain is the store.** Do not create a separate maintenance database,
   notes directory, or OpenClaw-only memory.
2. **OpenClaw talks to the user.** Summaries, recommendations, and approval
   questions are delivered inline in the conversation.
3. **OpenHands executes code or filesystem work.** If the requested fix
   requires scripts, repo edits, bulk file changes, or long-running jobs,
   delegate through the approved OpenHands path.
4. **No upstream autopilot daemon.** Do not run
   `gbrain autopilot --install` from ScienceSwarm. ScienceSwarm owns
   schedules and observability under `$SCIENCESWARM_DIR`; gbrain data stays
   under the configured `BRAIN_ROOT`.
5. **Attribute writes.** If a maintenance action writes to gbrain,
   `SCIENCESWARM_USER_HANDLE` must be set and the write must include
   clear provenance.

## First Response Pattern

For a health or maintenance request:

1. Check `/api/brain/status` for backend, page count, radar freshness, and
   store metadata.
2. Check `/api/brain/maintenance` or the `brain_maintenance` MCP tool for
   ranked maintenance recommendations.
3. Check `/api/brain/health-report` for `source`, `brainScore`,
   `embedCoverage`, stale pages, orphan pages, dead links, and missing
   embeddings.
4. Report the top 1-3 concrete issues. Keep it practical; do not dump every
   metric when one issue dominates.
5. Ask before any bulk rewrite, deletion, embedding refresh, or mass link
   extraction. Small read-only checks can run immediately.

## Maintenance Job Protocol

Use the ScienceSwarm maintenance route for actions the host runner supports:
`extract-links`, `extract-timeline`, `refresh-embeddings`, and
`sync-from-repo`.

1. Start with `POST /api/brain/maintenance` using
   `{ "action": "...", "mode": "dry-run" }`.
   Include `repoPath` for `sync-from-repo` when gbrain does not already have
   a sync repo configured.
2. Summarize the preview: pages scanned, candidates found, warnings, and what
   would change.
3. Ask for explicit approval before a start.
4. If approved, call `POST /api/brain/maintenance` with
   `{ "action": "...", "mode": "start", "previewJobId": "<id>" }`.
5. Poll `GET /api/brain/maintenance?jobId=<id>` until `status` is
   `completed` or `failed`, then report the result.

Do not start a maintenance job without a fresh dry-run preview. If the route
returns that an action is recommendation-only, delegate the manual workflow to
OpenHands instead of trying to run upstream gbrain commands yourself.

## Search Quality Protocol

Use gbrain v0.10 search detail levels deliberately:

- `detail=low` for exact lookup, entity matching, and "do we already have
  this?" checks.
- `detail=medium` for normal troubleshooting and user-facing answers.
- `detail=high` for audit/revise, literature review, program briefs, and
  evidence-heavy synthesis.

When results include `chunkId` and `chunkIndex`, preserve those values in
internal evidence notes and revision plans. They identify indexed chunks in
gbrain. Do not present a bare chunk ID as a citation; pair it with a source
path, title, URL, or page slug.

## Maintenance Actions

### Missing Embeddings

Symptoms:
- Low `embedCoverage`
- Non-empty `missingEmbeddings`
- Search works by keyword but misses semantic matches

Action:
- Tell the user semantic search may be incomplete.
- Run a dry-run `refresh-embeddings` maintenance job and summarize the missing
  chunk count.
- If code or CLI execution is needed today, delegate to OpenHands and keep
  the work scoped to the configured `BRAIN_ROOT`.

### Stale Pages

Symptoms:
- `stalePages` is non-zero
- Timeline has newer evidence than Compiled-Truth

Action:
- Read the affected page before proposing a rewrite.
- Summarize which new evidence is not reflected.
- Ask before updating Compiled-Truth.
- Preserve original timeline entries and source citations.

### Orphan Pages

Symptoms:
- `orphanPages` is non-zero
- Useful pages have no inbound references

Action:
- Search for related pages with `detail=medium`.
- Propose links only when the relationship is real.
- Do not delete orphan pages without explicit confirmation.

### Dead Links

Symptoms:
- `deadLinks` is non-zero
- Pages reference missing slugs

Action:
- Check whether the target was renamed, never assume deletion.
- Prefer repairing the link to removing context.
- Report any ambiguous targets to the user.

### Citation Gaps

Symptoms:
- User asks for citation cleanup
- Audit/revise output has claims without source paths or URLs
- Search evidence has chunk handles but no presentable citation

Action:
- Read the page first.
- Fix citation formatting only when the source is already available.
- Do not invent citations. Flag uncited claims as needing source review.

### Link And Timeline Extraction

Symptoms:
- Link graph is sparse after import
- Timeline entries are present in markdown but absent from structured views

Action:
- Run a dry-run `extract-links` or `extract-timeline` maintenance job, not an
  in-chat rewrite.
- Keep extracted links and timeline entries tied to source pages.
- Ask before running bulk extraction across the entire brain.

## Feature Recommendations

When the user asks what they are missing, turn health and configuration into
recommendations:

- Low embedding coverage -> refresh embeddings before relying on semantic
  search.
- Many stale pages -> compile recent timeline evidence into current truth.
- Many orphan pages -> run a targeted link pass around active projects and
  papers.
- Zero structured links -> preview a link extraction job.
- Zero structured timeline entries -> preview a timeline extraction job.
- Missing sync configuration -> choose a git-backed research folder, then
  preview `sync-from-repo`.
- Missing integrations -> configure only the providers the user actually uses
  before syncing.
- No radar freshness -> configure or restart research-radar.
- Weak citation coverage -> audit high-value papers and critiques first.

Recommendations should be ranked by user value, not by implementation
novelty. Give the smallest useful next action first.

## Anti-Patterns

- Running upstream `gbrain autopilot --install` from ScienceSwarm.
- Mounting `brain.pglite` directly into OpenHands.
- Treating chunk IDs as user-facing citations.
- Bulk-fixing citations, links, or Compiled-Truth without reading pages.
- Deleting pages because they are orphaned.
- Starting long maintenance jobs without telling the user what will change.
