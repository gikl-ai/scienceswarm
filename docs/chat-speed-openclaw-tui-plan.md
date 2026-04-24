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

## Codex Reference Learnings

A local Codex checkout is useful as a reference for mechanics and information
density, even though it is primarily a TUI rather than a browser chat surface.
The concrete patterns worth borrowing are:

- `codex-rs/tui/src/status_indicator_widget.rs`: a dedicated run-state widget
  owns the spinner, elapsed timer, interrupt hint, and short inline context on
  one stable line. The transcript is not responsible for faking this state from
  plain strings.
- `codex-rs/tui/src/bottom_pane/mod.rs` and `codex-rs/tui/src/chatwidget.rs`:
  status lifecycle is explicit. The UI shows, hides, pauses, and restores the
  run-state surface as streaming and tool phases change, instead of relying on
  ad hoc bubble-local heuristics.
- `codex-rs/tui/src/markdown_render.rs`: transcript rendering is real markdown,
  including lists, links, code blocks, emphasis, and local path normalization.
  This is richer than the current ScienceSwarm `renderInlineMarkdownLite`
  approach.
- `codex-rs/app-server-protocol/src/protocol/v2.rs`: the transport exposes
  structured realtime transcript deltas and structured MCP tool progress
  notifications. That allows the UI to render a coherent activity stream
  without reverse-engineering raw strings.
- `codex-rs/tui/src/app_backtrack.rs` and transcript overlay surfaces:
  transcript is treated as a first-class artifact users can inspect in full.
  The web analogue should be a single in-order transcript with an optional
  expanded transcript view, not separate thinking/activity panels.

ScienceSwarm should adapt these ideas to the web UI rather than mimic terminal
layout literally. The goal is the same information hierarchy and timing
behavior: stable run-state, structured live progress, rich markdown, compact
tool summaries, and clear separation between transient activity and final
assistant output.

## Current Gap Summary

Compared with the Codex reference and the current ScienceSwarm web UI:

- Assistant turns still read like wide dashboard cards because
  `chat-message.tsx` mixes bubble chrome, task rails, step cards, pills, and
  transcript rows inside one large surface.
- Run-state is duplicated across multiple places: the page-level "Thinking"
  indicator, the in-bubble `Working (...)` row, and phase or step widgets. The
  Codex reference keeps this information on one primary run-state surface.
- The hook still manufactures too many low-signal progress lines because it
  stores both legacy `activityLog` and richer `progressLog`, and it promotes
  timing and lifecycle text into the visible transcript.
- Progress markdown is still markdown-lite, so headings, lists, fenced code,
  links, and path formatting are much flatter than the reference transcript.
- Transcript inspection is not yet treated as a first-class view over the same
  stream. The compact chat lane and any future expanded transcript need to
  derive from one ordered event sequence.

## Speed And Communication Differences

The largest transport and latency differences versus the Codex reference are:

- Codex clients consume typed live notifications from an already-running app
  server connection, including agent message deltas, reasoning summary deltas,
  realtime transcript deltas, and MCP tool progress. ScienceSwarm currently
  sends a browser `POST /api/chat/unified`, then the Next.js route translates
  OpenClaw gateway events into SSE frames before the browser reconstructs them.
- ScienceSwarm still performs route-local work before the first meaningful
  assistant event can arrive: readiness resolution, optional workspace file
  context assembly, artifact-only revision checks, and phase snapshot emission.
  That is correct behavior for project work, but it is expensive compared with
  Codex’s thinner turn-start path for simple conversation.
- The browser currently receives one generic SSE stream and then infers many
  UI states by inspecting `{ progress }`, `{ thinking }`, `{ taskPhases }`, and
  final text payloads. Codex’s transport is more strongly typed, so less client
  work is needed to decide what belongs in the status surface versus the
  transcript.
- ScienceSwarm still duplicates communication state in the client by storing
  legacy `activityLog` alongside `progressLog`, then promoting lifecycle and
  timing text into the visible transcript. Even when raw transport latency is
  acceptable, this makes the experience feel slower and noisier because users
  see more intermediate chatter before useful output.
- The OpenClaw WebSocket client is already persistent on the server side, but
  the browser does not talk to that session directly. The hot path still pays a
  browser fetch, server route dispatch, SSE framing, and progress normalization
  pass on every turn.

## Most Important Steps

