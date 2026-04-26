"""Broadsheet theme — warm cream policy-journal aesthetic.

Visual direction is "causal-inference policy brief":

  - Cream paper (not white, not blue-black) with a faint warm grain texture
  - Deep navy as primary text, signature red as scarce accent on treated
    units / verdicts, mustard for placebos and treatment-year markers,
    muted teal as third color
  - DM Serif Display for the masthead and large numerals (high-contrast
    transitional serif, signals "broadsheet/journal")
  - Source Serif 4 for body (book-quality serif)
  - Inter Tight for kickers, captions, UI labels, masthead bar
  - IBM Plex Mono for numerical readouts (NOT JetBrains Mono — different
    signature from the SYK report)

Layout direction:

  - Top "policy journal" masthead bar with date / issue / topic
  - Hero with oversized treatment label, headline sentence, verdict pill,
    KPI strip
  - Each case is a vertically stacked broadsheet "slab" (no tab switcher
    by default — different from the original SCM-IR report) with:
        - Counterfactual chart + interpretation card
        - Donor-weights chart + placebo histogram side-by-side
        - Method-comparison forest plot
        - Auto-generated Methods paragraph in italic on cream card
  - Cross-case summary table (red header bar)
  - Two-column print-style explainer at the bottom
  - Colophon footer
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import json as _json
from typing import Any


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _esc(s: Any) -> str:
    """HTML-escape a value, returning empty string for None."""
    if s is None:
        return ""
    return _html.escape(str(s), quote=True)


def _verdict_color(verdict: str) -> str:
    return {
        "detectable": "var(--ink-red)",
        "fragile": "var(--ink-mustard)",
        "null": "var(--ink-graphite)",
    }.get(verdict, "var(--ink-graphite)")


def _verdict_label(verdict: str) -> str:
    return {
        "detectable": "Detectable",
        "fragile": "Fragile",
        "null": "Null",
    }.get(verdict, verdict.title() if verdict else "")


def _section_kicker(idx: int) -> str:
    """Roman-numeral-flavored section kickers — broadsheet print convention."""
    roman = {1: "I", 2: "II", 3: "III", 4: "IV", 5: "V",
             6: "VI", 7: "VII", 8: "VIII", 9: "IX", 10: "X"}
    return roman.get(idx, str(idx))


# ---------------------------------------------------------------------------
# Top-level render
# ---------------------------------------------------------------------------


def render(spec: dict[str, Any]) -> str:
    meta = spec.get("meta", {})
    hero = spec.get("hero", {})
    cases = spec.get("cases", [])
    summary_table = spec.get("summary_table") or []
    explainer = spec.get("explainer", {})
    validation_gates = spec.get("validation_gates") or []
    glossary = spec.get("glossary") or []
    refs = spec.get("references") or []

    title = meta.get("title", "Scientific Report")
    subtitle = meta.get("subtitle", "")
    kicker = meta.get("kicker", "Scientific Brief")
    date = meta.get("date") or _dt.date.today().isoformat()
    issue = meta.get("issue", "")
    generated_at = meta.get("generated_at") or _dt.datetime.now().strftime("%Y-%m-%d %H:%M")

    # The renderer hands every plot's data structure off to client-side JS via
    # an embedded <script type="application/json"> island, then JS turns each
    # entry into a Plotly figure.
    plot_payload = _build_plot_payload(cases)

    head = _build_head(title)
    masthead = _build_masthead(kicker, date, issue, generated_at)
    hero_html = _build_hero(meta, hero)
    cases_html = "\n".join(
        _build_case_slab(idx, c)
        for idx, c in enumerate(cases, start=1)
    )
    summary_html = _build_summary_table(summary_table) if summary_table else ""
    validation_html = _build_validation(validation_gates) if validation_gates else ""
    explainer_html = _build_explainer(explainer) if explainer else ""
    glossary_html = _build_glossary(glossary) if glossary else ""
    footer_html = _build_colophon(meta, refs)
    plot_data_block = (
        '<script id="report-plot-data" type="application/json">'
        + _json.dumps(plot_payload)
        + "</script>"
    )

    return _PAGE_TEMPLATE.format(
        head=head,
        masthead=masthead,
        hero=hero_html,
        cases=cases_html,
        summary=summary_html,
        validation=validation_html,
        explainer=explainer_html,
        glossary=glossary_html,
        footer=footer_html,
        plot_data=plot_data_block,
        plot_js=_PLOT_JS,
    )


# ---------------------------------------------------------------------------
# Section builders
# ---------------------------------------------------------------------------


def _build_head(title: str) -> str:
    return f"""<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>{_esc(title)} — A Scientific Brief</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Source+Serif+4:ital,opsz,wght@0,8..60,300..900;1,8..60,300..900&family=Inter+Tight:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
{_CSS}
</style>
</head>"""


def _build_masthead(kicker: str, date: str, issue: str, generated_at: str) -> str:
    return f"""<header class="masthead">
  <div class="container masthead-row">
    <span class="masthead-left">{_esc(kicker)}</span>
    <span class="masthead-center">{_esc(issue)}</span>
    <span class="masthead-right">{_esc(date)}</span>
  </div>
  <div class="masthead-rule"></div>
