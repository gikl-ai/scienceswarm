# Local Chat Benchmark

Use the local chat benchmark when a change affects OpenClaw chat latency,
progress rendering, or timing instrumentation.

## Run the benchmark

```bash
SCIENCESWARM_CHAT_TIMING=1 npx tsx scripts/benchmark-chat-hi.ts --timing-artifact
```

Useful flags:

- `--url http://localhost:3001` to target a specific local app origin
- `--project project-alpha` to benchmark a different project slug
- `--message "Hi"` to keep the prompt stable across runs
- `--conversation-id benchmark-hi-fixed` when you want deterministic artifact
  matching across repeated local runs

For a machine-readable timing snapshot, run:

```bash
SCIENCESWARM_CHAT_TIMING=1 npx tsx scripts/benchmark-chat-hi.ts --timing-artifact --json | jq '{headersMs, firstChunkMs, totalMs, observedLatencySplit, timingArtifact: .timingArtifact.observedSplit}'
```

The JSON output includes `observedLatencySplit` for the client-visible timing
segments, so automation does not need to derive them from the rounded top-level
latency fields.

## Read the output

- `Headers` is the browser-visible time to initial response headers.
- `First chunk` is the browser-visible time to the first streamed body chunk.
- `Observed split` summarizes the client-visible path:
  - browser request start -> response headers
  - headers -> first streamed chunk
  - first streamed chunk -> completed response
- `Timing artifact` is the server-side timing payload from
  `/api/chat/timing`. It is only available when
  `SCIENCESWARM_CHAT_TIMING=1` is enabled locally.
- `Timing phases` appears when the timing artifact contains server-side
  milestones such as readiness, gateway connect/auth, send acknowledgement,
  first gateway event, and first assistant text.
- `Prompt chars` and `Prompt highlights` help verify that fast-path turns are
  not silently picking up large recent-context or workspace-file payloads.

## Reporting in PRs

When you include benchmark evidence in a PR body, capture:

- the local environment or app origin you used
- whether timing artifacts were enabled
- the final text sample
- the merged PR label or change area tied to the run
