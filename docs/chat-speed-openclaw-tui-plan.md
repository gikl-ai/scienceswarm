# Chat Speed And OpenClaw TUI Transcript Plan

## Goal

Continue improving ScienceSwarm chat without bypassing OpenClaw. Every user turn
must still communicate through the OpenClaw gateway path, but the app should do
less avoidable work before sending the message, expose better timing evidence,
and render progress like the OpenClaw TUI: one ordered live transcript with
plain language, rich markdown emphasis, concise tool summaries, and a working
timer that visibly ticks every second.

## Current Shape

The relevant implementation areas are:

- `src/app/api/chat/unified/route.ts`: server-side chat route, OpenClaw-only
  enforcement, readiness checks, prompt/context assembly, gateway send, artifact
  repair, health endpoint.
- `src/lib/openclaw/gateway-ws-client.ts`: persistent WebSocket gateway client
  and `chat.send` transport that mirrors the OpenClaw TUI.
- `src/hooks/use-unified-chat.ts`: client chat state, SSE parsing, restored
  history, progress entries, thinking/activity merging, and health polling.
- `src/components/research/chat-message.tsx`: assistant bubble rendering,
  progress transcript formatting, markdown handling, media previews, and live
  working timer UI.
- `src/lib/chat-timing-telemetry.ts`: existing timing phase and prompt-size
  telemetry that should become the common measurement contract.

## Non-Goals

- Do not add direct model calls, local shortcut replies, or CLI fallback chat
  transport.
- Do not expose hidden chain-of-thought. The visible "thinking trace" is only
  model or gateway supplied progress text intended for the user.
- Do not create a separate durable chat store outside the gbrain/OpenClaw
  ownership boundary.
- Do not touch `openhands/` unless a later PR proves the issue cannot be fixed
  through the public integration layer.

## Metrics

Each speed PR must report the `Hi` timing after merge, using the same benchmark
script once it exists. Until then, use the current route timing logs and a
manual `/api/chat/unified` call.

Primary metrics:

- End-to-end `Hi` duration from request start to final assistant text.
- Time to first SSE event.
- Time to gateway connect/auth.
- Time to `chat.send` acknowledgement.
- Time to first gateway event.
- Time to first assistant text.
- Total prompt characters by bucket.
- Time spent in readiness, project materialization, file reference merge, and
  artifact repair phases.

## Shared Contracts

### Timing Contract

`ChatTimingLogPayload` remains the canonical timing shape. New phases and
details should be additive and backward compatible. Tests must cover:

- Phase start/end ordering.
- Skipped phases for fast-path turns.
- Prompt bucket totals.
- Emitted benchmark summary for `Hi`.

### Prompt Budget Contract

Prompt budgets use characters because the existing telemetry reports character
counts. PRs may tighten these values when benchmark evidence supports it, but
they must not silently exceed them:

- Simple greetings: `recent_chat_context <= 1_000` characters and
  `workspace_files = 0` characters.
- Project work turns: `workspace_files <= 6_000` characters total and
  `<= 1_500` characters per referenced file summary.
- Any budget trim must be visible in timing detail so reviewers can confirm the
  fast path is intentional, not accidental context loss.

### Progress Contract

`MessageProgressEntry` remains persistable history data. New fields must be
optional so restored older chat threads keep rendering.

Planned fields:

- `kind`: existing `thinking` and `activity` remain valid.
- `source`: optional source such as `gateway`, `agent`, `server`, or `client`.
- `phase`: optional phase label such as `explore`, `write`, `run`, `review`,
  or `waiting`.
- `timestampMs`: optional arrival time used for ordering and elapsed rendering.
- `status`: optional status such as `started`, `running`, `complete`, or
  `failed`.
- `label`: optional concise display text for grouped command rows.

### Transcript Contract

The assistant bubble renders one chronological transcript, not separate
thinking and activity panels. It must:

- Preserve final answer streaming separately from progress events.
- Render progress markdown safely, including bold text and inline code.
- Group read/search/write/run actions under OpenClaw-style section headers.
- Hide verbose raw JSON payloads by default while preserving useful paths,
  commands, and filenames.
- Keep media previews inside the chat bubble width.

## Sequential PR Plan

Each PR below should be one small commit where feasible. The count is not the
goal; small reviewable slices are. After opening each PR, run local validation,
address review feedback, enable auto-merge only when safe, wait for the merge,
then measure and report the `Hi` response time.

1. **Plan PR**
   - Add this plan.
   - Validation: docs-only diff inspection.

2. **Benchmark Script PR**
   - Add a deterministic local script that sends `Hi` through
     `/api/chat/unified` with OpenClaw enabled and records phase timings.
   - Validation: unit test for output parsing plus one local benchmark run.

