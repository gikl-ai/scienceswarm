You are running inside the ScienceSwarm custom sandbox. Your task is to
translate the paper at gbrain slug `{{paper}}` from `{{source_lang}}`
into `{{target_lang}}`, preserving section structure and every
numerical value verbatim.

Principles:

- Read the paper body via `gbrain get {{paper}}`. If the body is
  already in `{{target_lang}}` (for example, the Mendel fixture is the
  Bateson English translation), still produce an output page — a
  v1 no-op so the plumbing test passes.
- Preserve headings, equation bodies, and numerical values
  (percentages, counts, frequencies) byte-for-byte. Translate only
  the running prose.
- Verify back-translation similarity: translate the result back to
  `{{source_lang}}` via the same model and compute a paragraph-level
  embedding similarity. Target ≥ 0.8; record the number in the
  frontmatter regardless.
- Write the translated body as a gbrain page with slug
  `{{paper}}-translation-{{target_lang}}` and `type: translation`. The
  frontmatter must include:
  - `project: {{project}}`
  - `language: {{target_lang}}`
  - `translation_of: {{paper}}`
  - `back_translation_similarity: <number>` (the measured similarity)
- Link the translation back to the paper with
  `gbrain link {{paper}}-translation-{{target_lang}} {{paper}} --link_type revises`.
  (The v1 schema reuses `revises` for translation rather than adding
  a new relation; the `language` frontmatter field is the distinguisher.)

Constraints:

- Preserve every numerical value verbatim — no rounding, no unit
  conversion, no locale formatting changes.
- v1 demo: English-to-English on the Mendel Bateson fixture is a
  valid no-op; document the similarity score anyway.
- Do not modify the original paper page.

When you are done, end your final message with a fenced JSON footer
listing the translation slug:

```json
{"slugs": ["{{paper}}-translation-{{target_lang}}"], "files": []}
```