</header>"""


def _build_hero(meta: dict, hero: dict) -> str:
    title = meta.get("title", "")
    subtitle = meta.get("subtitle", "")
    headline = hero.get("headline", "")
    lede = hero.get("lede", "")
    metrics = hero.get("metrics") or []
    drop_letter = (headline.strip()[:1] or "T").upper()
    headline_rest = headline.strip()[1:] if headline.strip() else ""

    metrics_html = ""
    if metrics:
        items = "".join(
            f"""<div class="kpi">
              <div class="kpi-label">{_esc(m.get('label',''))}</div>
              <div class="kpi-value">{_esc(m.get('value',''))}</div>
              <div class="kpi-note">{_esc(m.get('note',''))}</div>
            </div>"""
            for m in metrics
        )
        metrics_html = f'<div class="kpi-strip">{items}</div>'

    return f"""<section class="hero">
  <div class="container">
    <div class="hero-grid">
      <div class="hero-eyebrow">
        <span class="eyebrow-line"></span>
        <span class="eyebrow-text">A Causal-Inference Brief</span>
      </div>
      <h1 class="hero-title">
        <span class="hero-title-main">{_esc(title)}</span>
      </h1>
      <p class="hero-subtitle">{_esc(subtitle)}</p>
      <div class="hero-divider"></div>
      <div class="hero-body">
        <p class="hero-lede">
          <span class="dropcap">{_esc(drop_letter)}</span>{_esc(headline_rest)}
        </p>
        <p class="hero-lede-2">{_esc(lede)}</p>
      </div>
    </div>
    {metrics_html}
  </div>
</section>"""


def _build_case_slab(idx: int, c: dict) -> str:
    cid = c.get("id", f"case{idx}")
    display_name = c.get("display_name", cid)
    treated_unit = c.get("treated_unit", "")
    treatment_year = c.get("treatment_year", "")
    outcome_label = c.get("outcome_label", "")
    verdict = (c.get("verdict") or "").lower()
    verdict_label = _verdict_label(verdict)
    headline = c.get("headline", "")
    interpretation = c.get("interpretation", "")
    methods_paragraph = c.get("methods_paragraph", "")
    kpis = c.get("kpis") or []

    # Render KPI ribbon
    kpi_items = "".join(
        f"""<div class="case-kpi">
            <div class="case-kpi-label">{_esc(k.get('label',''))}</div>
            <div class="case-kpi-value">{_esc(k.get('value',''))}</div>
            {f'<div class="case-kpi-note">{_esc(k.get("note",""))}</div>' if k.get('note') else ''}
        </div>"""
        for k in kpis
    )
    kpi_strip = f'<div class="case-kpi-strip">{kpi_items}</div>' if kpi_items else ""

    fig_traj = f'<div class="plot-frame plot-traj"><div id="plot-traj-{_esc(cid)}" class="plot"></div></div>' if c.get("trajectory") else ""
    fig_weights = f'<div class="plot-frame plot-weights"><div id="plot-weights-{_esc(cid)}" class="plot"></div></div>' if c.get("weights") else ""
    fig_placebo = f'<div class="plot-frame plot-placebo"><div id="plot-placebo-{_esc(cid)}" class="plot"></div></div>' if c.get("placebo_distribution") else ""
    fig_methods = f'<div class="plot-frame plot-methods"><div id="plot-methods-{_esc(cid)}" class="plot"></div></div>' if c.get("methods") else ""

    methods_card = ""
    if methods_paragraph:
        methods_card = f"""<aside class="methods-card">
          <div class="methods-card-label">Auto-generated Methods paragraph</div>
          <p class="methods-card-body">{_esc(methods_paragraph)}</p>
        </aside>"""

    interp_card = ""
    if interpretation:
        interp_card = f"""<aside class="interp-card">
          <div class="interp-card-label">Interpretation</div>
          <p class="interp-card-body">{_esc(interpretation)}</p>
        </aside>"""

    return f"""<section class="case-slab" id="case-{_esc(cid)}">
  <div class="container">
    <div class="case-head">
      <div class="case-num">{_section_kicker(idx)}</div>
      <div class="case-meta">
        <div class="case-eyebrow">Case Study {idx} &nbsp;·&nbsp; {_esc(treated_unit)}</div>
        <h2 class="case-title">{_esc(display_name)}</h2>
        <p class="case-headline">{_esc(headline)}</p>
      </div>
      <div class="case-badge">
        <div class="case-year-label">Treatment</div>
        <div class="case-year-value">{_esc(treatment_year)}</div>
        <div class="verdict verdict-{_esc(verdict)}">{_esc(verdict_label.upper())}</div>
      </div>
    </div>

    {kpi_strip}

    <div class="case-fig-row case-fig-row-1">
      <div class="case-fig-traj-wrap">
        {fig_traj}
        <p class="figure-caption">
          <span class="fig-num">Figure {idx}.1</span> Counterfactual trajectory.
          Treated unit ({_esc(treated_unit)}, in red) versus the synthetic
          control (dashed navy) plus the donor-placebo cloud (warm grey).
          Mustard rule marks the treatment year, {_esc(treatment_year)}.
        </p>
      </div>
      {interp_card}
    </div>

    <div class="case-fig-row case-fig-row-2">
      <div class="case-fig-half">
        {fig_weights}
        <p class="figure-caption">
          <span class="fig-num">Figure {idx}.2</span> Donor-pool weights —
          which units the synthetic control draws from, and in what proportion.
        </p>
      </div>
      <div class="case-fig-half">
        {fig_placebo}
        <p class="figure-caption">
          <span class="fig-num">Figure {idx}.3</span> Placebo distribution —
          post/pre RMSPE ratio under random reassignment.
          {_esc(treated_unit)} marked in red.
        </p>
      </div>
    </div>

    <div class="case-fig-row case-fig-row-3">
      <div class="case-fig-methods-wrap">
        {fig_methods}
        <p class="figure-caption">
          <span class="fig-num">Figure {idx}.4</span> Method comparison.
          ATT estimate by classic SCM, generalized SCM, synthetic difference-
          in-differences, and doubly-robust SC where available.
        </p>
      </div>
      {methods_card}
    </div>
  </div>