These are the highest-value steps in the current sequence. They should stay at
the front of the execution order even if lower-priority visual polish PRs are
ready in parallel.

### Immediate Critical Path

1. **Stabilize warm-path correctness first**
   - Land and verify the OpenClaw prewarm and stale-health fixes before
     attempting larger latency claims.
   - In practice this means the current prewarm, stale-negative-cache,
     clear-stale-error, and send-time reprobe slices must converge first.

2. **Make the `Hi` benchmark trustworthy**
   - Add the benchmark script and timing artifact capture before broader speed
     refactors so every later PR can be judged by the same baseline.

3. **Reduce first-turn server work**
   - The biggest likely `Hi` wins after prewarm are greeting classification,
     skipping project materialization, skipping file reference scans, tightening
     recent-context budgets, and skipping artifact repair for non-artifact
     turns.

4. **Stop inferring so much client state from generic SSE**
   - Move toward typed progress and transcript events before deeper UI work.
   - This is the main prerequisite for making the communication feel closer to
     Codex rather than just restyling the same noisy data.

5. **Collapse duplicate progress state**
   - Remove the remaining dual-write path between `activityLog` and
     `progressLog` and stop showing timing/lifecycle filler in the visible
     transcript.

### Communication And UX Critical Path

6. **Create one primary run-state surface**
   - Replace the current duplication across page header, bubble-local `Working`
     rows, and phase widgets with one dedicated active-run surface.
   - This is the most important presentation change because it will make the
     chat feel more like a single continuous conversation instead of a dashboard
     card plus transcript dump.

7. **Upgrade progress rendering to full markdown**
   - Rich markdown and path normalization matter more than decorative styling
     because they directly improve comprehension of agent output.

8. **Coalesce tool and file activity**
   - Sequential reads, searches, writes, and command phases should collapse into
     compact grouped summaries rather than one bullet per raw event.

9. **Reshape the assistant lane**
   - After the run-state and progress structure are fixed, reduce the “wide
     card” feel by moving transient run UI out of the assistant bubble and
     making the lane read like a chat transcript.

10. **Defer polish until core transport and state are fixed**
    - Visual hierarchy tokens, transcript expansion UX, and additional motion
      are valuable, but they should come after transport typing, progress
      dedupe, and the dedicated run-state surface.

## Sequential PR Plan

Each PR below should be one small commit where feasible. After opening each PR,
run local validation, address review feedback, enable auto-merge only when safe,
wait for the merge, then measure and report the `Hi` response time.

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

45. **Project-Load Preconnect PR**
    - Start the OpenClaw gateway warm-up when the project chat surface loads and
      OpenClaw is the selected backend, instead of waiting for the first send.
    - Validation: hook or integration test proves a successful health probe
      triggers non-blocking preconnect before the first message and a benchmark
      shows improved time to first gateway event.

46. **Warm Session Retention PR**
    - Keep an already authenticated OpenClaw gateway session warm across short
      idle windows and project/settings navigation so the first follow-up turn
      does not pay the full reconnect path.
    - Validation: integration test proves a reused warm session survives the
      expected navigation window and reconnects cleanly after expiry.

31. **Structured Progress Payload PR**
    - Start emitting structured progress metadata from the route and gateway
      bridge using the Progress Contract fields instead of relying mostly on
      plain text inference.
    - Validation: route and hook tests prove source, phase, status, and
      timestamp fields arrive in order for server and gateway phases.

32. **Realtime Transcript Delta PR**
    - Add a Codex-style delta/done transcript transport for the visible live
      assistant narrative so progress rows and final answer streaming no longer
      compete for the same untyped channel.
    - Validation: SSE or parser tests prove transcript deltas append in order,
      final transcript completion replaces partial state correctly, and duplicate
      finals stay deduped.

33. **Run-State Surface PR**
    - Extract a dedicated web run-state surface modeled after the Codex status
      widget: `Working` or `Thinking`, ticking timer, interrupt hint, and short
      inline context such as active tool count.
    - Validation: component tests prove the timer advances every second, the
      label changes by phase, and the surface hides or restores cleanly when the
      turn state changes.

34. **Run-State Detail PR**
    - Add an optional secondary detail line under the run-state surface for the
      current summarized phase, instead of dumping every intermediate sentence
      into the visible transcript.
    - Validation: component tests prove long detail text wraps predictably and
      collapses when the active phase changes.

