# src

Standard Next.js App Router layout for the `src/` tree.

## Where to put new code
- **New API route** → `app/api/<name>/route.ts`
- **New page** → `app/<path>/page.tsx`
- **New reusable component** → `components/` (or `components/research/` if it's a workspace panel)
- **New API client or utility** → `lib/`
- **Paper Library API work** → `app/api/brain/paper-library/`
- **Paper Library workspace UI** → `components/research/paper-library/`
- **Paper Library domain logic** → `lib/paper-library/`
- **New shared types** — co-locate with the component that owns them, don't create standalone `types.ts` files

## Key entry points
- `app/dashboard/study/page.tsx` — the main study workspace; owns study data and tab state
- `app/dashboard/gbrain/page.tsx` — the gbrain workspace, including the Paper Library view
- `components/research/paper-library/command-center.tsx` — the Paper Library command center for scan, review, apply, graph, clusters, gaps, and history
- `lib/paper-library/` — local PDF archive organization, metadata enrichment, graph building, clustering, and gap detection helpers
- `lib/openhands.ts` — OpenHands API client; all agent routes depend on this
- `app/api/chat/unified/route.ts` — the primary scientist chat route and prompt/routing rules