</section>"""


def _build_summary_table(rows: list[dict]) -> str:
    if not rows:
        return ""
    body = "\n".join(
        f"""<tr>
          <td><span class="row-case">{_esc(r.get('case',''))}</span></td>
          <td>{_esc(r.get('treated_unit',''))}</td>
          <td class="num">{_esc(r.get('treatment_year',''))}</td>
          <td class="num">{_esc(r.get('post_pre_ratio',''))}</td>
          <td class="num">{_esc(r.get('placebo_p',''))}</td>
          <td><span class="verdict verdict-{_esc((r.get('verdict') or '').lower())}">{_esc(_verdict_label((r.get('verdict') or '').lower()).upper())}</span></td>
        </tr>"""
        for r in rows
    )
    return f"""<section class="summary">
  <div class="container">
    <div class="section-eyebrow"><span class="dot"></span> Cross-Case Summary</div>
    <h2 class="section-title">All three cases at a glance.</h2>
    <table class="summary-table">
      <thead>
        <tr>
          <th>Case</th>
          <th>Treated unit</th>
          <th class="num">T<sub>0</sub></th>
          <th class="num">Post / Pre RMSPE</th>
          <th class="num">Placebo p</th>
          <th>Verdict</th>
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  </div>
</section>"""


def _build_validation(rows: list[dict]) -> str:
    items = "\n".join(
        f"""<li class="gate gate-{_esc('pass' if r.get('passed') else 'fail')}">
          <span class="gate-status">{'PASS' if r.get('passed') else 'FAIL'}</span>
          <span class="gate-name">{_esc(r.get('name',''))}</span>
          <span class="gate-detail">{_esc(r.get('detail',''))}</span>
        </li>"""
        for r in rows
    )
    return f"""<section class="validation">
  <div class="container">
    <div class="section-eyebrow"><span class="dot"></span> Validation</div>
    <h2 class="section-title">Every gate the run had to pass.</h2>
    <ul class="gate-list">{items}</ul>
  </div>
</section>"""


def _build_explainer(explainer: dict) -> str:
    title = explainer.get("title", "How this works")
    paragraphs = explainer.get("paragraphs") or []
    body = "".join(f"<p>{_esc(p)}</p>" for p in paragraphs)
    return f"""<section class="explainer">
  <div class="container">
    <div class="section-eyebrow"><span class="dot"></span> Methodology</div>
    <h2 class="section-title">{_esc(title)}</h2>
    <div class="two-column">{body}</div>
  </div>
</section>"""


def _build_glossary(glossary: list[dict]) -> str:
    items = "\n".join(
        f"""<dl class="glossary-entry">
          <dt>{_esc(g.get('term',''))}</dt>
          <dd>{_esc(g.get('definition',''))}</dd>
        </dl>"""
        for g in glossary
    )
    return f"""<section class="glossary">
  <div class="container">
    <div class="section-eyebrow"><span class="dot"></span> Lexicon</div>
    <h2 class="section-title">A short reference of terms.</h2>
    <div class="glossary-grid">{items}</div>
  </div>
</section>"""


def _build_colophon(meta: dict, refs: list) -> str:
    refs_html = ""
    if refs:
        items = "\n".join(f"<li>{_esc(r)}</li>" for r in refs)
        refs_html = f'<div><h4>References</h4><ul>{items}</ul></div>'
    tutorial_id = meta.get("tutorial_id", "")
    generated_at = meta.get("generated_at", "")
    return f"""<footer class="colophon">
  <div class="container">
    <div class="colophon-rule"></div>
    <div class="colophon-grid">
      <div>
        <h4>Colophon</h4>
        <p>Set in DM Serif Display, Source Serif 4, Inter Tight, and IBM Plex Mono.
        Composed by the ScienceSwarm <code>scientific_report</code> renderer
        (theme: <em>broadsheet</em>).</p>
        <p class="meta-line">Tutorial: <code>{_esc(tutorial_id)}</code> &nbsp;·&nbsp; Generated {_esc(generated_at)}</p>
      </div>
      {refs_html}
    </div>
  </div>
</footer>"""


# ---------------------------------------------------------------------------
# Plot payload — the renderer dumps each case's plot data as JSON; the
# client-side script builds the Plotly figures with broadsheet styling.
# ---------------------------------------------------------------------------


def _build_plot_payload(cases: list[dict]) -> dict[str, Any]:
    payload: dict[str, Any] = {"cases": []}
    for c in cases:
        cid = c.get("id")
        entry = {
            "id": cid,
            "treated_unit": c.get("treated_unit"),
            "outcome_label": c.get("outcome_label"),
            "treatment_year": c.get("treatment_year"),
        }
        if c.get("trajectory"):
            entry["trajectory"] = c["trajectory"]
            # Allow placebo_band to be either nested in trajectory or top-level.
            if c.get("trajectory", {}).get("placebo_band"):
                entry["trajectory"] = c["trajectory"]
        if c.get("weights"):
            entry["weights"] = c["weights"]
        if c.get("placebo_distribution"):
            entry["placebo_distribution"] = c["placebo_distribution"]
        if c.get("methods"):
            entry["methods"] = c["methods"]
        payload["cases"].append(entry)
    return payload


# ---------------------------------------------------------------------------
# CSS (broadsheet theme)
# ---------------------------------------------------------------------------


_CSS = r"""
:root {
  --paper:        #fcf6e7;
  --paper-2:      #f6efdc;
  --paper-3:      #ede4cb;
  --rule:         #d6cdb4;
  --rule-strong:  #5d553f;
  --ink:          #0e2235;          /* deep navy */
  --ink-soft:     #2c3e50;
  --ink-mid:      #5b6b80;
  --ink-faint:    #87918e;
  --ink-graphite: #6b7177;
  --ink-red:      #c63b35;
  --ink-red-dark: #8a2620;
  --ink-mustard:  #c08e25;
  --ink-mustard-soft: #d8b35a;
  --ink-teal:     #2e6f6e;
  --ink-cream:    #fff9ea;

  --shadow-paper: 0 2px 0 rgba(0,0,0,0.02), 0 22px 50px -28px rgba(14,34,53,0.15);
}

