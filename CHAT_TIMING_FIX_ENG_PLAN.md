# Engineering Plan: Fast OpenClaw Web Chat

Date: 2026-04-23

Goal: make ScienceSwarm chat communicate through OpenClaw only, but use the same persistent gateway style as OpenClaw TUI instead of the slow per-message CLI path.

Primary reference: `CHAT_TIMING_ANALYSIS.md`

## Desired Outcome

For a normal project chat message:

- The browser sends one request to `/api/chat/unified`.
- The route checks cheap OpenClaw chat readiness from an existing WS/HTTP signal, not a deep CLI status probe.
- The route sends the turn to OpenClaw through gateway WebSocket `chat.send`.
- The route streams OpenClaw `chat` and `agent` events back to the browser as SSE.
- The frontend renders one ordered transcript with assistant text, thinking, lifecycle, and tool activity.
- The route never falls back to `openclaw agent ...` for web chat.
- If the gateway cannot connect or ACK the message, the user sees a clear OpenClaw transport error.

## Non-Goals

- Do not bypass OpenClaw by calling Ollama or another model directly.
- Do not remove CLI usage from Settings/setup/install flows; those flows still need CLI for configuring or starting OpenClaw.
- Do not change OpenHands or gbrain ownership boundaries.
- Do not ship a fake progress stream. The UI should show real OpenClaw gateway events, plus client-side elapsed time.

## Current Root Cause

`src/app/api/chat/unified/route.ts` calls `sendAgentMessage()` with:

```ts
{
  session,
  cwd,
  channel: "web",
  timeoutMs
}
```

`src/lib/openclaw.ts` only uses the WebSocket fast path when:

```ts
options?.session && !options?.channel && !options?.deliver && !options?.cwd
```

Therefore the normal route-shaped call disables WebSocket and shells out to `openclaw agent ...`.

## Proposed Architecture

Add a dedicated web-chat transport instead of continuing to overload `sendAgentMessage()`:

```ts
sendOpenClawChatViaGateway({
  sessionKey,
  message,
  timeoutMs,
  thinking,
  deliver: false,
  idempotencyKey,
  onEvent,
})
```

This function should:

- Reuse the singleton gateway WebSocket client in `src/lib/openclaw/gateway-ws-client.ts`.
- Send `chat.send`, matching OpenClaw TUI.
- Listen for `chat` events for the accepted run id.
- Forward `agent` events for the same run id.
- Resolve with final assistant text on `chat.final`.
- Reject on `chat.error`, `chat.aborted`, timeout, or WS close.
- Throw a post-ACK error if `chat.send` was ACKed but the final turn failed, so callers do not retry and duplicate tool work.

Keep `sendAgentMessage()` for non-chat legacy callers, but do not use it from `/api/chat/unified`.

## Work Plan

### PR 1: Gateway Chat Transport

Files:

- `src/lib/openclaw/gateway-ws-client.ts`
- `tests/lib/openclaw-gateway-ws-client.test.ts` or nearest existing OpenClaw transport test file

Implementation:

- Add `sendChatViaGateway(sessionKey, message, options)`.
- Use `sendRequest("chat.send", { sessionKey, message, thinking, deliver, timeoutMs, idempotencyKey })`.
- Generate an idempotency key when the caller does not provide one.
- Track the run id as the idempotency key, because the TUI does the same.
- Forward every non-infra `chat`, `agent`, and `chat.side_result` event through `onEvent`.
- Capture final assistant text from `chat.final.message.content`.
- Preserve the current `GatewayPostAckError` semantics.
- Add `gatewayChatReady()` that returns true from the authenticated singleton when possible.

Tests:

- `sendChatViaGateway` sends `chat.send`, not `sessions.send`.
- It includes `sessionKey`, `message`, `timeoutMs`, and `idempotencyKey`.
- It resolves on `chat.final` and extracts assistant text.
- It forwards `agent` tool/lifecycle events through `onEvent`.
- It rejects pre-ACK connection/auth failures as normal errors.
- It rejects post-ACK timeout/close as `GatewayPostAckError`.
- It does not shell out or import `runOpenClaw`.

Acceptance:

- A mocked gateway turn can stream events and final text without any CLI command.

### PR 2: Route Integration and No CLI Fallback

Files:

- `src/lib/openclaw.ts`
- `src/app/api/chat/unified/route.ts`
- `tests/integration/api-chat-unified*.test.ts`
- `tests/integration/privacy-policy.test.ts` if impacted

Implementation:

- Export a strict web-chat sender from `src/lib/openclaw.ts`, for example `sendOpenClawChatMessage()`.
- Update `/api/chat/unified` to use the strict web-chat sender for normal OpenClaw chat.
- Remove `channel: "web"` and `cwd` from the web-chat send options.
- Keep project root in the prompt guardrails with absolute paths for any file/tool task.
- Return a 503-style OpenClaw error if gateway connection or `chat.send` pre-ACK fails.
- Do not fall back to `sendAgentMessage()` or direct model streaming.
- Make the route emit forwarded gateway events as SSE `{ progress: event }`.

Project workspace risk:

- `chat.send` does not support `cwd`.
- Initial implementation should rely on existing absolute-path guardrails for file tasks.
- Add validation that generated files land under the ScienceSwarm project root.
- If validation shows OpenClaw still executes relative work in the wrong workspace, add a follow-up OpenClaw workspace binding step using project-scoped agents (`agents.create` or `agents.update` with `workspace`) before sending chat.

Tests:

- Route calls the strict gateway sender for OpenClaw chat.
- Route does not pass `cwd` or `channel` to the web-chat sender.
- Route returns 503 when the strict gateway sender reports a pre-ACK failure.
- Route does not call direct LLM fallback when OpenClaw is configured but gateway send fails.
- Route forwards `agent` progress as SSE.
- File-generation/tool-intent prompts include absolute project-root guardrails.

