---
name: scienceswarm-capture
description: 'Help users capture research notes, papers, and ideas into the Second Brain. Use when someone asks about saving notes, uploading papers, brain setup, wiki pages, or knowledge management.'
metadata:
  openclaw:
    emoji: "🧠"
---

# ScienceSwarm — Capture & Second Brain

## What is the Second Brain?

The Second Brain is a three-pillar knowledge system:

1. **Wiki**: Markdown pages with wikilinks (`[[page]]`) for connected knowledge
2. **Search**: gbrain-backed keyword and semantic search over captured sources
3. **Memory**: Structured captures from Telegram, files, and conversations

Data lives at `BRAIN_ROOT` (default:
`${SCIENCESWARM_DIR:-$HOME/.scienceswarm}/brain`) with the
local gbrain PGLite database at `BRAIN_ROOT/brain.pglite/`.

## Capturing via Telegram

Send any text or document to the ScienceSwarm Telegram bot:

- **Text messages**: Automatically parsed, categorized, and saved as captures
- **PDF files**: Extracted, parsed, and stored with metadata
- **Notes**: Quick thoughts saved to the inbox for later linking

The bot replies with the capture path and any study it was linked to.

## Brain Setup

### Via Telegram
Send `"set up my brain"` or `"set up my research brain"` to the bot. If
gbrain is initialized, it auto-connects. Otherwise it guides you through the
ScienceSwarm setup flow.

```bash
npm run install:gbrain
```

### Via CLI

Use ScienceSwarm-owned entry points:

- `npm run install:gbrain` for first-time setup.
- `/api/brain/capture` or `brain_capture` for notes, observations, and
  decisions.
- the study import flow for local folders and paper collections.
- `/api/brain/status` or `/api/brain/health-report` for health checks.

## Study Linking

Captures can be linked to studies. When the bot can't determine the study:
- It saves to the inbox without linking
- Asks which study to associate with
- Lists available studies for selection

## Wiki & Backlinks

The wiki supports:
- Markdown pages in `{BRAIN_ROOT}/wiki/`
- Wikilinks: `[[page-name]]` creates connections between pages
- Backlink health scoring: tracks missing links and orphaned pages
- Entity detection: auto-identifies papers, people, concepts

## Brain Health

The brain health system monitors:
- Page count and last sync time
- Backlink integrity (missing links, orphaned pages)
- gbrain score and embedding coverage
- Missing embeddings, stale pages, orphan pages, and dead links

Access via `/api/brain/status`, `/api/brain/health-report`, or the dashboard.

## Search Detail

ScienceSwarm uses gbrain v0.10 search detail levels:

- `detail=low` for exact lookup and "do we already have this?"
- `detail=medium` for normal user answers
- `detail=high` for evidence-heavy critique, literature review, and briefs

Search results may include `chunkId` and `chunkIndex`. Preserve those as
internal evidence handles, but pair them with page paths, source titles, or
URLs before presenting claims to the user.

## Troubleshooting

- **"No brain configured"**: Run `npm run install:gbrain` or send "set up my brain" to the bot
- **File upload fails**: Check file size (Telegram limit) and supported formats (PDF, text)
- **Captures not linking**: Ensure the target study exists in ScienceSwarm
