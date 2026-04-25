# Chat Speed Timing Report

This document tracks the local `Hi` benchmark used by the OpenClaw chat speed
plan. Every speed-focused PR should append a new measured row instead of
replacing earlier results.

## Benchmark Command

```bash
npx tsx scripts/benchmark-chat-hi.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --json
```

## Generated Row Command

Use the row helper when you want a paste-ready table row instead of formatting
the benchmark JSON by hand:

```bash
npx tsx scripts/benchmark-chat-hi-row.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --pr '#PR' \
  --change-area 'change-area'
```

The helper defaults `--date` to today in UTC and `--environment` to
`Local <origin>`, so only the PR label and changed area are required for the
common local workflow.

## Append Command

Use the append helper when you want the benchmark to update this report file
for you instead of copying the generated row by hand:

```bash
npx tsx scripts/append-chat-benchmark-report-row.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --pr '#PR' \
  --change-area 'change-area'
```

The append helper writes to `docs/chat-speed-timing-report.md` by default,
inserts the new row directly above the `## Notes` section, and, like the row
helper, defaults `--date` to today in UTC and `--environment` to
`Local <origin>`.

## Measurements

| Date | PR | Change area | Environment | Headers ms | First chunk ms | Shared tick | Total ms | Progress events | Final text sample | Timing artifact |
| --- | --- | --- | --- | ---: | ---: | :---: | ---: | ---: | --- | --- |
| 2026-04-24 | baseline | initial local benchmark | Local `http://localhost:3001` | 58 | 58 | yes | 6677 | 14 | `Hi! What would you like help with?` | unavailable (`SCIENCESWARM_CHAT_TIMING` disabled, endpoint returned `404`) |

## Notes

- This baseline streamed `18` total SSE events and completed successfully with
  the `openclaw` backend.
- `Headers ms` and `First chunk ms` matched in this run because the first SSE
  chunk arrived in the first readable-stream pull after the response opened.
  Future rows may show a gap there; equal values are still a valid measurement.
- `Shared tick` mirrors the benchmark JSON field
  `firstChunkSharedHeadersTick`, which is `true` when the rounded header and
  first-chunk timings land on the same millisecond tick.
- The timing-artifact endpoint was not available for this run, so deeper phase
  timings were not captured.
- Follow-up speed PRs should add the merged PR number, the changed phase, and
  the new benchmark row here.
- Prefer the append helper above when you want the benchmark command to update
  this report file directly.
- Prefer the generated-row command above when you want a paste-ready row
  without modifying the report file.
- Row template:
  ``| YYYY-MM-DD | #PR | change-area | Local `http://localhost:3001` | headers | first-chunk | yes/no | total | progress-events | `final text sample` | timing artifact |``