Acceptance:

- A route-level test proves `openclaw agent` is not used for `/api/chat/unified`.
- A failure test proves the route errors instead of silently falling back to CLI.

### PR 3: Cheap Chat Readiness

Files:

- `src/lib/openclaw.ts`
- `src/app/api/chat/unified/route.ts`
- OpenClaw health tests

Implementation:

- Split health into two APIs:
- `chatReady`: cheap, cached, returns only connected/disconnected.
- `deepStatus`: current CLI-backed status for Settings and diagnostics.
- In the chat route, use `chatReady` instead of deep `healthCheck()`.
- `chatReady` should return connected if the WS singleton is authenticated or HTTP `/health` returns OK.
- Cache positive and negative results for at least 10s.
- Let the real `chat.send` be the authoritative failure signal.

Tests:

- Chat readiness does not call `runOpenClaw` when HTTP health is OK.
- Cache prevents repeated probes for back-to-back messages.
- Settings/deep status can still call the richer CLI-backed path.

Acceptance:

- Sending `Hi` twice within the cache window does not run a second OpenClaw status probe.

### PR 4: Frontend TUI-Style Stream Rendering

Files:

- `src/hooks/use-unified-chat.ts`
- `src/components/research/chat-message.tsx`
- Related component tests in `tests/hooks` and `tests/components`

Implementation:

- Treat `chat` gateway events as first-class progress events:
- `chat.delta` updates assistant content.
- `chat.final` replaces scratch content with canonical final text.
- `chat.error` and `chat.aborted` render clear status rows.
- Treat `agent` gateway events as ordered transcript entries:
- `stream=tool, phase=start` renders compact tool start.
- `stream=tool, phase=update/result` renders optional output when verbosity allows.
- `stream=lifecycle` renders running/idle/error status.
- Render thinking blocks as Markdown in the same ordered transcript.
- Keep a client-side elapsed timer that increments every second while a turn is active.
- Stop rendering separate "thinking panel" and "activity panel" concepts for new messages; preserve migration for restored old chat state.

Tests:

- `chat.delta` streams text into the assistant bubble.
- `agent` tool events render as ordered transcript rows.
- Thinking with `**bold**` renders as Markdown, not literal asterisks.
- `Working (Ns)` increments every second under fake timers.
- Restored old `thinking` and `activityLog` messages still display.

Acceptance:

- The UI looks like one live transcript, not separate thinking/activity boxes.
- It keeps updating elapsed time even if the server sends no event for several seconds.

### PR 5: Timing Telemetry and Regression Guard

Files:

- `src/app/api/chat/unified/route.ts`
- New helper under `src/lib/` if needed
- Tests for timing debug output shape

Implementation:

- Add optional per-turn timing logs behind an env flag such as `SCIENCESWARM_CHAT_TIMING=1`.
- Record:
- request parse
- project materialization
- file reference merge
- shortcut detectors
- chat readiness
- prompt/context construction
- gateway connect/auth
- `chat.send` ACK
- first gateway event
- first assistant text
- final assistant text
- artifact import/repair
- Record prompt character counts by source:
- user text
- guardrails
- project prompt
- recent chat context
- active file
- workspace files

Tests:

- Timing helper records ordered phases.
- Prompt-size helper reports expected buckets without logging prompt contents.

Acceptance:

- A developer can diagnose where a slow `Hi` spent time without exposing user content.

## Manual Validation Script

Run after PR 1-3 on a local OpenClaw gateway:

1. Start ScienceSwarm and OpenClaw gateway.
2. Open a test project.
3. Send `Hi`.
4. Confirm no `openclaw agent` process starts during the request.
5. Confirm first SSE event arrives quickly with OpenClaw run/progress status.
6. Confirm final answer comes from the configured local OpenClaw model.
7. Send `write a tiny text file under docs saying hello`.
8. Confirm the created file is inside the ScienceSwarm project root.
9. Stop the gateway and send `Hi`.
10. Confirm the UI shows a clear OpenClaw transport error and does not answer through a fallback model.

## Performance Acceptance Criteria

Warm gateway, warm local model:

- Route reaches OpenClaw send without CLI probes.
- Gateway ACK target: under 250ms.
- First SSE progress event target: under 500ms after route starts waiting on OpenClaw.
- No per-message `openclaw status --json`.
- No per-message `openclaw agent`.

Cold model:

- Model loading may still take several seconds.
- UI must show real OpenClaw connection/run status immediately.
- Elapsed timer must increment once per second.

## Main Risks

- `chat.send` has no `cwd` field. Mitigation: absolute project-root guardrails first; if insufficient, create/update project-scoped OpenClaw agents with `workspace` set to the ScienceSwarm project root.
- Existing tests may mock `sendAgentMessage()`. Mitigation: add a named strict gateway sender and update tests intentionally.
- Duplicate messages can happen if fallback retry remains after ACK. Mitigation: no CLI fallback and preserve `GatewayPostAckError`.
- Progress could be noisy. Mitigation: map tool/lifecycle events to compact semantic rows and gate verbose output.
- Health split could regress Settings. Mitigation: keep deep status separate and covered by existing Settings tests.

## Definition of Done

- `/api/chat/unified` does not use CLI fallback for OpenClaw web chat.
- Chat still fails closed if OpenClaw gateway is unavailable.
- Direct model fallback is not used for normal chat.
- `Hi` no longer pays deep CLI health/status cost.
- The frontend renders TUI-style ordered progress from real OpenClaw events.
- Generated artifacts remain project-local.
- Unit and integration tests prove the above.