* { box-sizing: border-box; }

html, body {
  background: var(--paper);
  color: var(--ink);
  margin: 0; padding: 0;
  font-family: 'Source Serif 4', 'Source Serif Pro', Georgia, serif;
  font-variation-settings: 'opsz' 18, 'wght' 400;
  font-size: 17.5px;
  line-height: 1.62;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-feature-settings: "liga" 1, "kern" 1, "onum" 1;
}

body {
  background-image:
    radial-gradient(1100px 500px at 18% -10%, rgba(198,59,53,0.05), transparent 60%),
    radial-gradient(900px 600px at 92% 100%, rgba(46,111,110,0.05), transparent 60%);
}

/* Faint paper grain — SVG noise overlay */
body::before {
  content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9000;
  opacity: 0.08;
  mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.95' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0.4   0 0 0 0 0.32   0 0 0 0 0.20   0 0 0 1 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
}

.container {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 2rem;
  position: relative;
}
@media (min-width: 800px) { .container { padding: 0 3rem; } }
@media (min-width: 1200px) { .container { padding: 0 4rem; } }

/* ================ Type primitives ================ */
.serif-display {
  font-family: 'DM Serif Display', 'Tiempos Headline', Georgia, serif;
}
.serif-display-italic {
  font-family: 'DM Serif Display', Georgia, serif;
  font-style: italic;
}
.sans, .ui {
  font-family: 'Inter Tight', -apple-system, system-ui, sans-serif;
}
.mono {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-feature-settings: "tnum" 1, "ss01" 1;
}

.eyebrow-text, .section-eyebrow, .case-eyebrow,
.kpi-label, .case-kpi-label, .gate-status, .verdict,
.figure-caption .fig-num,
.masthead-left, .masthead-center, .masthead-right {
  font-family: 'Inter Tight', sans-serif;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  font-size: 0.66rem;
  color: var(--ink-mid);
}

.kpi-value, .case-kpi-value, .case-year-value, .num,
.summary-table td.num, .summary-table th.num {
  font-family: 'IBM Plex Mono', monospace;
  font-feature-settings: "tnum" 1, "ss01" 1;
}

/* ================ Masthead bar ================ */
.masthead {
  background: var(--paper-2);
  border-bottom: 1px solid var(--rule);
}
.masthead-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.7rem 0;
  font-family: 'Inter Tight', sans-serif;
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-mid);
}
.masthead-left  { font-weight: 700; color: var(--ink-red); }
.masthead-center { font-style: italic; letter-spacing: 0.18em; text-transform: none; font-family: 'Source Serif 4', serif; color: var(--ink-soft); }
.masthead-right { font-feature-settings: "tnum" 1; font-family: 'IBM Plex Mono', monospace; }
.masthead-rule {
  height: 4px;
  background:
    linear-gradient(to right, var(--ink-red) 0 30%, transparent 30% 32%, var(--ink) 32% 100%);
}

/* ================ Hero ================ */
.hero {
  padding: 5rem 0 4.5rem;
  border-bottom: 1px solid var(--rule);
  position: relative;
}
.hero-grid {
  max-width: 1080px;
}
.hero-eyebrow {
  display: flex; align-items: center; gap: 0.85rem;
  margin-bottom: 1.4rem;
}
.eyebrow-line {
  display: inline-block; height: 2px; width: 40px;
  background: var(--ink-red);
}
.eyebrow-text {
  color: var(--ink-red);
  font-size: 0.72rem;
}
.hero-title {
  font-family: 'DM Serif Display', Georgia, serif;
  font-weight: 400;
  font-size: clamp(2.6rem, 6.4vw, 5.4rem);
  line-height: 1.02;
  letter-spacing: -0.012em;
  color: var(--ink);
  margin: 0 0 0.4rem 0;
  max-width: 18ch;
}
.hero-subtitle {
  font-family: 'DM Serif Display', Georgia, serif;
  font-style: italic;
  font-weight: 400;
  font-size: clamp(1.15rem, 2vw, 1.5rem);
  line-height: 1.35;
  color: var(--ink-mid);
  max-width: 60ch;
  margin: 0;
}
.hero-divider {
  height: 2px;
  width: 84px;
  background: var(--ink-red);
  margin: 1.7rem 0 1.6rem;
}
.hero-body {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
  max-width: 65ch;
}
@media (min-width: 1100px) {
  .hero-body { grid-template-columns: 1.1fr 1fr; gap: 2.5rem; }
}
.hero-lede {
  font-size: 1.18rem;
  line-height: 1.55;
  color: var(--ink);
  margin: 0;
}
.dropcap {
  font-family: 'DM Serif Display', Georgia, serif;
  float: left;
  font-size: 4.7rem;
  line-height: 0.85;
  margin: 0.18rem 0.55rem 0 -0.05rem;
  color: var(--ink-red);
}
.hero-lede-2 {
  font-size: 1.02rem;
  line-height: 1.6;
  color: var(--ink-mid);
  margin: 0;
}

/* KPI strip */
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  margin-top: 3rem;
}
@media (min-width: 700px)  { .kpi-strip { grid-template-columns: repeat(4, 1fr); } }
.kpi {
  padding: 1.4rem 1.4rem;
  border-right: 1px solid var(--rule);
}
.kpi:last-child { border-right: none; }
@media (max-width: 699px) { .kpi:nth-child(2n) { border-right: none; } }
.kpi-label { color: var(--ink-mid); }
.kpi-value {
  font-family: 'DM Serif Display', Georgia, serif;
  font-size: 2.4rem;
  line-height: 1;
  color: var(--ink);
  margin-top: 0.5rem;
  font-feature-settings: "tnum" 1;
}
.kpi-note {
  margin-top: 0.35rem;
  font-size: 0.78rem;
  color: var(--ink-faint);
  font-style: italic;
}

