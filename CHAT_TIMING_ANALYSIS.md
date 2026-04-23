# Chat Timing Analysis: ScienceSwarm and OpenClaw

Date: 2026-04-23

Scope: latency for a simple chat message such as `Hi`, why direct Ollama/Gemma and the OpenClaw TUI feel faster, what ScienceSwarm sends today, and how progress/thinking formatting differs.

## Executive Summary

The slow `Hi` path is not mainly Gemma. Direct Ollama/Gemma answered in about 6.4s on the measured machine, including about 3.6s of model load time. The ScienceSwarm-shaped OpenClaw send took about 30.2s.

ScienceSwarm is correctly enforcing the product rule that chat goes through OpenClaw, but the normal web chat path is usually **OpenClaw via CLI**, not **OpenClaw via the persistent WebSocket gateway**. The route passes `channel: "web"` and `cwd` into `sendAgentMessage()`. That disables the WebSocket fast path in `src/lib/openclaw.ts`, so `sendAgentMessage()` shells out to `openclaw agent ...`. The CLI path is batch-oriented, pays startup/session/lock/context costs, and does not emit live `onEvent` progress.

The OpenClaw TUI is faster and feels richer because it keeps one gateway WebSocket client alive, identifies itself as the TUI with `tool-events` capability, and sends messages with the high-level `chat.send` RPC. It does not shell out per message, does not run a deep CLI health probe before every send, and renders gateway events as they arrive.

The fastest fix that preserves the "only communicate with OpenClaw" invariant is to move ScienceSwarm chat to OpenClaw gateway WebSocket-only transport, preferably the same `chat.send` protocol the TUI uses. If the gateway is unavailable, return a clear chat transport error instead of falling back to the CLI.

## Measured Timings

These measurements were taken locally from the repo checkout. The Next.js app port was not reachable from the shell during the run, so the full browser-to-route timing was not measured directly. The important timings are still visible from the lower-level components.

| Path | Measured wall time | Notes |
| --- | ---: | --- |
| Direct Ollama `/api/generate`, prompt `Hi`, model `gemma4:latest` | 6.410s | Included 3.621s model load, 0.077s prompt eval, 2.590s eval. `prompt_eval_count=17`, `eval_count=227`. |
| `openclaw status --json` | 2.641s | Reported gateway URL but `reachable:false` in this environment. |
| ScienceSwarm `healthCheck()` | 2.798s | HTTP health is attempted first, but the function still runs CLI probes. |
| Individual OpenClaw probe: `status --json` | 1.254s | One CLI process. |
| Individual OpenClaw probe: `health` | 0.770s | Failed with gateway closed in this environment. |
| Individual OpenClaw probe: `models status --json` | 1.510s | Confirmed default OpenClaw model was `ollama/gemma4:latest`. |
| ScienceSwarm-shaped `sendAgentMessage("Hi", { session, cwd, channel: "web" })` | 30.225s | This is the route-shaped call. It took the CLI path. |
| WS-eligible `sendAgentMessage("Hi", { session })` | 23.809s | The code attempted the WS path, but the local gateway was not connected, so it fell back to CLI. |
| Direct `openclaw agent -m Hi ... --thinking off` | 21.593s | Still CLI. Also showed persistent session/context contamination risk. |

The conclusion is that the overhead is a stack of:

- CLI process startup and OpenClaw CLI initialization.
- Per-turn health/status checks.
- Gateway failure/retry/fallback behavior.
- OpenClaw persistent session/context replay.
- ScienceSwarm prompt/context wrapping before the message reaches OpenClaw.
- Lack of live event rendering when the CLI path is used.

## Current ScienceSwarm Chat Path

The main route is `src/app/api/chat/unified/route.ts`.

For a normal project chat message, the route does more than send the user text:

- It validates project identity and may materialize the gbrain project workspace before sending.
- It resolves active file context and can inject up to 8,000 characters from the selected file.
- It merges referenced workspace files.
- It runs setup/model-system/target-prioritization/experiment-design shortcut detectors.
- It calls `getConfiguredAgentRuntimeStatus()`, which calls OpenClaw `healthCheck()` for OpenClaw.
- It builds an OpenClaw session id and resolves the project working directory.
- It may prepend ScienceSwarm project prompt context.
- It can add recent chat context, up to 6 previous user messages and up to 12,000 characters.
- It can add workspace file context, up to 10 files and 20,000 characters per file.
- It always adds OpenClaw web task guardrails before sending to OpenClaw.

Even for `Hi`, the route can send much more than `Hi`. With no active file and no referenced files, the base added prompt is mainly the web task guardrails plus any recent chat context. With an active file or references, the payload can grow from a few hundred tokens to many thousands.

## Where CLI Is Used

`src/lib/openclaw.ts` has two important behaviors.

First, `healthCheck()` attempts an HTTP health probe, but then still runs:

