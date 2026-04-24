# Chat Speed Timing Report

This document tracks the local `Hi` benchmark used by the OpenClaw chat speed
plan. Every speed-focused PR should append a new measured row instead of
replacing earlier results.

## Benchmark Command

```bash
npx tsx scripts/benchmark-chat-hi.ts \
  --url http://127.0.0.1:3001 \
  --project test \
  --message Hi \
  --timing-artifact \
  --json
```

## Measurements

| Date | Environment | Headers ms | First chunk ms | Total ms | Progress events | Final text sample | Timing artifact |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 2026-04-24 | Local `http://127.0.0.1:3001` | 58 | 58 | 6677 | 14 | `Hi! What would you like help with?` | unavailable (`SCIENCESWARM_CHAT_TIMING` disabled, endpoint returned `404`) |

## Notes

- This baseline streamed `18` total SSE events and completed successfully with
  the `openclaw` backend.
- The timing-artifact endpoint was not available for this run, so deeper phase
  timings were not captured.
- Follow-up speed PRs should add the merged PR number, the changed phase, and
  the new benchmark row here.
