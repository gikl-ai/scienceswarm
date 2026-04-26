---
name: scientific-report-html
description: Render a typed JSON spec into a sophisticated, themed HTML report. Used by ScienceSwarm tutorials that want a polished output page alongside their raw scientific artifacts.
owner: scienceswarm
runtime: cli
entrypoint: python -m scientific_report
inputs:
  - spec: path to a JSON spec describing the report (see tooling/scientific_report/README.md for the schema)
  - out: output HTML file path
  - theme: optional theme override (default: spec.meta.theme or "broadsheet")
outputs:
  - HTML file at the specified --out path (single self-contained page)
themes:
  - broadsheet
---

# scientific-report-html

## Purpose

Renders a typed JSON spec describing a scientific run into a single
self-contained HTML report. Theme-driven so adjacent reports can have
deliberately different visual identities.

## When to use

- A ScienceSwarm tutorial has scientific artifacts (`.rds`, `.npz`, `.csv`,
  ...) and wants a polished, magazine-grade interactive output page on top
  of (not instead of) its raw artifacts.
- A research workflow needs to package its results into a single, sharable
  HTML file with embedded interactive plots, captions, validation tables,
  and a methodology explainer.
- The user asks for "a sophisticated modern presentation", "a beautiful
  output page", "a magazine-style report", "the modern version of the
  report", or similar.

## When NOT to use

- The tutorial already has a polished output and the user only wants to
  modify *that* output. Edit the existing renderer in place.
- The artifact is a one-off artifact for a research notebook (Jupyter,
  Quarto, R Markdown). Use the native rendering chain there.
- The output is a static publication PDF. Use a TeX/Pandoc/Quarto pipeline.

## How to invoke

The skill is a Python CLI. From the repository root:

```bash
python -m scientific_report --spec path/to/spec.json --out path/to/report.html
```

Optionally pin a theme:

```bash
python -m scientific_report --spec spec.json --out report.html --theme broadsheet
```

The Python module lives at `tooling/scientific_report/`. No runtime
dependencies beyond the standard library — generated HTML loads Plotly
and Google Fonts from CDNs at view time.

## Spec format

Defined in `tooling/scientific_report/README.md`. In short: a single
JSON object with `meta`, `hero`, `cases[]`, `summary_table[]`,
`validation_gates[]`, `explainer`, `glossary[]`, `references[]`. Per-case
fields support a `trajectory`, donor `weights`, `placebo_distribution`, and
`methods` forest plot — all designed for synthetic-control-style
counterfactual analyses, but reusable for any case-by-case scientific
report by ignoring the optional fields.

Each tutorial supplies its own *exporter* (in R, Python, or whatever
language the tutorial uses) that reads its native artifacts and writes a
spec JSON. The renderer is a single shared Python tool.

## Themes

| Theme        | Visual direction                                                                                  |
|---           |---                                                                                                |
| `broadsheet` | Warm cream policy-journal — DM Serif Display + Source Serif 4 + IBM Plex Mono; navy + signature red + mustard accents |

## Adding a theme

See `tooling/scientific_report/README.md`.
