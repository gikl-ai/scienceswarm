# ScienceSwarm Copilot Instructions

These instructions describe the shared, public repository contract for coding
agents and completions.

They intentionally omit maintainer-only overlays and unpublished internal docs.

## Product Shape

ScienceSwarm is a local-first AI research workspace.

The stable system model is:

`ScienceSwarm = OpenClaw + OpenHands + gbrain`

- `gbrain` is the durable research-memory layer.
- `OpenClaw` is the user-facing manager and communication layer.
- `OpenHands` is the execution agent for longer-running work.

Do not introduce a new canonical data store that bypasses `gbrain`.

## Repository Expectations

- Prefer focused, minimal changes over broad refactors.
- Keep public claims in `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and
  `.env.example` aligned with shipped behavior.
- Never add secrets, private local paths, hidden maintainer notes, or real
  workspace content to tracked files.
- Use placeholder names such as `project-alpha`, `@alice`, and
  `/Users/your-username/...` in examples and tests.

## Code Guidance

- API routes live under `src/app/api/`. Prefer `Response.json()` or
  `new Response()` for standard handlers, and use `NextResponse` only when a
  route actually needs its Next.js-specific helpers.
- Path-specific implementation guidance for the `src/` tree lives in
  `src/AGENTS.md`.
- Prefer integrating with OpenHands through `src/lib/openhands.ts` and the
  existing proxy routes before changing the upstream submodule.
- Preserve the local-first path and the documented `gemma4:e4b` default
  unless intentionally changing product behavior.

## Validation

Before proposing a completed change, run the relevant checks:

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

Use `npm run quality` when a broader local quality pass is appropriate.
