# AGENTS.md

Shared agent guidance for the public ScienceSwarm repository.

## What ScienceSwarm Is

`ScienceSwarm = OpenClaw + OpenHands + gbrain`

- `gbrain` is the durable knowledge and research-memory layer.
- `OpenClaw` is the user-facing manager and communication layer.
- `OpenHands` is the execution agent for heavier tasks.

Do not invent shadow stores or alternate ownership boundaries that contradict
that shape.

## Read First

- [`README.md`](README.md) for the user-facing product and setup surface
- [`CONTRIBUTING.md`](CONTRIBUTING.md) for contribution and PR expectations
- [`SECURITY.md`](SECURITY.md) for vulnerability reporting
- tool-specific entrypoints such as `CLAUDE.md` and `GEMINI.md` when those
  files are present and relevant to the tool in use
- [`src/AGENTS.md`](src/AGENTS.md) for the `src/` tree and key entry points
- [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for
  repo-wide coding guidance

## Repo Map

- `src/app/api/` public HTTP routes
- `src/app/dashboard/` main UI surfaces
- `src/lib/` integration clients, setup logic, and shared helpers
- `skills/` and `.openclaw/skills/` public product skill definitions
- `tests/` contract, integration, and UI coverage
- `sandbox/` the audit-revise sandbox image and gbrain HTTP shim

## Commands

Run the relevant checks before opening or updating a PR:

```bash
npm run test
npm run lint
npm run typecheck
npm run build
```

If you want the broader local quality wrapper, also run:

```bash
npm run quality
```

## Workflow

- Do not work directly on `main`; use a branch or worktree.
- Keep PRs focused and open them with a non-empty body.
- Include summary, verification, and any env or rollout impact in the PR body.
- Do not force-push unless a maintainer explicitly asks.

## Stable Invariants

- Keep the public repo surface honest. If public behavior changes, update the
  public docs and examples that describe it.
- Do not commit secrets, private local paths, local runtime state, or private
  workspace content.
- Use hypothetical placeholders such as `project-alpha` in tests and docs.
- Treat `openhands/` as an upstream boundary. Prefer changes in
  `src/lib/openhands.ts` and the Next.js proxy routes before touching the
  submodule.
- Stay on MIT-licensed OpenHands core surfaces only.
- Preserve the local-first path and the documented `gemma4:latest` default
  unless the product intentionally changes.

## Scope

This file is intentionally thin. Put subtree-specific guidance in scoped files
such as [`src/AGENTS.md`](src/AGENTS.md), and keep maintainer-only workflow
overlays out of the public repository.
