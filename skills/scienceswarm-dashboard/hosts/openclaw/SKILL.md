---
name: scienceswarm-dashboard
description: 'Help users navigate and use the ScienceSwarm dashboard UI. Use when someone asks about the study workspace, settings, communications panel, or how to configure features in the web interface.'
metadata:
  openclaw:
    emoji: "📊"
---

# ScienceSwarm — Dashboard

## Overview

The dashboard is a Next.js web UI at `https://localhost:${FRONTEND_PORT:-3001}` by default, serving local HTTPS for Safari and secure-cookie compatibility:

- **Study workspace**: View and manage research studies
- **Communications panel**: Chat through OpenClaw, NanoClaw, or direct LLM backends
- **Settings**: Configure services, radar, frontier watch, and integrations
- **Health dashboard**: Monitor connected services

## Key Pages

| Path | Purpose |
|---|---|
| `/dashboard/study` | Main study workspace |
| `/dashboard/settings` | Service configuration and feature settings |
| `/api/health` | JSON health check for all services |

## Communications Panel

The chat panel connects to whichever agent backend is available:
1. **OpenClaw** — preferred, cross-channel routing
2. **NanoClaw** — lightweight HTTP-based alternative
3. **Ollama** — local LLM fallback
4. **OpenAI** — cloud LLM fallback

Check connection status via the panel's indicator dot (green = connected).

## Settings Page

Configure:
- **Agent backend**: Choose between OpenClaw, NanoClaw, or direct LLM
- **Frontier Watch**: Set up recurring research scans per study
- **Model selection**: Choose LLM model for agent tasks
- **Integrations**: View connected services status

## Frontier Watch (Settings)

Per-study frontier watches run via OpenClaw:
- Configure topics, schedule, and delivery channel
- Set cadence: daily, weekdays, or weekly
- View and tweak the generated research prompt
- Access at `/dashboard/settings?study=<slug>#frontier-watch`

## Important Notes

- The main study workspace lives at `src/app/dashboard/study/page.tsx`.
- Real agent features (chat, code execution, GitHub integration) require OpenHands or OpenClaw to be running.
- The health endpoint at `/api/health` reports which features are actually available.
