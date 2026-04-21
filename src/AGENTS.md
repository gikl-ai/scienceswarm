<!-- Parent: ../AGENTS.md -->

# src

Standard Next.js App Router layout. See root `AGENTS.md` for the source tree and conventions.

## Where to put new code
- **New API route** → `app/api/<name>/route.ts`
- **New page** → `app/<path>/page.tsx`
- **New reusable component** → `components/` (or `components/research/` if it's a workspace panel)
- **New API client or utility** → `lib/`
- **New shared types** — co-locate with the component that owns them, don't create standalone `types.ts` files

## Key entry points
- `app/dashboard/project/page.tsx` — the main workspace; owns all demo data and tab state (~550 lines)
- `lib/openhands.ts` — OpenHands API client; all agent routes depend on this
- `app/api/chat/route.ts` — contains the hardcoded system prompt for the research assistant
