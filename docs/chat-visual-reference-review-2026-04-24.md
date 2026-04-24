# Chat Visual Reference Review

Date: 2026-04-24

## Inputs

- Local ScienceSwarm screenshots from the current chat canvas and assistant lane
- Local Codex app screenshot shared in the active implementation thread
- ChatGPT web screenshot shared in the active implementation thread

## What Already Moved In The Right Direction

- The assistant lane now sits on a lighter white canvas instead of a heavy dashboard card.
- User turns remain visually distinct from assistant turns.
- Final-answer markdown already has stronger heading, list, link, quote, and code styling than the earlier flat transcript.
- Media now stays inside the chat column instead of overflowing the assistant lane.

## Remaining Gaps

| Surface | Codex / ChatGPT reference | ScienceSwarm gap | Next code area |
| --- | --- | --- | --- |
| Active run state | One compact live status surface with elapsed time and concise activity | Run state still feels split between page-level status, transcript rows, and footer metadata | `src/app/dashboard/project/page.tsx`, `src/hooks/use-unified-chat.ts` |
| Assistant body rhythm | Replies read like structured notes with stronger vertical spacing between sections | Multi-section answers still feel denser than ChatGPT web in longer replies | `src/components/research/chat-message.tsx` |
| Metadata emphasis | Timestamps and action chrome stay visually quiet | Footer metadata still competes slightly with the answer body | `src/components/research/chat-message.tsx` |
| Transcript polish | Progress copy reads like one narrative stream | Progress and narration still need tighter grouping to feel like one continuous assistant lane | `src/hooks/use-unified-chat.ts`, `src/components/research/chat-message.tsx` |
| Composer relationship | Input surface feels tightly anchored to the conversation | Composer is cleaner now, but the active transcript and composer boundary can still feel slightly detached | `src/app/dashboard/project/page.tsx` |
| Multimodal cadence | Images and attachments feel like part of the answer structure | Media layout is contained, but long answers still need more deliberate transitions into galleries and embeds | `src/components/research/chat-message.tsx` |

## Highest-Value Next Steps

1. Finish the active assistant-body spacing work so long replies breathe more like ChatGPT web.
2. Finish metadata de-emphasis so timestamps and copy controls stop pulling the eye before the content.
3. Replace duplicate run-state surfaces with one primary live status row.
4. Coalesce progress narration so the assistant lane feels like one transcript instead of a styled status dump.

## Concrete Follow-On PR Candidates

| Candidate | Goal | Primary files |
| --- | --- | --- |
| Answer Section Rhythm | Add calmer spacing between headings, lists, paragraphs, and media groups | `src/components/research/chat-message.tsx`, `tests/components/chat-message.test.tsx` |
| Metadata De-Emphasis | Push timestamps and message actions into a quieter visual layer | `src/components/research/chat-message.tsx`, `tests/components/chat-message.test.tsx` |
| Unified Run-State Surface | Collapse duplicate run-state chrome into one live status surface | `src/app/dashboard/project/page.tsx`, `src/hooks/use-unified-chat.ts`, related dashboard tests |
| Progress Coalescing | Group tool and status narration into fewer, clearer transcript rows | `src/hooks/use-unified-chat.ts`, `src/components/research/chat-message.tsx`, related hook/component tests |
