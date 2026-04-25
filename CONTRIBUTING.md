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

Maintainers can add the `ci-defer` label while a PR is still in the
bot-review/fix loop. That skips the heavier required PR checks on interim
pushes, but it also blocks merge. Remove `ci-defer` when the PR is ready for
final validation so CI, dependency review, and any relevant E2E checks run on
the merge candidate.

If your PR changes chat speed or OpenClaw turn startup behavior, also run the
local `Hi` benchmark and record the result in
`docs/chat-speed-timing-report.md`:

```bash
npx tsx scripts/benchmark-chat-hi.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --json
```

When you want a paste-ready report row for
`docs/chat-speed-timing-report.md`, use:

```bash
npx tsx scripts/benchmark-chat-hi-row.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --pr '#PR' \
  --change-area 'change-area'
```

Once `scripts/append-chat-benchmark-report-row.ts` is available on the branch
you are validating, you can benchmark and update
`docs/chat-speed-timing-report.md` in one step with:

```bash
npx tsx scripts/append-chat-benchmark-report-row.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --pr '#PR' \
  --change-area 'change-area'
```

## Contribution rules

- Do not commit secrets, private local paths, or local runtime state.
- Do not put private project names, local slugs, or local workspace contents in
  code, docs, tests, PR bodies, or review replies. Use hypothetical examples
  such as `project-alpha`.
- Keep the public README and public repo surface honest when behavior changes.
- If you change Paper Library behavior, update the relevant public docs
  (`README.md`, `AGENTS.md`, `src/AGENTS.md`, or other user-facing docs) so
  the scan, review, apply, history, graph, cluster, and gap-finder workflow
  stays accurate.
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
- Include the Paper Library verification you ran when a PR changes that
  subsystem. At minimum, cover the affected route, command-center, or e2e
  surface rather than relying on unrelated repo-wide checks alone.
- Do not leave `ci-defer` on a PR that is ready to merge.
- Do not force-push unless a maintainer explicitly asks for it.

## Inbound license terms

By submitting a pull request, you agree that your contribution is licensed
under the same [MIT license](LICENSE) as this repository. This follows the
"Inbound = Outbound" convention used by most MIT-licensed projects on
GitHub — no separate contributor license agreement is required.
