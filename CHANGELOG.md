# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Breaking

- Config unified on `.env`. Existing `.env.local` files auto-migrate to `.env` on first run (backup at `.env.local.migrated-<timestamp>`). Any tools that wrote to `.env.local` directly must update.
- `setup.sh` removed. Use `./install.sh` for first-time setup.
- Ports are now centrally configured. Override local service ports via env vars:
  `FRONTEND_PORT`, `OPENHANDS_PORT`, `OPENCLAW_URL`, `NANOCLAW_PORT`,
  `OLLAMA_URL`. Cloud structured critique uses
  `STRUCTURED_CRITIQUE_SERVICE_URL` and is not managed as a local port.

### Added

- `src/lib/config/ports.ts` — central port configuration module.
- `src/lib/setup/env-migration.ts` — one-shot `.env.local` → `.env` migration on boot.
- `scripts/print-port.ts` — shell-consumable port helper.
- `scienceswarm open [browser] [dashboard|setup|path]` opens the detected healthy local frontend URL in Chrome by default, with named-browser overrides such as `safari` and `firefox`.
- `scienceswarm start` and `scienceswarm restart` now open the dashboard automatically after the frontend health check passes, with `--no-open`, `--browser`, and `--open` options for headless or browser-specific runs.
- `scienceswarm restart` and `start.sh` now print an explicit local-app handoff: keep the terminal open, wait for frontend readiness, expect the dashboard to open automatically, and use the exact printed protocol/URL if manual recovery is needed.
- System identity clarified as `ScienceSwarm = OpenClaw + OpenHands + gbrain`, with gbrain-first data-flow rules across setup, chat, and execution paths.
- Simple-onboarding: single-screen `/setup` form replaces the 7-step installer and multi-section setup page. Installs everything in parallel via `/api/setup/bootstrap` SSE (gbrain, openclaw, openhands docker, ollama+gemma).
- Personal Telegram bot auto-creation via gramjs + BotFather automation. Users see "Meet Wobblefinch" (or any of 45 whimsical creatures) with a QR code to their personal bot — no token passing.
- `npm run setup:reset` wipes onboarding state for repeat testing; gated `/api/setup/reset` HTTP counterpart.
- The chat pane can now send plain chat turns directly to the selected AI destination, including Codex and Claude Code, without routing through OpenClaw preview approval.

### Changed

- `install.sh` trimmed from 554 lines to ~82; fully non-interactive.
- `dashboard/project` redirects to `/setup` when the brain is missing instead of showing a half-working UI.
- Sidebar Reasoning icon swapped from a magnifying-glass-on-document to a two-network glyph (a larger graph alongside a smaller one), reflecting that the reasoning audit shows how a model produces a derived trace.
- The `scienceswarm status` health probe now respects HTTPS local frontends, so healthy self-signed local installs report `Frontend health: ok`.
- `scienceswarm start`, `scienceswarm status`, install output, and README setup instructions now point users at the exact `127.0.0.1` dashboard/setup URL and call out wrong-protocol local URLs.
- Local frontend startup now defaults to HTTP loopback instead of self-signed HTTPS. Browsers treat loopback HTTP as trustworthy, while untrusted self-signed local certificates can fail differently across Safari, Chrome, Firefox, and Edge. `FRONTEND_USE_HTTPS=true` remains available for explicit local TLS testing.
- Settings > Project AI destinations now shows explicit Claude Code, Codex, and Gemini CLI setup commands, making subscription-backed destination connection visible without asking ScienceSwarm to store provider tokens.

### Fixed

- OpenClaw thinking traces no longer replay stale assistant content into the next user turn on reused web conversations.
- Third-party chat now shows the privacy reminder once per project/destination and
  lets later conversation turns send without the destination review interrupting
  the composer flow.
- gbrain's runtime import now uses the exported engine factory and a single PGlite version, avoiding bundled extension lookups under `/_next/static/media/*.tar.gz` during Next.js development.
- Claude Code and Codex destination health now run native CLI auth checks, while ready subscription CLIs with provider-owned auth can be selected with clear first-send login copy instead of staying blocked as unknown.
- Subscription-native destination sends no longer inherit provider API-key env vars from the ScienceSwarm server process, so Codex, Claude Code, and Gemini CLI stay on their native CLI login paths.

### Removed

- `POST /api/brain/init` (folded into `POST /api/setup/bootstrap`).
- `CreateBrainSection`, `BrainProfileSection`, `FirstRunGuide` components.
- Interactive `install.sh` prompts and the agent-backend A/B/C picker.

## [0.1.1.0] - 2026-04-10

### Added
- Research Radar: daily personalized briefing system for AI researchers
- Conversation-first setup via Telegram ("keep me posted on X")
- Semantic ranking of signals against the user's second brain
- LLM-powered briefing synthesis with "why this matters to you" explanations
- Semantic Scholar API integration for arXiv paper enrichment
- Dashboard settings panel for managing topics, sources, and schedule
- Dashboard briefing view with save-to-brain, dismiss, and expand actions
- Passive feedback loop that adjusts topic weights from user interactions
- Scheduled briefing delivery via dream cycle integration
- API routes for Radar CRUD, on-demand briefing, and feedback
- Design spec and implementation plan for the Research Radar feature

## [0.1.0.0] - 2026-03-31

### Added
- Landing page with hero, feature grid, how-it-works, and CTA sections
- Project dashboard with create project flow and project listing
- Workflow execution interface with chat UI and skill quick-launch buttons
- Simulated skill outputs for /ship, /qa, /investigate, and /review
- Dark theme with cyan accent design system
- Responsive layout with sidebar navigation