35. **Full Markdown Transcript PR**
    - Replace the current markdown-lite progress rendering with a shared full
      markdown renderer that supports emphasis, italic, lists, links, fenced
      code, and normalized local file paths.
    - Validation: component tests cover nested emphasis, fenced code, lists,
      links, and path rendering without exposing unsafe HTML.

36. **Activity Coalescing PR**
    - Coalesce sequential reads, searches, writes, and command phases into
      grouped summaries like the Codex transcript instead of one bullet per raw
      event.
    - Validation: snapshot tests show grouped summaries such as `Read a.ts,
      b.ts` and `Searched src/ for openclaw` replacing noisy per-call rows.

37. **Assistant Lane Geometry PR**
    - Rework the web message layout so user turns remain clear bubbles while the
      assistant lane reads like a structured answer stream, not one giant agent
      bubble containing everything.
    - Validation: browser or component tests prove user and assistant layout
      remain visually distinct on desktop and mobile while embeds stay bounded.

38. **Expanded Transcript View PR**
    - Add a first-class expanded transcript view for the full progress log and
      tool transcript, preserving the compact default chat view.
    - Validation: browser test opens the expanded transcript from an active turn
      and verifies ordering matches the inline condensed transcript.

39. **Visual Hierarchy Tokens PR**
    - Introduce dedicated tokens for run-state, tool summary, transcript detail,
      and final answer typography and color so the conversation matches the
      richer information hierarchy users expect from Codex or ChatGPT-style
      interfaces.
    - Validation: component snapshots prove the semantic tokens apply
      consistently across assistant answer text, progress transcript, and media
      captions.

40. **Codex Gap Review PR**
    - Add a short follow-up document comparing ScienceSwarm against the Codex
      reference after the above slices merge, calling out remaining speed and
      transcript gaps with benchmark evidence.
    - Validation: docs inspection plus the latest `Hi` benchmark table.

41. **Send-Path Health Elision PR**
    - Once the project-load preconnect and warm-session work are in place, stop
      paying an extra send-time health round-trip when the gateway session is
      already warm and let real transport failure surface directly.
    - Validation: integration test proves a warm OpenClaw session sends without
      a redundant health probe while a cold or expired session still fails
      safely.

42. **Typed SSE Envelope PR**
    - Replace the current loosely typed browser SSE payload mix with explicit
      event kinds for assistant delta, thinking delta, tool progress, task
      phase, timing meta, and final message completion.
    - Validation: hook parser tests prove each event kind updates only the
      intended slice of state and malformed events are ignored safely.

43. **Progress State Dedupe PR**
    - Remove the remaining dual-write path between legacy `activityLog` and the
      richer `progressLog`, and stop surfacing timing or low-signal lifecycle
      rows in the visible transcript by default.
    - Validation: hook tests prove one gateway event produces one visible
      progress representation and duplicate final answers remain deduped.

44. **Persistent Thread Stream PR**
    - Evaluate and implement a longer-lived browser-to-server thread stream for
      the active chat session so repeated turns reuse one live communication
      channel instead of paying full per-turn bootstrap and SSE setup costs.
    - Validation: end-to-end benchmark proves improved time to first visible
      event across back-to-back turns, plus reconnect tests for tab refresh and
      project navigation.

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
- Warm-path follow-up speed work: PRs 29 to 32. PR #30 depends on the project
  preconnect contract from PR #29; PR #32 depends on the structured progress
  payload from PR #31.
- Codex-inspired presentation work: PRs 33 to 39. PR #34 depends on PR #33, PR
  #36 depends on PR #31, PR #38 depends on PRs 33 and 36, and PR #39 can start
  after PR #33 lands.
- Post-rollup comparison: PR #40 after the earlier groups merge and fresh
  benchmark data exists.
- Transport cleanup follow-up: PRs 41 to 44. PR #41 depends on PRs 29 and 30,
  PR #42 can start after PR #31, PR #43 depends on PRs 31 and 42, and PR #44
  should wait until the earlier transport measurements exist.
- Codex comparison transport follow-up: PRs 45 to 49. PR #46 depends on PR
  #45, PR #47 depends on PRs 45 and 46, and PRs 48 to 49 should follow the
  earlier transcript-transport contracts so the later UI work has one stable
  event shape.
