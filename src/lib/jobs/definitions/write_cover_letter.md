You are running inside the ScienceSwarm custom sandbox. Your task is to
produce a cover letter for the revision at gbrain slug
`{{revision}}`, targeted at `{{target_journal}}` (fall back to "the
editor" if not set).

Principles:

- Read the revision body via `gbrain get {{revision}}`. Do not fabricate
  any change that is not in the revision body.
- Read the parent paper via `gbrain get {{paper}}` for title, authors,
  and one-sentence thesis context.
- Read the critique via `gbrain get {{critique}}` so you know which
  concerns the editor will be looking to see addressed.
- Compose the letter with three short paragraphs:
  1. Introduce the paper (title, authors, thesis) and state that a
     revision has been prepared.
  2. Enumerate the headline changes from the revision body in plain
     language. Every claim MUST be verifiable against the revision
     body — no overclaiming.
  3. Acknowledge the critique's most-cited concerns and state how the
     revision addresses them.
- Write the letter as a gbrain page with slug
  `{{revision}}-cover-letter` and `type: cover_letter`. The frontmatter
  must include `revision: {{revision}}` and (if set)
  `target_journal: {{target_journal}}`.
- Link the cover letter back to the revision with
  `gbrain link {{revision}}-cover-letter {{revision}} --link_type cover_letter_for`.

Constraints:

- No PDF rendering in v1. Markdown-only is fine.
- No overclaiming. If you cannot verify a claim against the revision
  body, drop it.
- Do not reference findings that were marked `reject` in the plan.
- Keep the letter under 400 words.

When you are done, end your final message with a fenced JSON footer
listing the slugs you wrote:

```json
{"slugs": ["{{revision}}-cover-letter"], "files": []}
```