3. **Timing Artifact PR**
   - Persist the most recent timing payloads in memory behind a dev-only API or
     debug helper so repeated tests can compare runs.
   - The artifact endpoint must be unavailable unless
     `SCIENCESWARM_CHAT_TIMING=1` is set. In production, that flag remains off
     by default and the endpoint must return `404` or `403` without timing
     payloads.
   - Validation: route tests prove bounded retention, disabled-by-default
     access, enabled access only with the flag, and no secret leakage.

4. **SSE Timing Meta PR**
   - Emit timing meta events for request start, readiness complete, gateway ack,
     first gateway event, and final assistant text.
   - Validation: hook test receives ordered meta events.

5. **Health Cache PR**
   - Add a short in-process OpenClaw readiness cache for chat POST requests.
   - Validation: unit test proves back-to-back chats do not re-run the expensive
     probe while stale or failed states are not hidden.

6. **Gateway Warm Path PR**
   - Reuse and pre-warm the OpenClaw WebSocket client when Settings reports the
     gateway is running.
   - Validation: gateway client test proves one socket handles sequential sends.

7. **Readiness Split PR**
   - Split blocking readiness required for chat send from informational health
     metadata only needed by the Settings UI.
   - Validation: route test proves chat only blocks on the minimal OpenClaw
     status.

8. **Greeting Classifier PR**
   - Add a conservative server-side classifier for greetings and simple small
     talk that still sends through OpenClaw but skips artifact-heavy prep.
   - Validation: table tests for greetings, research requests, file references,
     and artifact requests.

9. **Project Materialization Skip PR**
   - Skip project workspace materialization for turns classified as simple
     conversation.
   - Depends on PR #8.
   - Validation: route test proves `project_materialization` is skipped for
     `Hi` and still runs when a project artifact is referenced.

10. **File Reference Skip PR**
    - Avoid file reference merge scans when the message contains no file-like
      tokens and no attachments.
    - Depends on PR #8.
    - Validation: route test proves file scan phase is skipped for `Hi`.

11. **Recent Context Budget PR**
    - Cap or skip recent chat context for simple greetings while preserving it
      for real project work.
    - Depends on PR #8.
    - Validation: prompt bucket test proves greeting prompt context stays within
      the Prompt Budget Contract.

12. **Workspace Files Budget PR**
    - Add a hard prompt-size budget for workspace file summaries.
    - Depends on PR #8.
    - Validation: test proves oversized workspace summaries are trimmed to the
      Prompt Budget Contract and logged rather than silently sent.

13. **Fast Postprocess PR**
    - Skip artifact import repair and media probing for turns that cannot
      produce file artifacts.
    - Depends on PR #8.
    - Validation: route test proves artifact repair phase is skipped for simple
      chat and still runs for media-producing responses.

14. **Server Progress Events PR**
    - Stream clear server phase progress into the existing progress log:
      parsing, checking OpenClaw, sending to OpenClaw, waiting for first token.
    - Validation: hook test proves these entries appear before gateway deltas.

15. **Gateway Event Normalizer PR**
    - Convert raw gateway events into richer progress entries with optional
      phase, source, status, and timestamp fields.
    - Validation: parser tests for `agent`, `chat.delta`, tool, and lifecycle
      events.

16. **Transcript Component Split PR**
    - Extract the OpenClaw-style transcript rendering from `chat-message.tsx`
      into a focused component.
    - Validation: component tests preserve current visible behavior.

17. **Markdown Progress PR**
    - Render bold, inline code, and links in progress narrative safely.
    - Validation: component tests prove markdown displays correctly and raw
      markdown markers are not shown.

18. **Explored Block PR**
    - Render OpenClaw-style `Explored` sections with grouped `Read`, `Search`,
      and file paths instead of raw `Use read: {...}` JSON.
    - Validation: component tests cover read/search grouping and hidden payloads.

19. **Command Summary PR**
    - Render `Run`, `Write`, `Use image_generate`, and embed actions as concise
      summaries with project-relative paths.
    - Validation: component tests cover absolute path stripping and JSON
      compaction.

20. **Working Timer PR**
    - Make `Working (mm ss)` tick once per second while the assistant turn is
      active.
    - Validation: fake-timer component test advances the clock and observes the
      displayed seconds update every second.

21. **Bubble Width PR**
    - Increase assistant bubble media width within the chat column while keeping
      iframes and images responsive on small screens.
    - Validation: component or browser test proves iframe width never exceeds
      the chat container.

22. **Media Refresh PR**
    - Normalize gbrain and OpenClaw canvas media references so refreshed chat
      history still previews supported files.
    - Validation: route/component tests restore an image and iframe after
      history reload.