/* ================ Case slabs ================ */
.case-slab {
  padding: 5rem 0 5rem;
  border-bottom: 1px solid var(--rule);
}
.case-slab:nth-child(odd) {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.6), transparent 200px),
    var(--paper);
}
.case-slab:nth-child(even) {
  background: var(--paper-2);
}

.case-head {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 2rem;
  align-items: end;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 2.5rem;
}
.case-num {
  font-family: 'DM Serif Display', Georgia, serif;
  font-size: clamp(4rem, 9vw, 7.5rem);
  line-height: 0.78;
  color: var(--ink-red);
  font-feature-settings: "smcp" 1;
  letter-spacing: 0;
}
.case-meta { padding-bottom: 0.5rem; }
.case-eyebrow {
  font-family: 'Inter Tight', sans-serif;
  font-size: 0.72rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-mid);
}
.case-title {
  font-family: 'DM Serif Display', Georgia, serif;
  font-weight: 400;
  font-size: clamp(2rem, 4vw, 3.2rem);
  line-height: 1.05;
  color: var(--ink);
  margin: 0.3rem 0 0.6rem 0;
}
.case-headline {
  font-style: italic;
  color: var(--ink-mid);
  font-size: 1.1rem;
  line-height: 1.4;
  margin: 0;
  max-width: 55ch;
}
.case-badge {
  text-align: right;
}
.case-year-label {
  font-family: 'Inter Tight', sans-serif;
  font-size: 0.65rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 0.25rem;
}
.case-year-value {
  font-family: 'DM Serif Display', Georgia, serif;
  font-size: 3rem;
  line-height: 1;
  color: var(--ink);
  font-feature-settings: "tnum" 1;
  margin-bottom: 0.55rem;
}
.verdict {
  display: inline-block;
  padding: 0.36rem 0.85rem;
  font-family: 'Inter Tight', sans-serif;
  font-weight: 700;
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  border-radius: 999px;
  border: 1.5px solid currentColor;
}
.verdict-detectable { color: var(--ink-red); background: rgba(198,59,53,0.07); }
.verdict-fragile    { color: var(--ink-mustard); background: rgba(192,142,37,0.08); }
.verdict-null       { color: var(--ink-graphite); background: rgba(107,113,119,0.07); }

.case-kpi-strip {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  margin-bottom: 3rem;
}
@media (min-width: 700px) { .case-kpi-strip { grid-template-columns: repeat(3, 1fr); } }
.case-kpi {
  padding: 1.1rem 1.3rem;
  border-right: 1px solid var(--rule);
}
.case-kpi:last-child { border-right: none; }
@media (max-width: 699px) { .case-kpi:nth-child(2n) { border-right: none; } }
.case-kpi-label { color: var(--ink-mid); }
.case-kpi-value {
  font-family: 'IBM Plex Mono', monospace;
  font-weight: 500;
  font-size: 1.65rem;
  color: var(--ink);
  margin-top: 0.32rem;
}
.case-kpi-note {
  margin-top: 0.18rem;
  font-size: 0.78rem;
  color: var(--ink-faint);
  font-style: italic;
}

/* Case figures layout */
.case-fig-row {
  display: grid;
  gap: 2rem;
  margin-bottom: 2.6rem;
}
.case-fig-row-1 { grid-template-columns: 1fr; }
@media (min-width: 1000px) { .case-fig-row-1 { grid-template-columns: 1.6fr 1fr; } }

.case-fig-row-2 { grid-template-columns: 1fr; }
@media (min-width: 800px) { .case-fig-row-2 { grid-template-columns: 1fr 1fr; } }

.case-fig-row-3 { grid-template-columns: 1fr; }
@media (min-width: 1000px) { .case-fig-row-3 { grid-template-columns: 1.6fr 1fr; } }

.plot-frame {
  background: var(--paper);
  border: 1px solid var(--rule);
  padding: 0.85rem;
  position: relative;
  box-shadow: var(--shadow-paper);
}
.case-slab:nth-child(even) .plot-frame { background: var(--paper); }
.plot-frame::before, .plot-frame::after {
  content: ""; position: absolute; width: 12px; height: 12px;
  border: 1.5px solid var(--ink-red);
}
.plot-frame::before { top: -1.5px; left: -1.5px; border-right: 0; border-bottom: 0; }
.plot-frame::after  { top: -1.5px; right: -1.5px; border-left: 0; border-bottom: 0; }
.plot-frame .plot { width: 100%; height: 380px; }
.plot-traj .plot     { height: 440px; }
.plot-methods .plot  { height: 340px; }

.figure-caption {
  margin: 0.85rem 0 0;
  font-size: 0.92rem;
  color: var(--ink-mid);
  font-family: 'Source Serif 4', serif;
  font-style: italic;
  line-height: 1.45;
  max-width: 60ch;
}
.fig-num {
  color: var(--ink-red);
  font-style: normal;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-family: 'Inter Tight', sans-serif;
  font-weight: 600;
  font-size: 0.7rem;
  margin-right: 0.5rem;
}

.interp-card, .methods-card {
  background: var(--ink-cream);
  border: 1px solid var(--rule);
  padding: 1.6rem 1.8rem;
  position: relative;
  box-shadow: var(--shadow-paper);
}
.interp-card { border-left: 4px solid var(--ink-red); }
.methods-card { border-left: 4px solid var(--ink-teal); }

.interp-card-label, .methods-card-label {
  font-family: 'Inter Tight', sans-serif;
  font-weight: 700;
  font-size: 0.66rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-red);
  margin-bottom: 0.85rem;
}
.methods-card-label { color: var(--ink-teal); }