- `openclaw status --json`
- `openclaw health` as fallback
- `openclaw models status --json` through `embeddedTurnReady()` in some fallback paths

The unified chat route only needs to know whether OpenClaw is connected. It does not need channel, agent, and session metadata on every message. For chat, a cheap "gateway is reachable / WS singleton is ready" check is enough.

Second, `sendAgentMessage()` only uses WebSocket when all of these are true:

```ts
options?.session && !options?.channel && !options?.deliver && !options?.cwd
```

But `openClawAgentOptions()` in `src/app/api/chat/unified/route.ts` returns:

```ts
{
  session,
  cwd,
  channel: "web",
  timeoutMs
}
```

That means the regular ScienceSwarm web chat path bypasses the WebSocket gateway and runs CLI:

```ts
openclaw agent -m <message> --session-id <session> --channel web
```

This also explains the weak progress stream. The route forwards `onEvent` progress when WebSocket events exist, but the CLI transport is batch output and ignores `onEvent`.

## Why Direct Ollama/Gemma Is Faster

Direct Ollama receives a tiny request and calls the model immediately. In the measured `Hi` request, Ollama evaluated only 17 prompt tokens and completed in 6.410s, including cold-ish model load time.

ScienceSwarm through OpenClaw is intentionally not equivalent to direct Ollama. It adds:

- OpenClaw runtime and session management.
- ScienceSwarm safety and workspace rules.
- gbrain/project context.
- artifact import/repair logic.
- persistent conversation handling.
- optional file context.

Those features are useful for real work, but they should not add 20-30s before a simple message starts returning. The intended architecture should still be OpenClaw-first, but it should use the OpenClaw gateway directly rather than spawning a CLI process per turn.

## How OpenClaw TUI Uses OpenClaw

The installed OpenClaw TUI inspected was `OpenClaw 2026.4.14 (323493f)`.

The TUI does these things differently:

- It creates a persistent `GatewayChatClient`.
- It connects with `clientName: TUI`, display name `openclaw-tui`, mode `UI`, and capability `tool-events`.
- It starts the gateway client once and waits for readiness.
- It sends chat with the high-level RPC `chat.send`.
- The `chat.send` payload includes `sessionKey`, `message`, `thinking`, `deliver`, `timeoutMs`, and `idempotencyKey`.
- It registers for gateway events on the same connection.
- It handles `chat` events for run state such as `delta`, `final`, `aborted`, and `error`.
- It handles `agent` events for tool and lifecycle streams.
- It updates the busy status every 1s and waiting spinner text every 120ms.

The relevant shape in the TUI is:

```ts
client.request("chat.send", {
  sessionKey,
  message,
  thinking,
  deliver,
  timeoutMs,
  idempotencyKey
});
```

ScienceSwarm's current WebSocket helper, when it is allowed to run, uses lower-level session RPCs:

- `sessions.create`
- `sessions.messages.subscribe`
- `sessions.send`

The TUI path is the better model for web chat because `chat.send` is the gateway's user-facing chat protocol. It handles idempotency, run tracking, tool-event routing, and chat transcript updates in one path.

## Why The TUI Feels Faster

The TUI can show useful feedback immediately even when the model itself is still working:

- The user message is added optimistically before the model finishes.
- Connection state is already known from the persistent WS client.
- It does not run `openclaw status --json` before each message.
- It does not spawn a CLI process for each message.
- Tool/lifecycle events arrive as events, not as a final CLI transcript.
- The elapsed timer updates every second.

ScienceSwarm currently often waits on a batch CLI response, so the UI has little real data to render. It can show task phases and a placeholder, but it cannot show OpenClaw's detailed live activity unless the gateway event path is actually used.

## Formatting and Information Differences

ScienceSwarm currently stores separate fields:

- `thinking`
- `activityLog`
- `progressLog`
- `taskPhases`

The frontend has code to merge thinking and activity into one progress transcript, and it can format tool-like lines such as `Read`, `Write`, `Search`, `Run`, `Plan`, and image generation. The problem is not only rendering. The problem is that the CLI path starves the renderer of live event data.

The TUI has a simpler event model:

- `chat` events update assistant text and final state.
- `agent` events update tool start/update/result rows.
- `agent` lifecycle events update running/idle/error state.
- Thinking is extracted from `thinking` content blocks and optionally rendered inline above normal content.
- Tool verbosity controls whether tool calls and outputs appear.

For a web experience similar to the TUI or Codex console, ScienceSwarm should render one ordered transcript instead of two conceptual panels:

- Narrative/thinking entries as Markdown, so `**bold**` renders correctly.
- Tool rows as compact semantic entries: `Read file`, `Search pattern`, `Run command`, `Write file`.
- Assistant text deltas in the same bubble.
- Lifecycle/status rows in subdued text.
- Elapsed "Working" timer updated every second from the client clock, not only when server events arrive.

## Prompt and Context Differences

Direct Ollama prompt for the timing test was just `Hi`.

