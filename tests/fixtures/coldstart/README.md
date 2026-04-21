# Coldstart Fixtures

Mixed-type sample corpus used by the per-module tests under
`tests/unit/coldstart/` and the warm-start E2E regression at
`tests/integration/warm-start-e2e.test.ts`. Keep every file under 50KB so the
suite stays fast.

Layout:

```
project-alpha/
  attention.pdf       — tiny fake PDF (binary header)
  notes.md            — markdown notes
  experiment.ipynb    — minimal notebook JSON
  results.csv         — small dataset
  2301.12345.pdf      — arXiv-style filename for paper detection
project-beta/
  protocol.md         — protocol-style markdown
  analysis.py         — analysis script
  data.json           — JSON dataset
unsupported.xyz       — unknown extension; should be ignored
```