.interp-card-body, .methods-card-body {
  font-family: 'Source Serif 4', Georgia, serif;
  font-size: 1.04rem;
  line-height: 1.55;
  color: var(--ink);
  margin: 0;
  font-style: italic;
}

/* ================ Cross-case summary ================ */
.summary { padding: 4rem 0; border-bottom: 1px solid var(--rule); }
.section-eyebrow {
  display: flex; align-items: center; gap: 0.7rem;
  font-family: 'Inter Tight', sans-serif;
  font-size: 0.72rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-red);
  margin-bottom: 1rem;
}
.section-eyebrow .dot {
  display: inline-block; width: 8px; height: 8px; background: var(--ink-red);
  border-radius: 50%;
}
.section-title {
  font-family: 'DM Serif Display', Georgia, serif;
  font-weight: 400;
  font-size: clamp(2rem, 4vw, 3.1rem);
  line-height: 1.1;
  margin: 0 0 1.6rem 0;
  color: var(--ink);
  max-width: 22ch;
}

.summary-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--paper);
  margin-top: 2rem;
  border-top: 4px solid var(--ink-red);
}
.summary-table thead th {
  background: var(--ink);
  color: var(--paper);
  font-family: 'Inter Tight', sans-serif;
  font-weight: 600;
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  padding: 0.85rem 1rem;
  text-align: left;
  border-bottom: 1px solid var(--rule-strong);
}
.summary-table thead th.num { text-align: right; }
.summary-table tbody td {
  padding: 1rem;
  border-bottom: 1px solid var(--rule);
  font-size: 1rem;
}
.summary-table tbody tr:nth-child(odd) { background: var(--paper-2); }
.summary-table td.num { text-align: right; }
.row-case {
  font-family: 'DM Serif Display', Georgia, serif;
  font-style: italic;
  font-size: 1.1rem;
  color: var(--ink);
}

/* ================ Validation gates ================ */
.validation { padding: 4rem 0; border-bottom: 1px solid var(--rule); }
.gate-list {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
  border-top: 1px solid var(--rule);
}
.gate {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 1.5rem;
  align-items: baseline;
  padding: 1.1rem 0;
  border-bottom: 1px solid var(--rule);
}
@media (min-width: 800px) {
  .gate { grid-template-columns: 90px 1fr 2fr; }
}
.gate-status {
  font-family: 'Inter Tight', sans-serif;
  font-weight: 700;
  font-size: 0.72rem;
  letter-spacing: 0.22em;
}
.gate-pass .gate-status { color: var(--ink-teal); }
.gate-fail .gate-status { color: var(--ink-red); }
.gate-name {
  font-family: 'DM Serif Display', Georgia, serif;
  font-size: 1.1rem;
  color: var(--ink);
}
.gate-detail {
  font-family: 'Source Serif 4', serif;
  font-style: italic;
  color: var(--ink-mid);
  font-size: 0.95rem;
}

/* ================ Explainer ================ */
.explainer { padding: 4.5rem 0; border-bottom: 1px solid var(--rule); }
.two-column {
  margin-top: 1.8rem;
  column-count: 1;
  column-gap: 3rem;
  font-size: 1.06rem;
  line-height: 1.65;
  color: var(--ink);
}
.two-column p { break-inside: avoid; margin: 0 0 1.05rem 0; }
.two-column p:first-child::first-letter {
  font-family: 'DM Serif Display', Georgia, serif;
  font-size: 4.4rem;
  line-height: 0.82;
  float: left;
  margin: 0.2rem 0.55rem 0 -0.05rem;
  color: var(--ink-red);
}
@media (min-width: 900px) {
  .two-column { column-count: 2; }
}

/* ================ Glossary ================ */
.glossary { padding: 4rem 0; border-bottom: 1px solid var(--rule); }
.glossary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.4rem;
  margin-top: 1.6rem;
}
.glossary-entry {
  margin: 0;
  padding: 1.1rem 1.3rem;
  background: var(--paper-2);
  border-left: 3px solid var(--ink-mustard);
}
.glossary-entry dt {
  font-family: 'DM Serif Display', Georgia, serif;
  font-size: 1.12rem;
  margin-bottom: 0.35rem;
  color: var(--ink);
}
.glossary-entry dd {
  margin: 0;
  font-size: 0.94rem;
  line-height: 1.55;
  color: var(--ink-mid);
}

