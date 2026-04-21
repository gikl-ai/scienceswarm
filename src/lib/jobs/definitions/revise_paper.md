You are running inside the ScienceSwarm custom sandbox. Your task is to
produce a targeted revision of the paper at gbrain slug `{{paper}}`
that addresses the findings in the approved revision plan at slug
`{{plan}}`, using the critique at slug `{{critique}}` for context.

Principles:

- Read the paper body via `gbrain get {{paper}}` so you see the full
  text exactly as the user uploaded it. Do not invent content that is
  not in the source.
- Read the plan body via `gbrain get {{plan}}` and enumerate the
  findings table. Every row with disposition `fix` is a required
  change; rows with `acknowledge` are context only, and rows with
  `reject` are out of scope for this pass.
- Read the critique body via `gbrain get {{critique}}` for the exact
  quoted evidence and suggested fix for each finding. Do not paraphrase
  the critique's language when the plan asks you to address a specific
  point.
- Generate a unified diff against the paper's source (`.tex` if one is
  attached as a file_upload, otherwise the extracted markdown body).
  The diff must target ONLY the lines the plan lists; a full rewrite
  is a failure and you should stop and ask the user instead.
- Apply the diff with `patch -p0 < revision.patch` and then compile
  with `pdflatex paper.tex && pdflatex paper.tex` (twice for refs).
- Write the revised body back to gbrain as a new page with slug
  `{{paper}}-revision` and `type: revision`. The frontmatter must
  include `parent: {{paper}}`, `plan: {{plan}}`, and list the sha256
  of any file_upload attachments in `artifact_files`.
- Upload the revised PDF via gbrain `file_upload` linked to the new
  revision slug.
- Link the revision back to the paper via
  `gbrain link {{paper}}-revision {{paper}} --link_type revises`.

Constraints:

- Heavy compute stays in the sandbox. No host-side execution.
- Per-action timeout is 300 seconds (`SANDBOX_TIMEOUT=300`).
- Every finding in the plan that is marked `fix` must be addressed;
  if you cannot address one without rewriting the whole paragraph,
  stop and return an error in the footer.
- Do not implement findings marked `reject`.
- Do NOT modify anything outside the diff scope.
- The diff must touch < 30% of the source lines; larger diffs are a
  refactor, not a revision, and should fail the run.

When you are done, end your final message with a fenced JSON footer
listing the slugs you wrote and the sha256s of any file_uploads:

```json
{"slugs": ["{{paper}}-revision"], "files": ["<sha256>"]}
```
