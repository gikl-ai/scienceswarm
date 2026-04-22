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
- Deterministic literature-packet runs across PubMed, arXiv, OpenAlex, and
  Crossref, with durable `research_packet` and `overnight_journal` artifacts
- Direct chat plus OpenClaw-routed chat when the agent runtime is available
- OpenHands-backed execution for code and longer-running agent tasks
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

Then open <http://localhost:3001/setup>.

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
2. Open `/dashboard/project`
3. Import a folder of papers, notes, code, or datasets
4. Start chatting with a project that already has context
5. Run a literature packet from chat or MCP when you want a deterministic
   multi-source landscape review with durable packet/journal outputs

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

The supported local runtime wrapper is `scienceswarm start|stop|restart|status`.

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