ScienceSwarm OpenClaw prompt can include:

- Current user message.
- Active file context, capped at 8,000 characters.
- Recent chat context, capped at 6 messages and 12,000 total characters.
- Workspace file context, up to 10 files and 20,000 characters per file.
- ScienceSwarm project prompt context when present.
- OpenClaw web task guardrails.
- OpenClaw's own session/system context.

This is why a trivial `Hi` should have a fast path. The route can still obey the OpenClaw-only rule while skipping expensive context construction when there is no file reference, no active file need, no tool intent, and no contextual pronoun/reference that requires prior turns.

## Recommended Fix Plan

### P0: Use OpenClaw Gateway WS For Chat

Implement a ScienceSwarm OpenClaw chat sender that uses the gateway WebSocket and `chat.send`, following the TUI protocol.

Requirements:

- No CLI fallback in `/api/chat/unified`.
- If the gateway cannot connect or `chat.send` cannot be ACKed, return a clear 503-style OpenClaw transport error.
- Preserve no-retry behavior after a message is ACKed to avoid duplicate tool execution.
- Keep the "chat only communicates with OpenClaw" invariant.

Open point: the current CLI path uses `cwd` to force project-local execution. Before removing CLI, verify whether the gateway has a supported session/workspace/cwd field. If not, add or expose that in OpenClaw rather than reintroducing CLI fallback.

### P0: Stop Disabling The WS Fast Path

Today `channel: "web"` and `cwd` force CLI. Either remove those from the WebSocket chat path or replace `sendAgentMessage()` with a dedicated `sendOpenClawChat()` API whose options match gateway `chat.send`.

Do not keep a generic "maybe CLI, maybe WS" helper for web chat. That makes performance and event behavior unpredictable.

### P1: Make Health Cheap For Chat

Split health into two levels:

- `chatReady`: cheap, cached, WS/HTTP based, only returns connected/disconnected.
- `deepStatus`: CLI-backed, used by Settings/status pages when channel/session metadata is actually needed.

For chat:

- If HTTP `/health` is OK or the WS singleton is already authenticated, return connected immediately.
- Cache for at least 10s, probably 30s.
- Let the actual WS send be the authoritative failure signal.

The earlier suggestion to short-circuit `healthCheck()` when HTTP says OK makes sense for chat, but the cleaner implementation is a separate chat readiness function so Settings can still request deep metadata.

### P1: Reduce Context For Simple Turns

For a simple message like `Hi`:

- Skip project materialization unless tool/file intent needs it.
- Skip workspace reference scanning unless the message contains path-like references or files are attached.
- Do not include active file context unless the user is asking about the visible file.
- Limit recent chat context to 1-2 turns for greetings and general questions, or skip it entirely.

This should make the model-facing prompt close to direct OpenClaw chat while preserving richer behavior for real workspace tasks.

### P1: Add Timing Telemetry

Add per-turn timings around:

- request parse
- project workspace materialization
- referenced file merge
- shortcut detector checks
- OpenClaw chat readiness
- prompt/context construction
- gateway connect/auth
- `chat.send` ACK
- first event
- first assistant text
- final assistant text
- artifact import/repair

Also log prompt character counts by source:

- user text
- guardrails
- project prompt
- recent chat context
- active file
- workspace files

This will make future `Hi` regressions obvious.

### P2: Match TUI Formatting

Frontend should consume a single ordered stream:

- `chat.delta` or assistant stream text -> assistant content
- `chat.final` -> canonical final content
- `agent.tool:start` -> compact tool row
- `agent.tool:update/result` -> optional expanded output based on verbosity
- `agent.lifecycle` -> subdued status row
- thinking blocks -> Markdown-rendered thinking entries when enabled

The existing `progressLog` concept is close, but it should become the primary ordered transcript rather than a fallback assembled from separate `thinking` and `activityLog` fields.

## Target Timing Budget

For a warm local model and a connected OpenClaw gateway:

- UI optimistic user message: under 100ms.
- Chat readiness: under 50ms from cache or existing WS state.
- Gateway ACK: under 250ms.
- First OpenClaw lifecycle/tool event: under 500ms when the agent starts work.
- Model time: whatever the selected model needs.
- No extra CLI tax on the normal path.

For a cold local model, the model may still take several seconds to load. The UI should still show real OpenClaw connection/run status immediately and then stream available activity.

## Caveats

The local gateway was unhealthy during the measurement, so the WS-eligible ScienceSwarm helper still fell back to CLI. That reinforces the recommendation: web chat should fail clearly when WS is unavailable instead of silently falling back to a slow batch transport.

Absolute timings will vary by machine and model load state. The relative diagnosis is stable: direct Ollama is fast because it sends a tiny prompt directly to the model; OpenClaw TUI is faster because it uses persistent gateway chat; ScienceSwarm is slow because the current route-shaped call usually enters OpenClaw through CLI and adds extra pre-send work.
