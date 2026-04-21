---
name: project-organizer
description: Use when the user asks to organize a project, identify the main research threads, look for duplicate papers, or suggest the next pages or tasks worth creating inside ScienceSwarm.
owner: scienceswarm
runtime: in-session
tools:
  - brain_project_organize
  - brain_capture
routes:
  - /api/brain/project-organizer
---

# project-organizer

## Purpose

Organize one ScienceSwarm project through natural language in the chat pane.
This skill is the project-workspace counterpart to `brain-maintenance`:
OpenClaw explains and coordinates, gbrain provides the durable project state,
and future execution work should go through the approved OpenHands path.

Use this skill for requests like:
- "Organize this project"
- "What are the main threads here?"
- "Show me duplicate papers"
- "Which exports are stale?"
- "What should I create next?"
- "Summarize what changed after import"

## Boundary Rules

1. **gbrain is the source of truth.** Base answers on project-scoped gbrain
   pages and the organizer tool output, not on guessed workspace folders.
2. **Stay honest about capabilities.** Do not claim stale-export detection,
   bulk cleanup, or file moves happened unless a real tool or job ran.
3. **OpenClaw talks to the user.** Keep the organizer summary concise and
   action-oriented in the conversation.
4. **Read-only first.** Start with `brain_project_organize(project)` before
   suggesting actions. Do not improvise thread clusters or duplicates without
   the tool output.
5. **Write only through gbrain.** If the user asks to create task or note
   pages from the organizer findings, use `brain_capture` after the read-only
   pass instead of inventing a separate write path.

## First Response Pattern

For an organizer request:

1. Call `brain_project_organize(project)`.
2. Report the top 1-3 findings:
   - candidate project threads
   - possible duplicate papers
   - next move / due tasks / frontier items
3. Suggest concrete follow-up prompts the user can ask next.
4. If the user asks to create follow-up task or note pages, write them with
   `brain_capture` and confirm the created titles succinctly.
5. If the user asks for a mutation the product does not yet automate, say so
   plainly and offer the closest supported read-only analysis instead.

## Communication Rules

- Prefer "candidate threads" and "possible duplicates" unless the evidence is
  unambiguous.
- Quote the organizer tool's real next move instead of inventing a better one.
- If no stable thread cluster is found, say that the project needs more linked
  pages, tags, or tasks before clustering becomes reliable.
- If no duplicates are found, say so directly.
- If the organizer reports that its page scan limit was reached, say the
  findings may be partial instead of implying full-project coverage.
- When creating task or note pages, keep them project-scoped and use titles
  taken from the organizer findings instead of inventing an unrelated taxonomy.

## Anti-Patterns

- Claiming the workspace was reorganized when only an analysis ran.
- Hallucinating duplicate papers or stale exports.
- Telling the user to open a different dashboard page when the organizer answer
  can be delivered inline.
