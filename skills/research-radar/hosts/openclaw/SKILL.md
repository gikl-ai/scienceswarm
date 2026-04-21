---
name: research-radar
description: Every N minutes, scan the scientist's tracked topics, query gbrain for relevant signals, synthesize a personalized briefing, and write it back to gbrain as a Timeline entry on each topic's concept page plus a briefings/ summary page.
owner: scienceswarm
schedule: "*/30 * * * *"
schedule_env_var: SCIENCESWARM_RADAR_INTERVAL_MINUTES
runtime: separate-node-process
entry: scripts/run-research-radar.ts
secrets:
  - OPENAI_API_KEY
  - SCIENCESWARM_USER_HANDLE
  - BRAIN_ROOT
health_checks:
  - BRAIN_ROOT exists and is gbrain-initialized (PGLite db present)
  - SCIENCESWARM_USER_HANDLE is set (writes are attributed)
  - OPENAI_API_KEY (or configured LLM provider) is reachable
  - last successful run is within 2x the schedule interval
outputs:
  - one Timeline entry per concept page touched
  - one briefing summary page under briefings/<date>-<radar-id>
  # TODO(lane-2): one run-status page at radar/run-<timestamp>.md.
  # Not written by the current Lane 1 runner; the .radar-last-run.json
  # pointer below covers the freshness/visibility need for now.
  - a last-run pointer at <BRAIN_ROOT>/.radar-last-run.json that
    /api/brain/status reads to surface freshness on the dashboard
---

# research-radar

## Purpose

The Research Radar is ScienceSwarm's signature scientist UX: every 30 minutes it
sweeps the world for new papers, posts, releases, and pre-prints relevant to
the scientist's tracked topics, scores them against the brain's current
context, synthesizes a "what matters today" briefing, and files the result
back into gbrain so future searches and briefings see it as first-class
memory.

Phase B of the gbrain pivot re-homes the radar from a Next.js cron-in-the-route
shape into a **gbrain
skill** that runs as a **separate node process** outside the Next.js dev
server. This is decision 1A from the spec: hot paths (search, capture)
stay in-process via the runtime bridge; long-running skills run as their
own processes so a crash in one cannot take the dashboard down with it.

## Trigger

ScienceSwarm schedules this skill from the host process started by
`start.sh` (or, in development, manually via `npm run radar:run`). The
default interval is every 30 minutes; override via
`SCIENCESWARM_RADAR_INTERVAL_MINUTES`.

## Steps

1. **Resolve the user.** Call `getCurrentUserHandle()` from
   `src/lib/setup/gbrain-installer.ts`. If `SCIENCESWARM_USER_HANDLE` is unset,
   abort immediately with a clear message — every brain write must be
   attributed (decision 3A).

2. **Open a gbrain runtime engine.** Use `createRuntimeEngine` from
   `src/brain/stores/gbrain-runtime.mjs` with `{ engine: "pglite",
   database_path: <BRAIN_ROOT>/db }`. Call `engine.connect(...)` and
   `engine.initSchema()`.

3. **Enumerate tracked concepts.** Read radar configs from disk
   (`<BRAIN_ROOT>/radar/*.json`) via the existing `src/lib/radar/store.ts`
   helpers. Each radar carries the topics, sources, and channels.

4. **Run the radar pipeline.** Hand the radar config to the existing
   `runRadarPipeline` from `src/lib/radar/pipeline.ts`. The pipeline:
   - fetches signals from each enabled source via the production fetchers
     (arxiv, semantic-scholar, reddit, RSS, browse adapters);
   - ranks signals against tracked topics using the brain's current
     gbrain-backed search results. Use `detail=medium` for routine topic
     matching and `detail=high` when generating evidence-heavy briefings;
     preserve `chunkId` / `chunkIndex` in internal evidence notes when
     present (`src/brain/search.ts` is now a gbrain-first shim courtesy of
     Track C);
   - synthesizes a briefing via the configured LLM (one retry on transient
     failure);
   - emits dashboard + telegram-formatted bodies.

