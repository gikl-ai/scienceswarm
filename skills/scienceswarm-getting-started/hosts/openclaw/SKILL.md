---
name: scienceswarm-getting-started
description: 'Help users install, configure, and run ScienceSwarm. Use when someone asks how to set up ScienceSwarm, run the dev server, connect services, or troubleshoot first-run issues.'
metadata:
  openclaw:
    emoji: "🔬"
---

# ScienceSwarm — Getting Started

## What is ScienceSwarm?

ScienceSwarm is an open-source research workbench that combines:
- A **study dashboard** for managing research studies
- A **Second Brain** (wiki + RAG + memory) for capturing and retrieving knowledge
- A **Research Radar** for daily personalized briefings from arXiv, bioRxiv, etc.
- An **agent layer** (OpenHands / OpenClaw) for automated research tasks

## Installation

See [README.md](../../../../README.md) → Getting Started for user install. The installer seeds `.env` from `.env.example`, checks for Docker + Ollama, and prints the URL to finish configuration in `/setup`.

## Running

- `./start.sh` — starts all available services + frontend at `https://localhost:${FRONTEND_PORT:-3001}` by default
- `npm run dev` — frontend only

`start.sh` auto-detects and starts:
- **OpenHands** (Docker agent at `http://localhost:${OPENHANDS_PORT:-3000}`) — if Docker is available
- **OpenClaw gateway** — if the `openclaw` CLI is installed
- **Next.js frontend** defaults to HTTPS at `https://127.0.0.1:${FRONTEND_PORT:-3001}` when `FRONTEND_USE_HTTPS=true` (default).

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Optional cloud fallback for hosted LLM features. |
| `FRONTEND_USE_HTTPS` | Set to `false` to serve ScienceSwarm over HTTP locally. |
| `OPENHANDS_URL` | OpenHands agent URL (default: `http://localhost:3000`) |
| `BRAIN_ROOT` | Second Brain data directory (default: `${SCIENCESWARM_DIR:-~/.scienceswarm}/brain`) |
| `TELEGRAM_BOT_TOKEN` | Enables Telegram capture + radar via bot |
| `LLM_MODEL` | Optional model override for agent tasks; the repo does not set it in `.env.example` |

## Health Check

Visit `https://localhost:${FRONTEND_PORT:-3001}/api/health` to see which services are connected:
- `openclaw`: connected/disconnected
- `openhands`: connected/disconnected
- `ollama`: connected/disconnected (local LLM)
- `openai`: configured/missing

## Common Issues

- **"No OPENAI_API_KEY"**: Open `https://localhost:${FRONTEND_PORT:-3001}/setup` or add the key to `.env`
- **OpenHands won't start**: Check Docker is running (`docker info`)
- **Port in use**: Override with `FRONTEND_PORT=<port>` (or `PORT`) in `.env`
- **OpenClaw unhealthy**: Run `openclaw doctor --fix` then `openclaw gateway --force`

## Quality Check

Run `npm run quality` to verify the build, lint, types, and tests all pass.