23. **Activity Copy PR**
    - Tune progress wording to match OpenClaw TUI style: useful plain-language
      bullets, explicit plan updates, and no generic "Thinking... tool call"
      filler.
    - Validation: snapshot-style tests over representative progress entries.

24. **Client Health Poll PR**
    - Remove duplicate or blocking client health probes from the send path and
      keep health polling informational.
    - Validation: hook test proves a chat send does not wait for the health poll.

25. **Double Answer Guard PR**
    - Prevent duplicate final answers when both gateway final and SSE final
      events arrive for the same turn.
    - Validation: hook test emits duplicate finals and asserts one assistant
      message.

26. **End-to-End Smoke PR**
    - Add an automated chat smoke covering `Hi`, progress transcript streaming,
      final answer, and media-safe layout.
    - Validation: smoke test plus local benchmark run.

27. **Timing Report PR**
    - Add a living timing document with before/after measurements from every
      merged PR in this sequence.
    - Validation: docs inspection and benchmark output attached to the PR.

28. **Cleanup PR**
    - Remove obsolete compatibility code once restored histories and tests prove
      the new transcript contract is stable.
    - Validation: full relevant test suite, typecheck, lint, and final `Hi`
      benchmark.

29. **Settings Runtime Propagation PR**
    - Ensure background OpenClaw/OpenHands task launches use the saved Settings
      runtime provider, model, and endpoint instead of defaulting to cloud
      provider names.
    - Validation: route or service test proves an Ollama/gemma4 setting is
      passed into the background task request.

30. **Local Runtime Guardrail PR**
    - When Settings selects a local runtime, reject accidental direct
      `openai/*` provider launches and return an actionable local-runtime error
      instead of an API-key failure.
    - Validation: unit test covers local settings, missing API key, and allowed
      `openai-codex/*` OAuth provider cases.

31. **Background Monitor PR**
    - Keep monitoring launched background tasks and stream status updates back
      into the chat until the task completes, fails, or is cancelled.
    - Validation: mocked background task test proves queued, running, progress,
      complete, and failed states become progress entries.

32. **Background Error Formatting PR**
    - Convert provider, key, connection, and timeout failures into concise
      OpenClaw-style transcript rows with a clear next action.
    - Validation: formatter tests cover missing API key, OpenClaw unreachable,
      model unavailable, and task timeout errors.

33. **OpenClaw TUI Fixture Parity PR**
    - Add representative OpenClaw TUI transcript fixtures and assert the web
      transcript renderer produces matching wording, ordering, and emphasis.
    - Validation: fixture tests cover plan updates, explored actions, command
      completion, media generation, and final answer rows.

34. **Agent Chat Layout Polish PR**
    - Make assistant turns read like an agent console instead of ordinary chat
      bubbles: user text remains clearly authored, while agent progress and
      answers use a wider structured transcript surface.
    - Validation: component/browser test proves user and assistant layouts stay
      distinguishable and responsive.

35. **Timing Visualization PR**
    - Add a compact timing waterfall for the latest chat turn so readiness,
      prompt assembly, OpenClaw gateway, first token, and final text are visible
      without reading logs.
    - Validation: component test renders a sample timing payload and verifies
      phase labels, durations, and total time.

## Merge Order

The exact order is sequential because the user asked for many small PRs with a
measurement after each merge. If parallelization becomes necessary later, only
these groups are safe to overlap after their shared contracts merge:

- Timing and benchmark work: PRs 2 to 4.
- Server speed work: PRs 5 to 13. Within this group, PRs 9 to 13 depend on the
  greeting classifier from PR #8 and must not start before it merges.
- Server-to-client progress bridge: PR #14. This straddles the server route and
  client transcript work, so it must merge after the server-speed sequence and
  before transcript-only rendering PRs.
- Transcript rendering work: PRs 15 to 23.
- Stability and cleanup work: PRs 24 to 28.
- Background-agent runtime and monitoring work: PRs 29 to 32.
- OpenClaw parity, layout, and visualization work: PRs 33 to 35.

## Validation Standard

Every implementation PR must include a test that would fail before the fix or
contract change. For speed PRs, the PR body must include:

- The local benchmark command.
- The latest `Hi` timing before the change when available.
- The latest `Hi` timing after the change.
- Which timing phase changed and why.

For transcript PRs, the PR body must include:

- The representative progress sample used.
- The component or hook tests added.
- Whether persisted history compatibility changed.

## Open Questions To Resolve In PRs

- Whether the benchmark should target the browser UI, the route API, or both.
- Whether OpenClaw gateway events already include enough structured timing to
  avoid client-side inference for first assistant text.
