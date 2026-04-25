# ScienceSwarm

[![CI](https://github.com/gikl-ai/scienceswarm/actions/workflows/ci.yml/badge.svg)](https://github.com/gikl-ai/scienceswarm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](.node-version)

ScienceSwarm is a local-first AI research workspace. It lets you import papers,
notes, code, and datasets into one project workspace, search and organize that
material, chat with an assistant that knows your project, and hand off heavier
execution work to a local agent runtime when needed.

The core system is:

`ScienceSwarm = OpenClaw + OpenHands + gbrain`

- `gbrain` is the knowledge layer and durable research memory
- `OpenClaw` is the manager agent and communication layer
- `OpenHands` is the execution agent for heavier tasks

## Why Use ScienceSwarm

- Keep your research corpus in one workspace instead of scattering it across
  PDFs, notes, scripts, and chat logs
- Run local-first by default with Ollama and `gemma4:latest`, with optional
  cloud fallback when you want it
- Capture and organize work across chat, uploads, project pages, and optional
  Telegram/OpenClaw flows
- Use one product for literature review, project memory, agent-assisted coding,
  and reasoning/audit workflows

## Key Features

- Project-scoped imports for papers, notes, code, and datasets
- Research-first brain setup that defaults new installs to the
  `scientific_research` preset while still offering a
  `generic_scientist` preset for broader workflows
- A searchable `gbrain`-backed research memory that enriches chat with project
  context
- A local-first Paper Library workflow that scans messy PDF archives, proposes
  better metadata, previews rename and move plans, and keeps citation graph,
  cluster, and gap-finder views tied to the same project corpus
- Deterministic literature-packet runs across PubMed, arXiv, OpenAlex, and
  Crossref, with durable `research_packet` and `overnight_journal` artifacts
- Direct chat plus OpenClaw-routed chat when the agent runtime is available
- OpenHands-backed execution for code and longer-running agent tasks
- AI destination controls for OpenClaw, Claude Code, Codex, Gemini CLI, and
  OpenHands, with per-project privacy policy gates and preview approval before
  third-party or execution-capable sends
- Dream Cycle and Research Radar overnight runs that leave auditable journal
  artifacts in the brain, including project-specific frontier matches that
  explain what changed and can be saved back into gbrain memory
- A reasoning workspace for critique, review, and structured audit flows
- Private local installation of third-party market plugin bundles from pinned
  upstream GitHub refs, with local OpenClaw, Codex, and Claude Code exposure
  but no automatic promotion into the public ScienceSwarm catalog
- Local-first setup with optional integrations for OpenAI, GitHub, Google,
  Slack, Jira, and Telegram

## Quick Start

### Requirements

- macOS or Linux
- Windows is supported via WSL2 only for now; native Windows is not yet supported
- Node.js 22+
- No API key is required for the default local path
- Docker is needed for the OpenHands execution path
- A Telegram account is only needed if you want Telegram/OpenClaw setup during
  onboarding

### Install

```bash
git clone https://github.com/gikl-ai/scienceswarm.git ~/scienceswarm
cd ~/scienceswarm
./install.sh
./scienceswarm start
```

If `${SCIENCESWARM_BIN_DIR:-$HOME/.local/bin}` is on your `PATH`, the installed
shim also lets you run `scienceswarm start`.

If you use the one-liner installer, `SCIENCESWARM_INSTALL_DIR` controls the
checkout path. Runtime state is separate: `SCIENCESWARM_DIR` is the local app-data root
(default `~/.scienceswarm`), and the brain store defaults to
`<SCIENCESWARM_DIR>/brain` unless you set `BRAIN_ROOT` to move it elsewhere.

`./scienceswarm start` opens the dashboard automatically after the local frontend
is healthy. New installs redirect to setup when needed. To go straight there,
run `./scienceswarm start --open setup` or open <http://127.0.0.1:3001/setup>.
ScienceSwarm uses HTTP on the loopback interface by default because browsers
treat local loopback origins as trustworthy without requiring users to accept a
self-signed certificate. Set `FRONTEND_USE_HTTPS=true` only when you
specifically need local TLS.

The setup flow initializes the local research store, verifies local runtimes,
defaults new installs to the `scientific_research` brain preset, and can
connect OpenClaw, OpenHands, Ollama, and Telegram when you want the full agent
path. If you want the broader legacy-oriented layout instead, the setup UI also
offers a `generic_scientist` preset. Existing brains are not auto-renamed; use
the `bridge-research-layout` maintenance action to preview legacy `wiki/*`
homes and optionally create non-destructive README bridges for the canonical
research-first layout.

### Windows via WSL2

ScienceSwarm does not support native Windows yet. The supported Windows route is
Ubuntu on WSL2.

Recommended setup:

1. Install WSL2 and Ubuntu
2. Install Docker Desktop and enable WSL integration for your Ubuntu distro
3. Clone the repo inside the Linux filesystem, for example `~/scienceswarm`
4. Run ScienceSwarm from the WSL shell, not from PowerShell or `cmd.exe`
5. Keep `SCIENCESWARM_DIR` and `BRAIN_ROOT` in the Linux filesystem too

Important:

- Do not keep the repo under `/mnt/c/...` unless you accept slower file
  scanning, imports, and file watching
- Do not point `SCIENCESWARM_DIR` or `BRAIN_ROOT` at mounted Windows drives for
  normal use
- After `./scienceswarm start` in WSL, open <http://localhost:3001/setup> from
  your Windows browser

### First Use

1. Complete `/setup` and keep the default `scientific_research` preset unless
   you specifically want the broader `generic_scientist` layout
2. Open `/dashboard/project` with `./scienceswarm open`
3. Import a folder of papers, notes, code, or datasets
4. Start chatting with a project that already has context
5. Run a literature packet from chat or MCP when you want a deterministic
   multi-source landscape review with durable packet/journal outputs

### Paper Library

ScienceSwarm includes a Paper Library workflow for turning a large local PDF
archive into something you can actually work with.

From the `Paper Library` view inside a project, you can:

1. Run a dry-run scan against a local folder of PDFs, even when filenames are
   inconsistent or metadata is incomplete
2. Review candidate identities, accept or correct the matches, and choose a
   rename template such as `{year} - {title}.pdf`
3. Preview the full apply plan before any files move
4. Apply the approved plan, then inspect the same corpus through graph,
   semantic cluster, and gap-finder views
5. Use manifest history to undo a move set or retry metadata writeback if the
   local file operations finished before a gbrain update did

The workflow is project-scoped, so each project can organize and explore its
own paper archive without treating every imported folder as one global library.

### AI Destinations

OpenClaw remains the local-first default destination. The project composer starts
with the `local-only` policy, which allows OpenClaw chat and blocks third-party
Claude Code, Codex, and Gemini CLI sends before prompt construction. You can
choose `cloud-ok` for turns where third-party subscription-native CLIs are
acceptable, or `execution-ok` when OpenHands-style execution is acceptable.

The project chat composer includes a compact destination switcher next to Send.
Use it to pick Claude Code, OpenClaw, Codex, Gemini CLI, or compare mode
without leaving the conversation. Settings remains the diagnostics and
advanced-history surface for destinations, policies, compare targets, and
sessions.

Direct Claude Code chat goes through the local `claude` CLI, not through
OpenClaw. ScienceSwarm sends the visible prompt plus explicitly selected
context or attachments, preserves Claude Code's native session id for resume,
streams Claude Code output into the assistant bubble, and does not apply
OpenClaw response cleanup to Claude Code text before you see it. Any third-party,
task, compare, or execution-capable turn is previewed before send: the preview
lists where the data will be sent, account source, and the prompt or project
context that will leave the local workspace. ScienceSwarm does not store
Claude Code, Codex, or Gemini subscription tokens; those destinations use your local
CLI login. API-key adapters read keys from `.env` only when configured
and do not echo secret values back through the UI.

Claude Code launches from a generated ScienceSwarm session capsule rather than
the ScienceSwarm source checkout. The capsule includes `SCIENCESWARM.md` for
product and project orientation, a thin `CLAUDE.md` that points Claude back to
that guidance, a compact gbrain project brief, and a destination-scoped MCP config
for selective gbrain search/read/write tools. MCP bearer credentials are injected
through the spawned process environment rather than the prompt text, and the
temporary MCP config is deleted after each invocation. The preview lists this
generated guidance and scoped brain access before the prompt is sent.

AI sessions stay visible from Settings after destination sends. Session
history keeps destination, mode, status, events, and artifact/writeback state so
failed artifact imports can be retried from the composer after changing destination or
policy. If a future rollback or destination removal leaves old sessions with an
unknown destination id, ScienceSwarm keeps those rows as read-only history rather than
deleting them.

To connect a subscription-backed CLI, sign in with the provider's own command.
ScienceSwarm does not collect Claude, Codex, or Gemini credentials. When it
launches a subscription-native destination, it removes provider API-key environment
variables from that child process so the native CLI login stays in charge of
billing and auth.

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code
claude auth login
claude auth status

# Codex
npm install -g @openai/codex
codex login
codex login status

# Gemini CLI
npm install -g @google/gemini-cli
gemini
# If Gemini opens without asking for an auth method, its native CLI session is usable.
```

After the CLI is installed and signed in, open a project, use the composer
destination switcher to choose Claude Code, switch Project policy from `local-only`
to `cloud-ok` when prompted, and approve the preview before sending third-party
context. Settings > Project AI destinations remains available for session history,
diagnostics, and advanced modes.

Rollback smoke after reverting or patching an AI-destination PR:

```bash
npm run test:e2e -- tests/e2e/runtime-hosts.spec.ts
npm run test -- tests/integration/api-runtime-preview.test.ts tests/integration/api-runtime-sessions.test.ts tests/integration/api-runtime-compare.test.ts tests/integration/api-runtime-artifacts.test.ts
```

The minimum manual smoke is: confirm OpenClaw local chat still works with the
default `gemma4:latest` model, local-only policy blocks third-party destinations, cloud-ok
policy shows a preview and approval gate, destination health renders missing or
not-authenticated CLIs without crashing settings, and historical sessions remain
readable.

For chat-speed changes, also run the local `Hi` benchmark and append the result
to [`docs/chat-speed-timing-report.md`](docs/chat-speed-timing-report.md):

```bash
npx tsx scripts/benchmark-chat-hi.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --json
```

To generate a paste-ready table row for that report, use:

```bash
npx tsx scripts/benchmark-chat-hi-row.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --pr '#PR' \
  --change-area 'change-area'
```

To benchmark and append the new row to `docs/chat-speed-timing-report.md`
directly, use:

```bash
npx tsx scripts/append-chat-benchmark-report-row.ts \
  --url http://localhost:3001 \
  --project project-alpha \
  --message Hi \
  --timing-artifact \
  --pr '#PR' \
  --change-area 'change-area'
```

### Private Market Plugins

ScienceSwarm keeps two distinct skill/plugin surfaces:

- Repo-backed workspace skills under `skills/` are the canonical first-party
  and public catalog authoring path.
- Third-party market plugin installs are private and user-local by default.

Use the dashboard Skills view and switch to the `Installed` catalog to install
a third-party plugin bundle from GitHub by `repo`, `ref`, and bundle `path`
such as `plugins/life-science-research`.

ScienceSwarm first inspects the upstream bundle, records the requested ref plus
resolved commit SHA, then stores a pinned private bundle snapshot under
`SCIENCESWARM_DIR/market/plugins/<plugin>/bundle`. From that local snapshot it:

- installs the bundle into the local OpenClaw state under
  `SCIENCESWARM_DIR/openclaw`
- projects bundled skills into repo-local `.codex/skills/`
- projects bundled skills into repo-local `.claude/skills/`

These installs are not added to `skills/public-index.json`, are not promoted
into the public ScienceSwarm catalog automatically, and stay local by default.
ScienceSwarm also exposes explicit `Inspect`, `Update from upstream`, and
`Reinstall hosts` actions so provenance and trust stay visible instead of
hidden behind a one-shot import. Third-party bundles may include scripts or
other executable files, so review upstream sources before installing them.

### Frontend-Only Development

If you are working on the UI and do not need the full agent stack:

```bash
npm run dev
```

The supported local runtime wrapper is
`scienceswarm start|stop|restart|status|open`. `start` and `restart` keep the
terminal attached as the live server log and open the dashboard automatically
after the frontend health check passes. For headless runs, use
`./scienceswarm start --no-open` or `./scienceswarm restart --no-open`.

## Project Status

ScienceSwarm is alpha software.

- APIs, environment variables, and on-disk formats may change without notice.
- Backward compatibility is not guaranteed between alpha releases.
- Local state can be lost if you experiment on important data without backups.
- It is not recommended for production or regulated workflows yet.

This first public release intentionally keeps the repo surface small. The
README and the shipped code are the primary references for now; the internal
planning, acceptance, and launch-process docs are not part of this release.

## Telemetry

- The README includes a PostHog tracking pixel for coarse github.com impression
  trends.
- The `.github/workflows/posthog-traffic.yml` workflow forwards GitHub Traffic
  API snapshots to PostHog so history survives beyond GitHub's 14-day window.
- To enable that workflow, add two repository secrets:
  `POSTHOG_PROJECT_KEY` with your PostHog project API key, and
  `GH_TRAFFIC_TOKEN` with a fine-grained PAT that has repository
  `Administration: Read` for this repo. GitHub's built-in workflow
  `GITHUB_TOKEN` cannot request that permission scope.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md),
and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

<!-- PostHog 1x1 tracking pixel: counts impressions of this README rendered on github.com.
     Served via PostHog's Tracking pixel CDP source (no per-visitor data — GitHub proxies
     images through camo.githubusercontent.com which strips IPs/UAs). Disable by removing
     this <img> tag and the corresponding source webhook in PostHog. -->
<img src="https://webhooks.us.posthog.com/public/webhooks/019db2b1-39dd-0000-a893-6b1a69f9e643" width="1" height="1" alt="" />