/* ================ Colophon ================ */
.colophon {
  padding: 3.5rem 0 5rem;
  background: var(--paper-2);
}
.colophon-rule {
  height: 1px; background: var(--rule); margin-bottom: 2.5rem;
}
.colophon-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 2.2rem;
}
@media (min-width: 800px) { .colophon-grid { grid-template-columns: 1.4fr 1fr; } }
.colophon h4 {
  font-family: 'DM Serif Display', Georgia, serif;
  font-style: italic;
  font-size: 1.4rem;
  margin: 0 0 0.7rem 0;
  color: var(--ink);
}
.colophon p {
  font-size: 0.95rem;
  line-height: 1.55;
  color: var(--ink-mid);
  margin: 0 0 0.8rem;
}
.colophon p code {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 0.86rem;
  color: var(--ink);
}
.meta-line { font-size: 0.82rem !important; color: var(--ink-faint) !important; }
.colophon ul { margin: 0; padding-left: 1.2rem; }
.colophon li {
  font-size: 0.9rem;
  color: var(--ink-mid);
  line-height: 1.5;
  margin-bottom: 0.35rem;
}
"""


# ---------------------------------------------------------------------------
# Plot JS — builds Plotly figures from the embedded JSON island.
# ---------------------------------------------------------------------------


_PLOT_JS = r"""<script>
(function(){
  var raw = document.getElementById('report-plot-data');
  if (!raw) return;
  var payload;
  try { payload = JSON.parse(raw.textContent); } catch (e) { return; }

  var COL = {
    paper: '#fcf6e7',
    ink: '#0e2235',
    inkSoft: '#2c3e50',
    inkMid: '#5b6b80',
    inkFaint: '#a59b80',
    red: '#c63b35',
    redDark: '#8a2620',
    mustard: '#c08e25',
    mustardSoft: '#d8b35a',
    teal: '#2e6f6e',
    placebo: 'rgba(70,80,95,0.16)'
  };

  var baseLayout = function(){
    return {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: {
        family: "'Source Serif 4', 'Source Serif Pro', Georgia, serif",
        color: COL.inkSoft,
        size: 13
      },
      margin: { l: 64, r: 24, t: 24, b: 56 },
      xaxis: {
        gridcolor: 'rgba(14,34,53,0.08)',
        zerolinecolor: 'rgba(14,34,53,0.15)',
        linecolor: 'rgba(14,34,53,0.25)',
        tickfont: { family: "'IBM Plex Mono', monospace", size: 11, color: COL.inkMid }
      },
      yaxis: {
        gridcolor: 'rgba(14,34,53,0.08)',
        zerolinecolor: 'rgba(14,34,53,0.15)',
        linecolor: 'rgba(14,34,53,0.25)',
        tickfont: { family: "'IBM Plex Mono', monospace", size: 11, color: COL.inkMid }
      },
      legend: {
        bgcolor: 'rgba(252,246,231,0.85)',
        bordercolor: 'rgba(14,34,53,0.18)',
        borderwidth: 1,
        font: { family: "'Inter Tight', sans-serif", size: 11, color: COL.ink }
      },
      hoverlabel: {
        bgcolor: '#fff9ea',
        bordercolor: COL.red,
        font: { family: "'IBM Plex Mono', monospace", color: COL.ink, size: 12 }
      },
      hovermode: 'closest'
    };
  };
  var config = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ['select2d','lasso2d','toggleSpikelines'] };

  function trajectoryPlot(c) {
    var t = c.trajectory; if (!t) return;
    var traces = [];
    // Placebo band: shaded min/max envelope across all donor placebos.
    if (t.placebo_band && t.placebo_band.years && t.placebo_band.lo && t.placebo_band.hi) {
      traces.push({
        x: t.placebo_band.years.concat(t.placebo_band.years.slice().reverse()),
        y: t.placebo_band.hi.concat(t.placebo_band.lo.slice().reverse()),
        type: 'scatter', mode: 'lines',
        fill: 'toself',
        fillcolor: 'rgba(70,80,95,0.10)',
        line: { color: 'rgba(70,80,95,0)', width: 0 },
        name: 'donor placebo envelope',
        hoverinfo: 'skip'
      });
    } else if (Array.isArray(t.placebos)) {
      // Legacy per-unit lines (kept for forward compatibility with future
      // exporters that hand us per-unit trajectories).
      t.placebos.forEach(function(p){
        traces.push({
          x: t.years, y: p.values,
          type: 'scatter', mode: 'lines',
          line: { color: COL.placebo, width: 1 },
          name: 'placebo: ' + p.unit,
          showlegend: false, hoverinfo: 'skip'
        });
      });
    }
    traces.push({
      x: t.years, y: t.synthetic,
      type: 'scatter', mode: 'lines',
      line: { color: COL.ink, width: 2.4, dash: 'dash' },
      name: 'Synthetic counterfactual',
      hovertemplate: '%{x}<br>synthetic: %{y:.2f}<extra></extra>'
    });
    traces.push({
      x: t.years, y: t.actual,
      type: 'scatter', mode: 'lines',
      line: { color: COL.red, width: 3.2 },
      name: 'Actual ' + (c.treated_unit || 'treated'),
      hovertemplate: '%{x}<br>actual: %{y:.2f}<extra></extra>'
    });

    var ty = c.treatment_year;
    var layout = baseLayout();
    layout.xaxis.title = { text: 'Year', font: { family: "'Source Serif 4', serif", size: 13 } };
    layout.yaxis.title = { text: c.outcome_label || 'outcome', font: { family: "'Source Serif 4', serif", size: 13 } };
    layout.shapes = [{
      type: 'line',
      xref: 'x', yref: 'paper',
      x0: ty, x1: ty, y0: 0, y1: 1,
      line: { color: COL.mustard, width: 2, dash: 'dot' }
    }];
    layout.annotations = [{
      x: ty, y: 1, yref: 'paper',
      text: 'Treatment year ' + ty,
      showarrow: false,
      yshift: 14,
      font: { color: COL.mustard, size: 11, family: "'Inter Tight', sans-serif" },
      xanchor: 'left'
    }];
    Plotly.newPlot('plot-traj-' + c.id, traces, layout, config);
  }

  function weightsPlot(c) {
    var w = c.weights; if (!w || !w.length) return;
    var sorted = w.slice().sort(function(a,b){ return b.weight - a.weight; }).slice(0, 12);
    var donors = sorted.map(function(d){ return d.donor; }).reverse();
    var weights = sorted.map(function(d){ return d.weight; }).reverse();
    var traces = [{
      x: weights, y: donors,
      type: 'bar', orientation: 'h',
      marker: { color: COL.teal, line: { color: COL.ink, width: 0.6 } },
      hovertemplate: '%{y}: %{x:.3f}<extra></extra>',
      text: weights.map(function(v){ return v.toFixed(3); }),
      textposition: 'outside',
      textfont: { family: "'IBM Plex Mono', monospace", size: 11, color: COL.inkSoft }
    }];
    var layout = baseLayout();
    layout.xaxis.title = { text: 'Synthetic-control weight', font: { family: "'Source Serif 4', serif", size: 13 } };
    layout.xaxis.range = [0, Math.max.apply(null, weights) * 1.18];
    layout.margin.l = 130;
    layout.title = { text: 'Donor-pool weights', font: { family: "'DM Serif Display', serif", size: 18, color: COL.ink }, x: 0, xanchor: 'left' };
    layout.margin.t = 50;
    Plotly.newPlot('plot-weights-' + c.id, traces, layout, config);
  }

  function placeboPlot(c) {
    var p = c.placebo_distribution; if (!p) return;
    var donor = (p.donor_ratios || []).filter(function(x){ return isFinite(x); });
    var treated = p.treated_ratio;
    var allVals = donor.slice();
    if (isFinite(treated)) allVals.push(treated);
    if (!allVals.length) return;

    var minV = Math.min.apply(null, allVals);
    var maxV = Math.max.apply(null, allVals);
    var nb = 14;
    var step = (maxV - minV) / nb || 1;
    var bins = []; var counts = []; var centers = [];
    for (var i=0; i<nb; i++) {
      bins.push(minV + i*step);
      counts.push(0);
      centers.push(minV + (i + 0.5)*step);
    }
    donor.forEach(function(v){
      var idx = Math.min(nb-1, Math.max(0, Math.floor((v - minV) / step)));
      counts[idx] += 1;
    });
    var ymax = Math.max.apply(null, counts) + 1;

    var traces = [{
      x: centers, y: counts,
      type: 'bar',
      marker: { color: 'rgba(70,80,95,0.4)', line: { color: COL.inkSoft, width: 0.6 } },
      name: 'donor placebos',
      hovertemplate: 'ratio bin: %{x:.2f}<br>count: %{y}<extra></extra>'
    }];
    var layout = baseLayout();
    layout.xaxis.title = { text: 'Post / Pre RMSPE ratio (larger ⇒ stronger signal)', font: { family: "'Source Serif 4', serif", size: 13 } };
    layout.yaxis.title = { text: 'Count of donors', font: { family: "'Source Serif 4', serif", size: 13 } };
    layout.yaxis.range = [0, ymax];
    layout.shapes = [{
      type: 'line', xref: 'x', yref: 'y',
      x0: treated, x1: treated, y0: 0, y1: ymax,
      line: { color: COL.red, width: 3 }
    }];
    layout.annotations = [{
      x: treated, y: ymax * 0.92,
      text: '<b>' + (c.treated_unit || 'treated') + '</b><br>ratio ' + Number(treated).toFixed(2),
      showarrow: true, arrowhead: 2, ax: 30, ay: -10,
      font: { color: COL.red, size: 11, family: "'Inter Tight', sans-serif" },
      bgcolor: 'rgba(255,249,234,0.85)',
      bordercolor: COL.red, borderwidth: 1, borderpad: 4
    }];
    layout.title = { text: 'Placebo distribution', font: { family: "'DM Serif Display', serif", size: 18, color: COL.ink }, x: 0, xanchor: 'left' };
    layout.margin.t = 50;
    Plotly.newPlot('plot-placebo-' + c.id, traces, layout, config);
  }

  function methodsPlot(c) {
    var m = c.methods; if (!m || !m.length) return;
    // Forest plot — methods on y, ATT estimates on x.
    var labels = m.map(function(r){ return r.label; }).reverse();
    var ests = m.map(function(r){ return r.estimate; }).reverse();
    var lo = m.map(function(r){ return (r.ci_lo == null) ? null : r.ci_lo; }).reverse();
    var hi = m.map(function(r){ return (r.ci_hi == null) ? null : r.ci_hi; }).reverse();
    var arr_minus = ests.map(function(e, i){ return (lo[i] == null) ? 0 : (e - lo[i]); });
    var arr_plus  = ests.map(function(e, i){ return (hi[i] == null) ? 0 : (hi[i] - e); });

    var traces = [{
      x: ests, y: labels,
      type: 'scatter', mode: 'markers',
      marker: { color: COL.ink, size: 14, symbol: 'square' },
      error_x: { type: 'data', symmetric: false,
                 array: arr_plus, arrayminus: arr_minus,
                 color: COL.inkMid, thickness: 2.4, width: 6 },
      hovertemplate: '%{y}<br>ATT %{x:.2f}<extra></extra>',
      showlegend: false
    }];
    var layout = baseLayout();
    layout.xaxis.title = { text: 'ATT estimate', font: { family: "'Source Serif 4', serif", size: 13 } };
    layout.xaxis.zeroline = true; layout.xaxis.zerolinewidth = 2; layout.xaxis.zerolinecolor = COL.red;
    layout.margin.l = 200;
    layout.title = { text: 'Method comparison', font: { family: "'DM Serif Display', serif", size: 18, color: COL.ink }, x: 0, xanchor: 'left' };
    layout.margin.t = 50;
    Plotly.newPlot('plot-methods-' + c.id, traces, layout, config);
  }

  (payload.cases || []).forEach(function(c){
    try { trajectoryPlot(c); } catch (e) { console.warn('traj', c.id, e); }
    try { weightsPlot(c);   } catch (e) { console.warn('wt',   c.id, e); }
    try { placeboPlot(c);   } catch (e) { console.warn('pl',   c.id, e); }
    try { methodsPlot(c);   } catch (e) { console.warn('mt',   c.id, e); }
  });
})();
</script>"""


# ---------------------------------------------------------------------------
# Page template
# ---------------------------------------------------------------------------


_PAGE_TEMPLATE = """<!doctype html>
<html lang="en">
{head}
<body>
{masthead}
{hero}
{cases}
{summary}
{validation}
{explainer}
{glossary}
{footer}
{plot_data}
{plot_js}
</body>
</html>
"""