5. **Write the briefing back to gbrain.** For each radar processed:
   - `engine.putPage("briefings/<date>-<radar-id>", { ... })` with the
     synthesized body as Compiled-Truth.
   - For every concept whose name appears in the briefing, append a
     `engine.addTimelineEntry(concept_slug, { date, source: "research-radar",
     summary, detail })` so the concept page accumulates a history of
     radar touches.
   - `engine.addLink(briefing_slug, concept_slug, "radar-touch", "supports")`
     so the back-link graph shows which briefings mention which concepts.

6. **Write the run-status page.** `engine.putPage("radar/run-<timestamp>",
   { ... })` with imported counts, errors per source, and the briefing slug.
   _TODO(lane-2): the current Lane 1 runner does not yet write this page; the
   `.radar-last-run.json` pointer in step 7 covers the visibility need for
   now. Wire this up when the multi-radar refactor lands._

7. **Emit the last-run pointer.** Write
   `<BRAIN_ROOT>/.radar-last-run.json` with the schema:
   ```json
   {
     "timestamp": "2026-04-13T08:00:00.000Z",
     "concepts_processed": 5,
     "errors_count": 0,
     "schedule_interval_ms": 1800000
   }
   ```
   This file is the visibility hook for `/api/brain/status` — TODO #2 from
   the eng review. The status route reads it on every request and reports
   `radar.stale = true` when `age_ms > 2 * schedule_interval_ms`, which
   the dashboard surfaces as a warning chip.

8. **Dispose the engine.** `engine.disconnect()` in a `finally` block so
   the PGLite connection is always released.

## Error handling

- **LLM failure (rate limit, timeout, parse error)** — retry once with a
  short backoff, then log the error, skip the affected concept, and
  continue to the next concept. The run still emits a partial last-run
  pointer with `errors_count > 0`.
- **gbrain write failure** — abort the current concept's Timeline update,
  record the error in the run-status page, and continue. Never let one
  bad write stop the run.
- **No tracked concepts (empty radar dir)** — log a no-op event and exit
  cleanly with `concepts_processed: 0`. The status route still reports
  the run as fresh; "fresh and empty" is a valid state.
- **Missing SCIENCESWARM_USER_HANDLE** — fail loudly at startup before any
  network or DB I/O. The runner exits 1 and the cron logs the message;
  the next dashboard load surfaces `radar.stale = true` because the
  pointer file was never updated.
- **BRAIN_ROOT missing or not gbrain-initialized** — fail loudly with the
  same recovery hint the installer emits ("run `npm run install:gbrain`").
- **Engine connect failure** — exit 1 without writing the pointer.

## Skill runner contract

- Runs as a **separate node process**, not inside Next.js. The dev shortcut
  is `npm run radar:run` which `tsx`-loads `scripts/run-research-radar.ts`.
- Exits `0` on success (including empty-radar success), `1` on fatal
  startup error, `2` on partial-run completion (some concepts errored).
- Writes the `.radar-last-run.json` pointer **before** exiting on a
  successful or partial run, so the freshness check sees the latest
  attempt regardless of how many concepts errored.
- `stdout` — structured JSON events, one per concept processed plus a
  final `summary` event. The cron harness can stream this into
  observability without parsing free text.
- `stderr` — human-readable errors and stack traces.

## Visibility on the dashboard

`/api/brain/status` returns a `radar` field shaped:

```json
{
  "radar": {
    "last_run": "2026-04-13T08:00:00.000Z",
    "concepts_processed": 5,
    "errors": 0,
    "age_ms": 120000,
    "stale": false
  }
}
```

The dashboard's brain-overview card reads this and displays "Radar last
run: N minutes ago", flipping to a warning tone when `stale === true`.
This closes TODO #2 from the Phase A eng review (the silent-failure
mode where a crashed skill runner used to be invisible to the UI).

## Why a separate process

Phase A's eng review identified one silent-failure mode: a crash in a
long-running cron job inside Next.js can take down a route handler
without surfacing in the dev server logs. Spec decision 1A is the
fix: long-running skills get their own process. The runner shares the
exact same body code (`src/lib/radar/skill-runner.ts`) as any in-process
caller would use, so the only thing that's "new" here is the launch
mode plus the freshness pointer the API route reads.