- Codex comparison presentation follow-up: PRs 50 to 53. PR #50 should follow
  the deduped progress work from PR #49, PR #51 should follow the typed
  transcript envelope from PR #48, PR #52 depends on PRs 50 and 51, and PR
  #53 should layer on top of the same compact assistant-lane geometry.
- Codex comparison post-rollup: PR #54 after PRs 45 to 53 land and fresh
  benchmark plus transcript evidence exists.
- Web chat presentation follow-up: PRs 55 to 64. PRs 55 and 56 should follow
  the earlier assistant-lane geometry work, PR #57 depends on the lighter
  assistant surface from PR #55, PR #58 should follow the full markdown work
  from PR #51, PR #59 can start after PRs 55 and 57, PR #60 can run after the
  media-width and refresh work from PRs 21 and 22, PR #61 depends on PRs 57
  and 58, PR #62 can start after PR #55, PR #63 should follow PR #55 so the
  composer relates to the lighter lane styling, and PR #64 should wait until
  PRs 55 to 63 land with fresh screenshots.

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
- Whether the web run-state surface should live inside the active assistant turn
  or at the chat composer boundary once the dedicated status widget work starts.

## Codex Comparison Follow-Up

The next wave should prioritize the differences that materially affect both
speed and communication quality versus Codex and the OpenClaw TUI:

- Codex keeps a long-lived typed event stream; ScienceSwarm still bridges each
  browser turn through a route-local fetch plus generic SSE payloads.
- Codex has one primary run-state surface; ScienceSwarm still duplicates status
  across progress rows, timers, and assistant bubble scaffolding.
- Codex renders a compact transcript with strong markdown hierarchy; our
  assistant lane still reads like a wide dashboard card with lower information
  density.
- Codex coalesces tool and lifecycle updates; ScienceSwarm still emits too many
  low-signal rows that make progress feel slower than it is.

Append these PRs after the current sequence:

45. **Project-Load Preconnect PR**
   - Start the OpenClaw gateway connection when the project page loads and the
     selected agent is OpenClaw, instead of waiting for the first send.
   - Validation: hook or route test proves project load triggers a warm
     connection exactly once and repeated loads reuse the active warm state.

46. **Warm Session Retention PR**
   - Keep the warmed OpenClaw session alive for a short idle window so the
     first follow-up turn does not pay the full reconnect cost.
   - Validation: gateway client test proves back-to-back turns reuse the same
     connection while expired idle sessions reconnect cleanly.

47. **Send-Path Health Elision PR**
   - Remove nonessential health fetches from the hot send path once a live
     gateway connection already exists and can prove readiness directly.
   - Validation: route or hook test proves a healthy warmed connection skips
     the extra health call while a broken connection still falls back to the
     explicit error path.

48. **Typed Transcript Envelope PR**
   - Replace mixed generic SSE payload inference with a typed transcript event
     envelope for progress, reasoning summary, tool progress, and final answer
     deltas.
   - Validation: parser tests prove each event kind is reconstructed without
     string heuristics or duplicate visible rows.

49. **Progress Dedupe PR**
   - Collapse repeated lifecycle text and duplicate progress state writes so one
     logical action produces one visible transcript update.
   - Validation: hook test feeds duplicate gateway and server progress events
     and asserts the rendered transcript only shows the coalesced row.

50. **Primary Run-State Surface PR**
   - Move live run-state display to one compact top-of-turn surface and keep
     the bubble transcript focused on the chronological narrative.
   - Validation: component test proves active run state is visible once and is
     removed from duplicate locations.

51. **Full Markdown Transcript PR**
   - Promote the assistant progress transcript from markdown-lite spans to the
     same safe markdown renderer used for richer emphasis, lists, and code
     formatting.
   - Validation: component tests cover emphasis, lists, code spans, and link
     rendering in progress rows without exposing unsafe HTML.

52. **Assistant Lane Geometry PR**
   - Reshape the assistant transcript so it reads like a real chat surface:
     tighter content column, clearer user and assistant separation, and less
     dashboard-style chrome.
   - Validation: component or browser test proves assistant content stays
     inside the chat lane, user turns remain visually distinct, and media still
     scales responsively.

53. **Transcript Detail Expansion PR**
   - Add expandable detail blocks for commands and tool artifacts so the
     default transcript stays compact while deeper execution detail remains one
     click away.
   - Validation: component test proves collapsed summaries show by default and
     expanded content preserves file paths, commands, and result snippets.

