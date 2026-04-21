# Contributing

## Getting started

```bash
npm install
cp .env.example .env
npm run dev
```

For the full local stack, use:

```bash
./start.sh
```

## Required checks

Before opening or updating a PR, run:

```bash
npm run test
npm run lint
npm run typecheck
npm run build
npm run quality
```

## Contribution rules

- Do not commit secrets, private local paths, or local runtime state.
- Do not put private project names, local slugs, or local workspace contents in
  code, docs, tests, PR bodies, or review replies. Use hypothetical examples
  such as `project-alpha`.
- Keep the public README and public repo surface honest when behavior changes.
- Treat `openhands/` as an upstream integration boundary. Prefer changes in
  `src/lib/openhands.ts` and `src/app/api/agent/*` before touching the
  submodule.
- Stay on MIT-licensed OpenHands core surfaces only. Do not introduce
  enterprise-only OpenHands dependencies without explicit approval.

## Dependency and license expectations

- New runtime dependencies must have a license that is acceptable for this
  repository's MIT distribution model.
- If a dependency introduces a new license family or a security advisory, call
  it out explicitly in the PR description.

## Pull requests

- Keep PRs focused.
- Include a non-empty PR body with summary, verification, and any env or
  rollout impact.
- Do not force-push unless a maintainer explicitly asks for it.

## Inbound license terms

By submitting a pull request, you agree that your contribution is licensed
under the same [MIT license](LICENSE) as this repository. This follows the
"Inbound = Outbound" convention used by most MIT-licensed projects on
GitHub — no separate contributor license agreement is required.
