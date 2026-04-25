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

## Measurements

| Date | Environment | Headers ms | First chunk ms | Shared tick | Total ms | Progress events | Final text sample | Timing artifact |
| --- | --- | ---: | ---: | :---: | ---: | ---: | --- | --- |
| 2026-04-24 | Local `http://localhost:3001` | 58 | 58 | yes | 6677 | 14 | `Hi! What would you like help with?` | unavailable (`SCIENCESWARM_CHAT_TIMING` disabled, endpoint returned `404`) |

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