54. **Codex Gap Review PR**
   - Re-run the timing and transcript comparison after the earlier PRs merge,
     then capture any remaining user-visible gaps versus Codex and the OpenClaw
     TUI in a follow-up plan update.
   - Validation: updated timing report, transcript screenshots, and a short gap
     table tied to specific code areas.

## Web Chat Presentation Follow-Up

The next presentation wave should also adapt the strongest browser-chat
patterns visible in the local Codex app and the ChatGPT web UI:

- The main conversation canvas is visually light, close to white, and the
  answer content is the primary surface. Status chrome and metadata are
  visibly secondary.
- Assistant output reads like structured rich text rather than a dashboard
  card: headings, subheadings, numbered sections, bullet lists, bold,
  italics, code spans, and links all create hierarchy inside one answer.
- User turns stay clearly distinct, but assistant turns rely more on spacing,
  typography, and section rhythm than on heavy bubble framing.
- Images and embeds are grouped into deliberate multimodal layouts with
  consistent radii, captions, and spacing instead of feeling like raw inline
  attachments.
- Timestamp, tool, and status metadata are muted and edge-aligned so the eye
  lands on the answer body first.

Append these PRs after the current sequence:

55. **White Canvas Surface PR**
   - Rework the main assistant conversation lane toward a lighter white-canvas
     surface with less heavy card chrome, while preserving clear user-turn
     separation and responsive layout.
   - Validation: browser or component test proves the assistant lane remains
     readable on desktop and mobile and that existing media still stays within
     the chat column.

56. **Assistant Reply Surface PR**
   - Reduce assistant bubble framing so final answers read more like a document
     on the chat canvas and less like a wide bordered card, while user prompts
     remain compact visual bubbles.
   - Validation: component test proves assistant and user turns remain visually
     distinct and the assistant lane no longer carries redundant outer chrome.

57. **Typography Scale PR**
   - Introduce explicit typography tokens for assistant answer title, subtitle,
     body, list, caption, code, and metadata layers so rich markdown reads more
     like ChatGPT web output than plain uniform body text.
   - Validation: component snapshots prove heading, body, list, caption, and
     code typography render with consistent size, weight, and spacing.

58. **Rich Markdown Blocks PR**
   - Upgrade final-answer markdown rendering so headings, numbered sections,
     nested lists, block quotes, code fences, emphasis, and inline links create
     visible hierarchy in the assistant message body.
   - Validation: component tests cover heading levels, numbered lists, nested
     lists, code fences, emphasis, links, and safe HTML handling.

59. **Semantic Color And Emphasis PR**
   - Add restrained semantic color tokens for answer headings, muted metadata,
     code surfaces, links, and callout text so hierarchy is clearer without
     turning the chat into a dashboard palette.
   - Validation: component snapshots prove semantic colors apply consistently
     and maintain readable contrast on the light chat canvas.

60. **Multimodal Gallery Layout PR**
   - Group sequential images, charts, and related embeds into a deliberate
     gallery or stacked media block with consistent captions, spacing, and
     sizing instead of isolated raw attachment rows.
   - Validation: component or browser test proves two or more related images
     render as one coherent media group and remain responsive in narrow widths.

61. **Answer Section Rhythm PR**
   - Add spacing rules, section dividers, and paragraph rhythm so long answers
     with titles, subsections, lists, and media read like structured notes
     instead of one continuous dense block.
   - Validation: component snapshots prove multi-section answers preserve
     vertical rhythm and do not collapse headings or media into surrounding
     text.

62. **Metadata De-Emphasis PR**
   - Move timestamps, action buttons, and low-priority run metadata into a more
     subdued visual layer so the answer body carries the strongest emphasis.
   - Validation: browser or component test proves metadata remains accessible
     but no longer competes visually with the main assistant content.

63. **Composer Surface PR**
   - Simplify the composer area to better match the lighter chat surface:
     cleaner input chrome, clearer send affordance, and tighter relationship
     between the active transcript and the input boundary.
   - Validation: browser test proves the composer remains usable during
     streaming, wraps gracefully on smaller widths, and preserves current send
     behavior.

64. **Visual Reference Review PR**
   - Re-run the Codex and ChatGPT-web comparison with fresh screenshots after
     the above slices merge and document the remaining layout, typography, and
     multimodal gaps that still make ScienceSwarm feel less polished.
   - Validation: updated screenshot set, a short gap table, and explicit next
     candidates tied to code areas.
