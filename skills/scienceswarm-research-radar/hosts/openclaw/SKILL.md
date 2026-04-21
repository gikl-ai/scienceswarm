---
name: scienceswarm-research-radar
description: 'Help users set up and use the Research Radar feature for personalized daily briefings. Use when someone asks about monitoring papers, getting research updates, configuring radar topics, or running on-demand briefings.'
metadata:
  openclaw:
    emoji: "📡"
---

# ScienceSwarm — Research Radar

## What is Research Radar?

Research Radar delivers personalized daily briefings by monitoring arXiv, bioRxiv, Semantic Scholar, Reddit, and RSS feeds. It filters signals by your research topics and delivers ranked results to Telegram or the dashboard.

## Setup via Telegram

Send one of these to the ScienceSwarm Telegram bot:

- `"set up my radar"` or `"keep me posted on [topic]"`
- `"set up my radar for mechanistic interpretability"`

The bot creates a radar config with default sources (arXiv cs.AI + cs.LG via Semantic Scholar, r/MachineLearning) and a daily 8am PT schedule. Additional sources are added automatically based on your topic keywords (e.g. interpretability adds cs.CL).

## Commands (Telegram)

| Message | Action |
|---|---|
| `"set up my radar"` | Create a new radar |
| `"what's on my radar"` | Check current radar status |
| `"briefing"` or `"what's new"` | Get an on-demand briefing now |
| `"save #3"` | Save item #3 from a briefing to your brain (coming soon) |
| `"add [topic] to my radar"` | Add a topic (coming soon) |
| `"stop tracking [topic]"` | Remove a topic (coming soon) |

## Radar Configuration

Each radar has:

- **Topics**: Research areas with name, description, and weight (0.0-1.0)
- **Sources**: arXiv, bioRxiv, Semantic Scholar, Reddit, RSS feeds
- **Schedule**: Cron expression + timezone (default: `0 8 * * *` America/Los_Angeles)
- **Channels**: Where to deliver (Telegram, dashboard)
- **Filters**: Exclude topics, language filters, minimum relevance

## How Briefings Work

1. **Fetch**: Sources are queried for recent signals (papers, posts, releases)
2. **Rank**: An LLM scores each signal against your topics for relevance
3. **Format**: Top signals are formatted as a briefing with "why it matters"
4. **Deliver**: Sent to Telegram and/or saved to the dashboard

Briefings include:
- **Matters now**: High-relevance signals to read today
- **On the horizon**: Interesting but not urgent signals
- Stats on signals fetched, ranked, and sources queried

## Dashboard Configuration

Visit `/dashboard/settings` to configure radar topics, sources, and schedule through the UI (when available).

## Troubleshooting

- **"No radar configured"**: Send "set up my radar" to the Telegram bot
- **Empty briefings**: Check that your topics have good descriptions and sources are reachable
- **Bot not responding**: Verify `TELEGRAM_BOT_TOKEN` is set and OpenClaw gateway is healthy (`openclaw health`)
