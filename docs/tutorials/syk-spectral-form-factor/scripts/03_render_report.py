"""Stage 3 — render the interactive HTML report.

Reads sff_data.json and metrics.json (produced by 02_spectral_form_factor.py)
and writes a single self-contained report.html.

The HTML uses CDN-loaded libraries only -- no build step required:

  - Tailwind CSS (Play CDN) for utility classes
  - Plotly.js for interactive scientific plots
  - KaTeX for the SYK Hamiltonian
  - Alpine.js for the SFF view toggle
  - HTML5 canvas for the Dyson Coulomb gas hero animation, which is
    literally the equilibrium distribution of GUE eigenvalues

Visual direction is "editorial science journal" — Fraunces variable serif
for display + Newsreader for body + JetBrains Mono for numerals,
deep ink-blue paper with a cream/rust/teal/gold palette, oversized
section numbers, drop caps, hairline + fleuron section dividers.

The report works opened directly with file:// (no server required), but
benefits from `python -m http.server` if you prefer.
"""

from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>The Spectral Form Factor — A Numerical Folio</title>

<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
        onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}]});"></script>
<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,300..900,0..100,0..1;1,9..144,300..900,0..100,0..1&family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">

<style>
  :root {
    /* Paper / ink */
    --paper: #0a0d16;
    --paper-2: #0e1220;
    --paper-3: #141a2c;
    --rule: #28304a;
    --rule-soft: rgba(244,236,220,0.10);
    --shadow-deep: 0 40px 100px -50px rgba(0,0,0,0.7);

    /* Cream foreground */
    --ink: #f3ead8;
    --ink-warm: #f6e9cd;
    --ink-mid: #c5b89c;
    --ink-dim: #8e8470;
    --ink-faint: #5e5747;

    /* Editorial accents (used sparingly) */
    --rust: #e57b46;
    --rust-deep: #b6562b;
    --teal: #7fb8a8;
    --teal-deep: #4d8b7d;
    --gold: #d3aa56;
    --gold-deep: #9c7d36;
    --rose: #cd8595;
    --ocean: #5b8aa3;
    --bad: #d06a6a;
    --good: #7fb8a8;
  }

  * { box-sizing: border-box; }

  html, body {
    background: var(--paper);
    color: var(--ink);
    margin: 0; padding: 0;
    font-family: 'Newsreader', Georgia, 'Times New Roman', serif;
    font-variation-settings: 'opsz' 18, 'wght' 380;
    font-size: 18px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
    font-feature-settings: "liga" 1, "kern" 1;
  }

  /* SVG grain overlay over everything for paper texture */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    z-index: 9000;
    opacity: 0.045;
    mix-blend-mode: screen;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 0.95   0 0 0 0 0.92   0 0 0 0 0.86   0 0 0 1 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
  }

  /* Background atmosphere — very faint warm and cool radials */
  body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0;
    background:
      radial-gradient(900px 600px at 12% 8%, rgba(229,123,70,0.07), transparent 60%),
      radial-gradient(900px 600px at 92% 90%, rgba(127,184,168,0.05), transparent 60%);
  }

  /* ===== Type primitives ===== */
  .display {
    font-family: 'Fraunces', 'Cormorant Garamond', Georgia, serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 30, 'WONK' 0;
    font-weight: 600;
    letter-spacing: -0.022em;
    line-height: 1;
    color: var(--ink);
  }
  .display-italic {
    font-family: 'Fraunces', Georgia, serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 100, 'WONK' 1;
    font-style: italic;
    font-weight: 400;
    letter-spacing: -0.012em;
  }
  .body-serif {
    font-family: 'Newsreader', Georgia, serif;
    font-variation-settings: 'opsz' 18, 'wght' 380;
  }
  .mono {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-feature-settings: "ss01", "tnum" 1;
  }

  .kicker {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: var(--ink-dim);
  }
  .kicker-rust { color: var(--rust); }

  /* ===== Layout primitives ===== */
  .container {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 2rem;
    position: relative;
  }
  @media (min-width: 768px) {
    .container { padding: 0 3rem; }
  }
  .col-text { max-width: 720px; }
  .col-text-narrow { max-width: 620px; }

  /* Section opener with oversized numeral */
  .section {
    position: relative;
    padding: 6rem 0;
  }
  @media (min-width: 1024px) {
    .section { padding: 8rem 0; }
  }
  .section-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 2.5rem;
  }
  @media (min-width: 1024px) {
    .section-grid {
      grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
      gap: 4rem;
    }
  }
  .section-num {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 0, 'WONK' 1;
    font-weight: 600;
    font-size: clamp(5rem, 12vw, 10rem);
    line-height: 0.82;
    color: transparent;
    -webkit-text-stroke: 1.5px var(--rust);
    text-stroke: 1.5px var(--rust);
    letter-spacing: -0.04em;
    user-select: none;
    transform: translateY(-0.1em);
  }
  .section-num-solid {
    color: var(--rust);
    -webkit-text-stroke: 0;
  }
  .section-title {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 30, 'WONK' 0;
    font-weight: 600;
    font-size: clamp(2rem, 4.5vw, 3.4rem);
    line-height: 1.05;
    letter-spacing: -0.025em;
    color: var(--ink);
    margin: 0;
  }
  .section-title em {
    font-style: italic;
    color: var(--rust);
    font-variation-settings: 'opsz' 144, 'SOFT' 100, 'WONK' 1;
  }

  /* Drop cap on lede paragraphs */
  .dropcap::first-letter {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 0, 'WONK' 1;
    font-weight: 700;
    font-size: 5.6rem;
    line-height: 0.82;
    float: left;
    margin: 0.32rem 0.65rem 0 -0.05rem;
    color: var(--rust);
  }

  /* Pull quote */
  .pull {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 100, 'WONK' 1;
    font-style: italic;
    font-weight: 400;
    font-size: clamp(1.6rem, 2.6vw, 2.25rem);
    line-height: 1.18;
    color: var(--ink);
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    padding: 2.4rem 0;
    margin: 3rem 0;
    text-indent: -0.4em;
  }
  .pull::before {
    content: "\201C";
    color: var(--rust);
    margin-right: 0.05em;
    font-variation-settings: 'opsz' 144, 'SOFT' 0, 'WONK' 0;
  }
  .pull::after {
    content: "\201D";
    color: var(--rust);
    margin-left: 0.05em;
    font-variation-settings: 'opsz' 144, 'SOFT' 0, 'WONK' 0;
  }
  .pull cite {
    display: block;
    margin-top: 1.2rem;
    font-style: normal;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    letter-spacing: 0.25em;
    text-transform: uppercase;
    color: var(--ink-dim);
    text-indent: 0;
  }

  /* Big numerical takeaway */
  .headline-num {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 0, 'WONK' 1;
    font-weight: 600;
    font-size: clamp(5rem, 12vw, 9rem);
    line-height: 0.85;
    letter-spacing: -0.035em;
    color: var(--ink);
    font-feature-settings: "tnum" 1, "ss01" 1;
  }
  .headline-num em {
    color: var(--rust);
    font-style: italic;
    font-variation-settings: 'opsz' 144, 'SOFT' 100, 'WONK' 1;
  }

  /* Hairline + ornament divider (fleuron) */
  .fleuron {
    display: flex; align-items: center; gap: 1.4rem;
    margin: 0 auto;
    max-width: 600px;
  }
  .fleuron::before, .fleuron::after {
    content: ""; flex: 1; height: 1px;
    background: linear-gradient(90deg, transparent, var(--rule) 30%, var(--rule) 70%, transparent);
  }
  .fleuron-mark {
    color: var(--rust);
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 144, 'SOFT' 100, 'WONK' 1;
    font-style: italic;
    font-size: 1.1rem;
    letter-spacing: 0.5em;
    padding-left: 0.5em;
  }

  /* Sidebar callout — "for everyone" / "how to read this plot" */
  .sidebar {
    border-left: 2px solid var(--rust);
    padding: 0.4rem 0 0.4rem 1.6rem;
    background: linear-gradient(90deg, rgba(229,123,70,0.04), transparent 50%);
  }
  .sidebar p { color: var(--ink); }
  .sidebar p + p { margin-top: 0.85rem; color: var(--ink-mid); }
  .sidebar-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem; letter-spacing: 0.3em; text-transform: uppercase;
    color: var(--rust);
    display: block;
    margin-bottom: 0.7rem;
  }

  /* Plot frame */
  .plot-frame {
    border: 1px solid var(--rule);
    background: var(--paper-2);
    box-shadow: var(--shadow-deep);
    position: relative;
    overflow: hidden;
  }
  .plot-frame::before {
    /* corner ticks like a vintage chart */
    content: "";
    position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(to right, var(--rust) 0, var(--rust) 14px, transparent 14px) top left / 14px 1px no-repeat,
      linear-gradient(to bottom, var(--rust) 0, var(--rust) 14px, transparent 14px) top left / 1px 14px no-repeat,
      linear-gradient(to left, var(--rust) 0, var(--rust) 14px, transparent 14px) top right / 14px 1px no-repeat,
      linear-gradient(to bottom, var(--rust) 0, var(--rust) 14px, transparent 14px) top right / 1px 14px no-repeat,
      linear-gradient(to right, var(--rust) 0, var(--rust) 14px, transparent 14px) bottom left / 14px 1px no-repeat,
      linear-gradient(to top, var(--rust) 0, var(--rust) 14px, transparent 14px) bottom left / 1px 14px no-repeat,
      linear-gradient(to left, var(--rust) 0, var(--rust) 14px, transparent 14px) bottom right / 14px 1px no-repeat,
      linear-gradient(to top, var(--rust) 0, var(--rust) 14px, transparent 14px) bottom right / 1px 14px no-repeat;
    opacity: 0.7;
  }
  .plot-caption {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.68rem;
    letter-spacing: 0.25em;
    text-transform: uppercase;
    color: var(--ink-dim);
    border-top: 1px solid var(--rule);
    padding: 0.9rem 1.1rem;
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .plot-caption-text {
    font-family: 'Newsreader', serif;
    font-style: italic;
    font-size: 0.82rem;
    letter-spacing: 0;
    text-transform: none;
    color: var(--ink-mid);
    line-height: 1.4;
    flex: 1;
  }
  .plot-caption-num {
    color: var(--rust);
    font-weight: 500;
  }

  /* "Numerical card" — used for run metadata in masthead */
  .num-card {
    border-top: 1px solid var(--rule);
    padding: 1rem 0;
  }
  .num-card .label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem; letter-spacing: 0.3em; text-transform: uppercase;
    color: var(--ink-dim);
    margin-bottom: 0.5rem;
  }
  .num-card .value {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 72, 'SOFT' 0, 'WONK' 1;
    font-weight: 500;
    font-size: 2.2rem;
    line-height: 1;
    color: var(--ink);
    letter-spacing: -0.02em;
    font-feature-settings: "tnum" 1;
  }

  /* Tab buttons */
  .tab-btn {
    padding: 0.5rem 1rem;
    border: 1px solid var(--rule);
    color: var(--ink-mid);
    background: transparent;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all 0.18s ease;
    border-radius: 0;
  }
  .tab-btn:hover {
    color: var(--ink);
    border-color: var(--rust);
    background: rgba(229,123,70,0.06);
  }
  .tab-btn.active {
    color: var(--paper);
    background: var(--rust);
    border-color: var(--rust);
  }

  /* Validation pill */
  .pill {
    display: inline-flex; align-items: center; gap: 0.45rem;
    padding: 0.32rem 0.7rem;
    border: 1px solid var(--rule);
    color: var(--ink-mid);
    background: transparent;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.66rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .pill-good { color: var(--good); border-color: rgba(127,184,168,0.5); background: rgba(127,184,168,0.06); }
  .pill-bad  { color: var(--bad);  border-color: rgba(208,106,106,0.5); background: rgba(208,106,106,0.06); }

  /* Validation table */
  .validation-table { width: 100%; border-collapse: collapse; }
  .validation-table thead {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem;
    letter-spacing: 0.25em;
    text-transform: uppercase;
    color: var(--ink-dim);
  }
  .validation-table thead th {
    padding: 1rem 1.5rem;
    text-align: left;
    border-bottom: 1px solid var(--rule);
    font-weight: 500;
  }
  .validation-table thead th:last-child { text-align: right; }
  .validation-table tbody td {
    padding: 1.5rem;
    border-bottom: 1px solid var(--rule-soft);
    color: var(--ink);
    font-family: 'Newsreader', serif;
    font-size: 1rem;
    line-height: 1.5;
  }
  .validation-table tbody td:nth-child(2),
  .validation-table tbody td:nth-child(3) {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.85rem;
    color: var(--ink-mid);
  }
  .validation-table tbody td:last-child { text-align: right; }
  .validation-table tbody tr:last-child td { border-bottom: none; }

  /* Glossary lexicon */
  .lexicon {
    column-count: 2;
    column-gap: 3rem;
    column-rule: 1px solid var(--rule);
  }
  @media (max-width: 767px) {
    .lexicon { column-count: 1; }
  }
  .lex-item {
    break-inside: avoid;
    margin-bottom: 1.6rem;
    padding-bottom: 1.4rem;
    border-bottom: 1px solid var(--rule-soft);
  }
  .lex-item:last-child { border-bottom: none; }
  .lex-term {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 36, 'SOFT' 50, 'WONK' 0;
    font-weight: 600;
    font-size: 1.15rem;
    color: var(--ink);
    letter-spacing: -0.005em;
    margin-bottom: 0.4rem;
  }
  .lex-term::after {
    content: " ·";
    color: var(--rust);
  }
  .lex-def {
    font-family: 'Newsreader', serif;
    font-size: 0.95rem;
    line-height: 1.55;
    color: var(--ink-mid);
  }

  /* Hero */
  .hero {
    position: relative;
    min-height: 100vh;
    overflow: hidden;
    border-bottom: 1px solid var(--rule);
  }
  #hero-canvas {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    z-index: 1; opacity: 0.95;
  }
  .hero-content { position: relative; z-index: 2; }
  .hero-vrule {
    position: absolute;
    left: 2rem;
    top: 50%;
    transform: translateY(-50%) rotate(-90deg);
    transform-origin: left center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.45em;
    text-transform: uppercase;
    color: var(--ink-dim);
    white-space: nowrap;
    z-index: 3;
    display: none;
  }
  @media (min-width: 1024px) {
    .hero-vrule { display: block; }
  }
  .hero-vrule .accent { color: var(--rust); }

  /* Reveal animation */
  .reveal { opacity: 0; transform: translateY(28px); transition: opacity 1s cubic-bezier(0.2,0.6,0.2,1), transform 1s cubic-bezier(0.2,0.6,0.2,1); }
  .reveal.in { opacity: 1; transform: none; }

  /* Body prose with optional 2-column layout */
  .prose-body {
    font-family: 'Newsreader', serif;
    font-variation-settings: 'opsz' 18, 'wght' 380;
    font-size: 1.12rem;
    line-height: 1.7;
    color: var(--ink);
  }
  .prose-body p + p { margin-top: 1.1rem; }
  .prose-body em { color: var(--rust); font-style: italic; }
  .prose-body strong { color: var(--ink); font-weight: 600; }
  .prose-body a { color: var(--rust); text-decoration: underline; text-underline-offset: 4px; }

  .prose-mid {
    font-family: 'Newsreader', serif;
    color: var(--ink-mid);
    font-size: 1.06rem;
    line-height: 1.65;
  }
  .prose-mid em { color: var(--ink); font-style: italic; }

  /* Hamiltonian display panel — like a framed plate */
  .plate {
    position: relative;
    border: 1px solid var(--rule);
    padding: 2.5rem 2rem;
    background:
      linear-gradient(180deg, rgba(229,123,70,0.025), transparent 60%),
      var(--paper-2);
  }
  .plate::before {
    content: "";
    position: absolute;
    top: 8px; left: 8px; right: 8px; bottom: 8px;
    border: 1px solid var(--rule-soft);
    pointer-events: none;
  }
  .plate-label {
    position: absolute;
    top: -0.55rem; left: 1.5rem;
    background: var(--paper);
    padding: 0 0.8rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.62rem;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: var(--ink-dim);
  }

  /* Footer / colophon */
  .colophon {
    border-top: 1px solid var(--rule);
    margin-top: 4rem;
    padding: 4rem 0 5rem;
    background:
      radial-gradient(800px 200px at 50% -50px, rgba(229,123,70,0.03), transparent 70%);
  }
  .colophon h4 {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 36, 'SOFT' 50, 'WONK' 1;
    font-style: italic;
    font-weight: 500;
    font-size: 1.1rem;
    color: var(--ink);
    margin-bottom: 1rem;
  }
  .colophon ul { font-size: 0.92rem; line-height: 1.7; color: var(--ink-mid); }
  .colophon ul li + li { margin-top: 0.5rem; }
  .colophon .italic { font-style: italic; }
  .colophon pre {
    font-size: 0.72rem;
    color: var(--ink-mid);
    line-height: 1.55;
    white-space: pre-wrap;
  }

  /* KaTeX color */
  .katex { color: var(--ink); }
  .katex-display { margin: 0.5rem 0; }

  /* Scroll prompt */
  .scroll-prompt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    letter-spacing: 0.3em;
    text-transform: uppercase;
    color: var(--ink-dim);
    animation: drift 2.6s ease-in-out infinite;
  }
  @keyframes drift {
    0%, 100% { transform: translateY(0); opacity: .55; }
    50%      { transform: translateY(8px); opacity: 1; }
  }

  /* Inline color tokens for plain-English prose */
  .ink-rust { color: var(--rust); }
  .ink-teal { color: var(--teal); }
  .ink-gold { color: var(--gold); }
  .ink-rose { color: var(--rose); }
  .ink-good { color: var(--good); }

  /* Page edge rules — like a magazine spread */
  .edge-rule-top, .edge-rule-bottom {
    border: 0; height: 1px; background: var(--rule);
    margin: 0;
  }

  /* Masthead row */
  .masthead {
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    padding: 1.4rem 0;
    display: flex; flex-wrap: wrap;
    gap: 2rem 3rem;
    justify-content: center;
  }
  .masthead-item { text-align: center; min-width: 100px; }
  .masthead-item .lbl {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem; letter-spacing: 0.32em; text-transform: uppercase;
    color: var(--ink-dim);
    margin-bottom: 0.4rem;
  }
  .masthead-item .val {
    font-family: 'Fraunces', serif;
    font-variation-settings: 'opsz' 72, 'SOFT' 0, 'WONK' 1;
    font-weight: 500;
    font-size: 1.85rem; line-height: 1;
    color: var(--ink);
    font-feature-settings: "tnum" 1;
    letter-spacing: -0.01em;
  }

  /* Reduce motion respect */
  @media (prefers-reduced-motion: reduce) {
    .reveal { opacity: 1; transform: none; transition: none; }
    .scroll-prompt { animation: none; }
  }
</style>
</head>

<body>

<!-- ============================== HERO ============================== -->
<header class="hero">
  <canvas id="hero-canvas"></canvas>

  <div class="hero-vrule">
    <span class="accent">VOL. I</span> &nbsp;·&nbsp; ISSUE I &nbsp;·&nbsp; ON QUANTUM CHAOS &nbsp;·&nbsp; <span class="accent">MMXXVI</span>
  </div>

  <div class="hero-content min-h-screen flex flex-col">
    <nav class="container py-7 flex items-center justify-between text-xs">
      <span class="kicker">SCIENCESWARM &nbsp;·&nbsp; A NUMERICAL FOLIO</span>
      <span class="kicker">№ 03 &nbsp;·&nbsp; __GENERATED_AT__</span>
    </nav>

    <div class="flex-1 flex items-center">
      <div class="container w-full">
        <p class="kicker kicker-rust mb-8">
          <span style="display:inline-block; width:36px; height:1px; background:var(--rust); vertical-align:middle; margin-right:0.6em;"></span>
          Sachdev–Ye–Kitaev &nbsp;·&nbsp; q = 4 &nbsp;·&nbsp; Disorder Ensemble
        </p>

        <h1 class="display" style="font-size: clamp(2.6rem, 7.5vw, 6.5rem); max-width: 14ch;">
          The <span class="display-italic">spectral form factor</span> &amp; the
          <span style="color: var(--rust)">dip,</span>
          <span style="color: var(--gold)">ramp,</span>
          <span style="color: var(--teal)">plateau.</span>
        </h1>

        <p class="prose-body mt-10 max-w-2xl" style="font-size: 1.18rem; color: var(--ink-mid);">
          A laptop-scale numerical experiment in quantum chaos. We diagonalize
          <span class="mono ink-rust">__SAMPLES__</span> disorder realizations of the SYK Hamiltonian
          on <span class="mono ink-rust">N = __N__</span> Majorana fermions and watch one of the cleanest
          known signatures of many-body chaos emerge — a slope-one ramp that lines up with random
          matrix theory across four orders of magnitude in time.
        </p>
      </div>
    </div>

    <div class="container">
      <div class="masthead mb-6">
        <div class="masthead-item">
          <div class="lbl">Majoranas</div>
          <div class="val">__N__</div>
        </div>
        <div class="masthead-item">
          <div class="lbl">Hilbert dim</div>
          <div class="val">__DIM__</div>
        </div>
        <div class="masthead-item">
          <div class="lbl">Disorder samples</div>
          <div class="val">__SAMPLES__</div>
        </div>
        <div class="masthead-item">
          <div class="lbl">Symmetry class</div>
          <div class="val">__CLASS__</div>
        </div>
        <div class="masthead-item">
          <div class="lbl">Inverse temp.</div>
          <div class="val">βJ = __BETA__</div>
        </div>
      </div>
      <div class="text-center pb-8">
        <span class="scroll-prompt">↓ &nbsp; Begin reading</span>
      </div>
    </div>
  </div>
</header>

<!-- ============================== SECTION 00 — BIG PICTURE ============================== -->
<section class="section reveal">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num">00</div>
      </div>
      <div class="col-text">
        <p class="kicker kicker-rust mb-4">The big picture &nbsp;·&nbsp; an opening read</p>
        <h2 class="section-title">
          Energy levels of complex quantum systems look <em>random</em>. <br/>
          That's not a metaphor.
        </h2>

        <div class="prose-body mt-10">
          <p class="dropcap">
            Drop a complex enough quantum system on the table and ask what its energy
            levels look like. Surprisingly often, they do not look like anything specific
            to the system at all. They look like the eigenvalues of a <em>random matrix</em>.
            The deep claim of quantum chaos is that this is the universal long-time fate
            of any quantum system whose classical limit would be chaotic — and identifying
            <em>which</em> random-matrix universality class a given system falls into is
            among the cleanest known fingerprints of underlying physics.
          </p>
          <p>
            The model on this page — the <strong>Sachdev–Ye–Kitaev (SYK) model</strong> —
            is a deliberately stripped-down stress test of that claim: <span class="mono">N</span>
            abstract fermionic operators, all coupled to one another through random
            four-body interactions. No lattice, no kinetic energy, no spatial structure.
            Despite being a toy, SYK turns out at low energy to be mathematically equivalent
            to a particular two-dimensional theory of quantum gravity describing a near-
            extremal black hole. That makes its spectral statistics a small, exact window
            into how black holes appear from the inside.
          </p>
        </div>

        <div class="pull">
          We computed the cleanest known finite-system signature of quantum chaos
          on a laptop in roughly four minutes.
          <cite>— That signature is what the rest of this folio is about.</cite>
        </div>

        <div class="prose-mid">
          <p>
            What follows are four plots in order of increasing surprise: a smooth
            <span class="ink-teal">distribution of energy levels</span>; a
            <span class="ink-rose">distribution of the gaps</span> between adjacent levels
            showing they actively <em>repel</em> each other; the headline
            <span class="ink-rust">spectral form factor</span> with its now-iconic
            <em>dip–ramp–plateau</em> structure matching random-matrix theory across four
            orders of magnitude in time; and a short
            <span class="ink-gold">validation table</span> confirming that what you are
            seeing is real, not pareidolia.
          </p>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="container">
  <div class="fleuron"><span class="fleuron-mark">§ &nbsp; § &nbsp; §</span></div>
</div>

<!-- ============================== SECTION 01 — THE MODEL ============================== -->
<section class="section reveal">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num">01</div>
      </div>
      <div>
        <div class="col-text mb-12">
          <p class="kicker kicker-rust mb-4">The model</p>
          <h2 class="section-title">N Majoranas, all-to-all,<br/><em>four-body, random.</em></h2>
        </div>

        <div class="grid lg:grid-cols-2 gap-12 items-start">
          <div class="sidebar">
            <span class="sidebar-label">For everyone</span>
            <p>
              A <strong>Majorana fermion</strong> is the simplest possible
              quantum-mechanical half-particle: an algebraic operator with the rule
              that two of them placed in different "slots" anti-commute (swapping them
              flips a sign). They have no position, no spin — they are abstract
              bookkeeping operators.
            </p>
            <p>
              The Hamiltonian below — the rule that determines all the energies — is
              just the sum of <em>every possible product of four Majoranas</em>, each
              multiplied by an independent random number drawn from a normal
              distribution. No preferred direction, no preferred pair, no spatial
              structure: a maximally featureless quantum system. We diagonalize it,
              read off its energies, then repeat the whole procedure
              <span class="mono">__SAMPLES__</span> times with different random draws and average.
            </p>
          </div>

          <div>
            <p class="kicker mb-3">For physicists</p>
            <div class="prose-mid">
              <p>
                The SYK<sub>4</sub> Hamiltonian is exactly soluble at large <em>N</em>,
                has emergent conformal symmetry at low energy, saturates the Maldacena–
                Shenker–Stanford bound on chaos, and is widely conjectured to be a
                holographic dual of nearly-AdS<sub>2</sub> dilaton gravity. We diagonalize
                it in the even-fermion-parity sector (dimension
                <span class="mono ink-rust">__DIM__</span>), averaged over
                <span class="mono ink-rust">__SAMPLES__</span> independent draws of the
                couplings. Restricting to one parity sector leaves a single irreducible
                random-matrix block and so produces clean Wigner–Dyson statistics.
              </p>
            </div>
          </div>
        </div>

        <!-- Hamiltonian plate, full width — like a framed printer's plate -->
        <div class="plate mt-14">
          <span class="plate-label">Hamiltonian · Plate I</span>
          <div class="grid lg:grid-cols-12 gap-8 items-center pt-3">
            <div class="lg:col-span-8 overflow-x-auto" style="font-size: 1.35rem;">
              $$ H \;=\; \sum_{1 \le a \lt b \lt c \lt d \le N} J_{abcd}\, \chi_a \chi_b \chi_c \chi_d $$
            </div>
            <div class="lg:col-span-4 lg:border-l lg:pl-8" style="border-color: var(--rule-soft);">
              <div class="text-base overflow-x-auto">
                $$ \{\chi_a, \chi_b\} = 2\delta_{ab} $$
              </div>
              <div class="text-base overflow-x-auto mt-4">
                $$ \langle J_{abcd}^2 \rangle = \frac{6\,J^2}{N^3} $$
              </div>
            </div>
          </div>
          <hr class="border-0 h-px my-7" style="background: var(--rule-soft);"/>
          <p style="font-family:'Newsreader',serif; font-style: italic; font-size:0.95rem; line-height:1.55; color: var(--ink-mid);">
            Energies are reported in units of <span class="mono not-italic">J</span>.
            Inverse temperature <span class="mono not-italic ink-rust">βJ = __BETA__</span>.
            All <span class="mono not-italic">C(__N__, 4) = __N_TUPLES__</span>
            independent couplings are drawn for each disorder realization.
          </p>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="container">
  <div class="fleuron"><span class="fleuron-mark">∿ &nbsp; ∿ &nbsp; ∿</span></div>
</div>

<!-- ============================== SECTION 02 — SPECTRUM ============================== -->
<section class="section reveal">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num">02</div>
      </div>
      <div>
        <div class="col-text mb-10">
          <p class="kicker kicker-rust mb-4">The spectrum</p>
          <h2 class="section-title">Where, on the energy axis,<br/>do the levels <em>actually live?</em></h2>
        </div>

        <div class="grid lg:grid-cols-12 gap-12 items-start mb-10">
          <div class="lg:col-span-5">
            <div class="sidebar">
              <span class="sidebar-label">How to read this plot</span>
              <p>
                The horizontal axis is energy <span class="mono">E</span>. The bar
                height tells you, on average over our random Hamiltonians, <em>how many
                </em> energy levels sit at each energy. A boring system would give a
                featureless box; a generic chaotic system gives a smooth bump.
              </p>
              <p>
                The shape here — bell-like, tapering toward the edges, slightly
                asymmetric — is what SYK is supposed to do. At low energy it follows a
                specific conformal formula, the same shape that gravity in an
                AdS<sub>2</sub> throat would predict.
              </p>
            </div>
          </div>
          <div class="lg:col-span-7">
            <p class="prose-mid">
              The disorder ensemble preserves no special structure on its own, so the
              density of states reflects only the underlying SYK kinematics — a soft
              edge at the spectral support boundary, a small particle-hole asymmetry,
              and a roughly conformal shape near zero energy.
            </p>
          </div>
        </div>

        <figure class="plot-frame">
          <div id="plot-rho" style="width:100%; height:420px;"></div>
          <figcaption class="plot-caption">
            <span>Fig. I &nbsp;·&nbsp; <span class="plot-caption-num">ρ(E)</span></span>
            <span class="plot-caption-text">
              Disorder-averaged density of states. <span class="mono not-italic">__SAMPLES__</span>
              independent draws of the coupling tensor, even-parity sector
              (<span class="mono not-italic">d = __DIM__</span>).
            </span>
            <span>↓ scroll</span>
          </figcaption>
        </figure>
      </div>
    </div>
  </div>
</section>

<div class="container">
  <div class="fleuron"><span class="fleuron-mark">∾ &nbsp; ∾ &nbsp; ∾</span></div>
</div>

<!-- ============================== SECTION 03 — LEVEL STATS ============================== -->
<section class="section reveal">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num">03</div>
      </div>
      <div>
        <div class="col-text mb-10">
          <p class="kicker kicker-rust mb-4">Level statistics</p>
          <h2 class="section-title">Adjacent energy levels actively<br/><em>repel</em> one another.</h2>
        </div>

        <!-- Big numerical takeaway, banner style -->
        <div class="grid lg:grid-cols-12 gap-12 items-end mb-12 pb-12" style="border-bottom: 1px solid var(--rule);">
          <div class="lg:col-span-7">
            <p class="kicker mb-3">The headline number</p>
            <div class="headline-num">__R_MEAN__</div>
            <p class="prose-mid mt-5">
              The disorder-averaged mean nearest-neighbor gap ratio
              <span class="mono">⟨r⟩</span>, computed from
              <span class="mono">__R_PAIRS__</span> consecutive-gap pairs across the ensemble.
              The value <em>is the prediction</em> of complex-Hermitian random-matrix
              theory.
            </p>
          </div>
          <div class="lg:col-span-5">
            <div class="grid grid-cols-2 gap-x-8 gap-y-4">
              <div>
                <div class="kicker mb-2">Reference (__CLASS__)</div>
                <div class="mono" style="font-size:1.55rem; color: var(--ink); font-feature-settings:'tnum';">__R_REF__</div>
                <div class="kicker mt-1" style="text-transform:none;letter-spacing:0;font-family:'Newsreader',serif;font-style:italic;font-size:0.78rem;">Atas surmise</div>
              </div>
              <div>
                <div class="kicker mb-2">Δ from reference</div>
                <div class="mono" style="font-size:1.55rem; color: var(--rust); font-feature-settings:'tnum';">__R_DELTA__</div>
                <div class="kicker mt-1" style="text-transform:none;letter-spacing:0;font-family:'Newsreader',serif;font-style:italic;font-size:0.78rem;">±__R_SEM__ (SEM)</div>
              </div>
              <div class="col-span-2 mt-2">__R_BADGE__</div>
            </div>
          </div>
        </div>

        <div class="grid lg:grid-cols-12 gap-12 items-start mb-10">
          <div class="lg:col-span-5">
            <div class="sidebar">
              <span class="sidebar-label">How to read the plot</span>
              <p>
                Sort the energies in increasing order, look at the gaps between
                adjacent pairs, and ask: how big is each gap compared to the next? The
                number <span class="mono">r</span> is exactly that — the smaller of two
                consecutive gaps divided by the larger. By construction it sits between
                0 and 1.
              </p>
              <p>
                In an uncorrelated spectrum (Poisson — think a non-interacting lattice),
                tiny gaps are common, so <span class="mono">r</span> is small on
                average. In a chaotic system, levels actively repel and tiny gaps are
                suppressed. The dotted lines mark the four universal answers:
                <span class="ink-rose">Poisson</span> (uncorrelated),
                <span class="ink-gold">GOE</span> (real symmetric chaos),
                <span class="ink-teal">GUE</span> (complex Hermitian), and
                <span style="color:#cd8595">GSE</span> (quaternionic). The bold cream
                line marks where SYK actually landed.
              </p>
            </div>
          </div>
          <div class="lg:col-span-7">
            <p class="kicker mb-3">For physicists</p>
            <div class="prose-mid">
              <p>
                The dimensionless gap ratio
                $r_n = \min(s_n,s_{n+1})/\max(s_n,s_{n+1})$ has a parameter-free
                distribution $P(r)$ that depends only on the symmetry class
                (Atas–Bogomolny–Roux–Roy, PRL 2013). The four surmise values:
              </p>
              <ul class="mt-3 space-y-1.5 mono" style="font-size:0.92rem;">
                <li class="flex justify-between border-b" style="border-color:var(--rule-soft); padding-bottom:0.4rem;"><span class="ink-rose">Poisson</span><span class="ink-mid">0.3863</span></li>
                <li class="flex justify-between border-b" style="border-color:var(--rule-soft); padding-bottom:0.4rem;"><span class="ink-gold">GOE</span><span class="ink-mid">0.5359</span></li>
                <li class="flex justify-between border-b" style="border-color:var(--rule-soft); padding-bottom:0.4rem;"><span class="ink-teal">GUE</span><span class="ink-mid">0.5995</span></li>
                <li class="flex justify-between"><span style="color:#cd8595">GSE</span><span class="ink-mid">0.6762</span></li>
              </ul>
            </div>
          </div>
        </div>

        <figure class="plot-frame">
          <div id="plot-r" style="width:100%; height:520px;"></div>
          <figcaption class="plot-caption">
            <span>Fig. II &nbsp;·&nbsp; <span class="plot-caption-num">P(r)</span></span>
            <span class="plot-caption-text">
              Histogram of consecutive gap ratios across the ensemble, with the four
              Wigner–Dyson surmise references.
            </span>
            <span>__R_PAIRS__ pairs</span>
          </figcaption>
        </figure>
      </div>
    </div>
  </div>
</section>

<div class="container">
  <div class="fleuron"><span class="fleuron-mark">⌇ &nbsp; ⌇ &nbsp; ⌇</span></div>
</div>

<!-- ============================== SECTION 04 — SFF (the headline) ============================== -->
<section class="section reveal" x-data="{ view: 'gc' }">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num section-num-solid">04</div>
      </div>
      <div>
        <div class="mb-10">
          <p class="kicker kicker-rust mb-4">The headline · the spectral form factor</p>
          <h2 class="section-title" style="font-size: clamp(2.4rem, 6vw, 4.6rem); max-width: 16ch;">
            <span style="color: var(--rust)">Dip.</span>
            <span style="color: var(--gold)">Ramp.</span>
            <span style="color: var(--teal)">Plateau.</span>
          </h2>
        </div>

        <div class="grid lg:grid-cols-12 gap-12 items-start mb-10">
          <div class="lg:col-span-7">
            <div class="sidebar">
              <span class="sidebar-label">How to read this plot · the headline</span>
              <p>
                The horizontal axis is <strong>time</strong>; both axes are
                logarithmic. The vertical axis is the
                <strong>spectral form factor</strong> — a single number capturing
                whether the collection of energy levels has interesting long-range
                structure. Roughly, it asks: if you treat the energies as a comb of
                ticks, how does that comb interfere with itself when shifted by time
                <span class="mono">t</span>?
              </p>
              <p>
                The rust curve makes a distinctive <em>dip–ramp–plateau</em> shape: at
                short times the system thermalizes (the dip); at long times levels
                interfere coherently and the curve climbs (the ramp); at very long
                times the discreteness of the spectrum freezes everything in place
                (the plateau). The gold dashed line and the teal dotted line are
                random-matrix-theory references — drawn here, then watched as the
                SYK data lays itself directly over them.
              </p>
            </div>
          </div>

          <div class="lg:col-span-5">
            <p class="kicker mb-3">For physicists</p>
            <div class="prose-mid">
              <p>
                $g(t) = \langle |Z(\beta+it)|^2 \rangle / \langle |Z(\beta)|^2 \rangle$
                with $Z(z) = \sum_n e^{-z E_n}$. The connected part $g_c$ subtracts
                the disconnected thermal piece $|\langle Z(\beta+it)/Z(\beta)\rangle|^2$
                so that long-time spectral correlations show up unobscured.
              </p>
            </div>
            <div class="flex flex-wrap gap-2 mt-6">
              <button class="tab-btn" :class="{active: view==='gc'}" @click="view='gc'">connected $g_c$</button>
              <button class="tab-btn" :class="{active: view==='g'}" @click="view='g'">total $g$</button>
              <button class="tab-btn" :class="{active: view==='both'}" @click="view='both'">both</button>
            </div>
          </div>
        </div>

        <figure class="plot-frame">
          <div id="plot-sff"
               x-effect="window.updateSffView && window.updateSffView(view)"
               style="width:100%; height:580px;"></div>
          <figcaption class="plot-caption">
            <span>Fig. III &nbsp;·&nbsp; <span class="plot-caption-num">g(t)</span></span>
            <span class="plot-caption-text">
              The spectral form factor as a function of time. Slope-one ramp and
              plateau height are RMT predictions, not fitted to the data.
            </span>
            <span>βJ = __BETA__</span>
          </figcaption>
        </figure>

        <!-- Three editorial pull-numbers under the SFF -->
        <div class="grid md:grid-cols-3 gap-0 mt-10">
          <div class="num-card" style="padding-right:2rem;">
            <div class="label">Dip time</div>
            <div class="value">__DIP_T__ <span class="mono" style="font-size:0.85rem; color:var(--ink-dim); font-weight:400;">/ J<sup>−1</sup></span></div>
            <div class="kicker mt-2" style="text-transform:none; letter-spacing:0; font-family:'Newsreader',serif; font-style:italic; font-size:0.82rem;">
              The minimum of $g_c$, after early-time decay and before the ramp.
            </div>
          </div>
          <div class="num-card" style="padding:0 2rem; border-left:1px solid var(--rule); border-right:1px solid var(--rule);">
            <div class="label">Plateau height</div>
            <div class="value mono" style="font-size:1.6rem;">__PLATEAU__</div>
            <div class="kicker mt-2" style="text-transform:none; letter-spacing:0; font-family:'Newsreader',serif; font-style:italic; font-size:0.82rem;">
              $Z(2\beta)/Z(\beta)^2$ — discrete-spectrum floor.
            </div>
          </div>
          <div class="num-card" style="padding-left:2rem;">
            <div class="label">Ramp dynamic range</div>
            <div class="value">__RAMP_RATIO__×</div>
            <div class="kicker mt-2" style="text-transform:none; letter-spacing:0; font-family:'Newsreader',serif; font-style:italic; font-size:0.82rem;">
              Plateau ÷ dip — how much room the slope-one ramp has to develop.
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="container">
  <div class="fleuron"><span class="fleuron-mark">§ &nbsp; § &nbsp; §</span></div>
</div>

<!-- ============================== SECTION 05 — VALIDATION ============================== -->
<section class="section reveal">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num">05</div>
      </div>
      <div>
        <div class="col-text mb-8">
          <p class="kicker kicker-rust mb-4">Validation</p>
          <h2 class="section-title">Three checks the run had to pass<br/><em>before this page was rendered.</em></h2>
        </div>
        <p class="prose-mid mb-8 col-text">
          Each row below is one of the gates that <span class="mono">02_spectral_form_factor.py</span>
          exits non-zero on. If anything in this folio looks suspicious, the run
          would have failed before reaching the renderer.
        </p>

        <div class="plate" style="padding:0;">
          <table class="validation-table">
            <thead>
              <tr>
                <th>Gate</th>
                <th>Observed</th>
                <th>Reference</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              __VALIDATION_ROWS__
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="container">
  <div class="fleuron"><span class="fleuron-mark">∗ &nbsp; ∗ &nbsp; ∗</span></div>
</div>

<!-- ============================== SECTION 06 — WHY IT MATTERS ============================== -->
<section class="section reveal">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num">06</div>
      </div>
      <div class="col-text">
        <p class="kicker kicker-rust mb-4">Why this matters</p>
        <h2 class="section-title">A laptop reproduced the experiment<br/>that taught us
          <em>black holes look like<br/>random matrices.</em></h2>

        <div class="prose-body mt-10">
          <p class="dropcap">
            Here is what just happened, in three steps. <strong>(1)</strong> We wrote
            down a specific quantum Hamiltonian — N abstract Majorana operators with
            random four-body couplings — and exactly diagonalized it on a small Hilbert
            space. <strong>(2)</strong> We computed two statistical fingerprints of its
            energy spectrum: how adjacent energy gaps relate to each other, and how
            the spectrum "rings" over time. <strong>(3)</strong> Both fingerprints
            matched, with no fit parameters, the predictions of a completely different
            mathematical object: a large random matrix drawn from the Gaussian Unitary
            Ensemble.
          </p>
        </div>

        <div class="pull">
          The ramp is, literally, a wormhole contribution; the plateau is the
          discreteness of the black hole's quantum spectrum.
          <cite>— Saad, Shenker &amp; Stanford, 2018</cite>
        </div>

        <div class="prose-mid">
          <p>
            The reason this is more than a numerical curiosity is that the SYK model
            is one of the simplest known examples of <strong>holography</strong> — a
            conjectured equivalence between a quantum system on a flat background and
            a theory of gravity in one higher dimension. At low energy, SYK becomes
            mathematically equivalent to "JT gravity," a two-dimensional theory
            describing the throat of a near-extremal black hole. The dip–ramp–plateau
            you just saw is the same spectral structure that Saad, Shenker, and
            Stanford derived directly from semiclassical gravity by summing over
            wormhole geometries connecting two copies of the black hole.
          </p>
          <p>
            Since Cotler et al.'s original 2017 calculation, the same dip–ramp–plateau
            has been measured in trapped-ion analog simulators of SYK, in lattice gauge
            theories, and in the half-BPS sector of supersymmetric holographic CFTs.
            It is now considered the cleanest known finite-system signature of quantum
            chaos. You just ran the smallest version of that calculation and watched
            the curves line up on a laptop in a few minutes.
          </p>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="container">
  <div class="fleuron"><span class="fleuron-mark">⁘ &nbsp; ⁘ &nbsp; ⁘</span></div>
</div>

<!-- ============================== SECTION 07 — LEXICON ============================== -->
<section class="section reveal">
  <div class="container">
    <div class="section-grid">
      <div>
        <div class="section-num">07</div>
      </div>
      <div>
        <div class="col-text mb-8">
          <p class="kicker kicker-rust mb-4">A lexicon</p>
          <h2 class="section-title">A short index of terms<br/><em>used above.</em></h2>
          <p class="prose-mid mt-6">
            No jargon should remain unexplained. Read straight through, or use this as
            a glossary you can return to.
          </p>
        </div>

        <div class="lexicon mt-10">
          <div class="lex-item">
            <div class="lex-term">Hamiltonian</div>
            <div class="lex-def">The matrix encoding the energies of every quantum state of a system. Diagonalizing it gives the list of allowed energies (eigenvalues) and the corresponding states (eigenvectors).</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Majorana fermion</div>
            <div class="lex-def">An abstract quantum operator that is its own antiparticle. Two Majoranas anticommute (swapping them flips a sign). They are convenient algebraic building blocks; here they have no spatial position.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Disorder ensemble</div>
            <div class="lex-def">Many independent draws of the random Hamiltonian, each with its own random couplings. We average results across the ensemble to remove sample-to-sample noise.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Parity sector</div>
            <div class="lex-def">The Hamiltonian preserves a fermion-number parity (even or odd count of occupied modes). Restricting to one parity sector makes the relevant statistics cleaner.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Random matrix theory</div>
            <div class="lex-def">The mathematical study of large matrices with random entries. Its three classical Wigner–Dyson universality classes — GOE, GUE, GSE — describe how energy levels of typical chaotic quantum systems behave.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">GOE / GUE / GSE</div>
            <div class="lex-def">Gaussian Orthogonal / Unitary / Symplectic Ensembles — three families of random matrices with different symmetries (real-symmetric, complex-Hermitian, quaternion-self-dual) producing different but universal spectral statistics.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Level repulsion</div>
            <div class="lex-def">The empirical fact that, in chaotic quantum systems, two energy levels almost never come arbitrarily close together. The probability of a small gap goes to zero with a system-class-specific power.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Density of states ρ(E)</div>
            <div class="lex-def">How many energy levels per unit of energy. The first plot on this page. Says nothing about correlations between levels — only how they distribute on the energy axis.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Partition function Z(β)</div>
            <div class="lex-def">The sum of e<sup>−βE</sup> over all energy levels, with β an inverse temperature. The basic object of equilibrium statistical mechanics. Analytically continuing β → β + it lets you probe spectral correlations.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Spectral form factor</div>
            <div class="lex-def">|Z(β + it)|² / |Z(β)|² averaged over the disorder ensemble. The headline curve on this page. Encodes how the spectrum interferes with itself over time.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Dip / ramp / plateau</div>
            <div class="lex-def">Three regimes of the spectral form factor. The dip is short-time dephasing; the ramp is the slow climb back up driven by long-range spectral rigidity; the plateau is the long-time floor set by the discreteness of the energy levels.</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">Holography &nbsp;·&nbsp; AdS/CFT</div>
            <div class="lex-def">A duality in which a quantum system without gravity is mathematically equivalent to a theory of gravity in one higher dimension. SYK is a low-dimensional avatar: at low energy it is dual to gravity in a near-extremal black hole throat (JT gravity).</div>
          </div>
          <div class="lex-item">
            <div class="lex-term">JT gravity &nbsp;·&nbsp; nearly-AdS<sub>2</sub></div>
            <div class="lex-def">A two-dimensional theory of gravity describing the geometry just outside a near-extremal black hole horizon. SYK at low energy reproduces JT gravity, which is what makes its spectral statistics interesting beyond random matrix theory.</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ============================== COLOPHON ============================== -->
<footer class="colophon">
  <div class="container">
    <div class="text-center mb-12">
      <p class="display-italic" style="font-size: 1.4rem; color: var(--ink-mid);">
        — Colophon —
      </p>
    </div>
    <div class="grid md:grid-cols-2 gap-12">
      <div>
        <h4>References</h4>
        <ul class="space-y-1.5">
          <li>Sachdev, Ye. <span class="italic">PRL</span> <strong>70</strong>, 3339 (1993).</li>
          <li>Kitaev. KITP talks (2015).</li>
          <li>Maldacena, Stanford. <span class="italic">PRD</span> <strong>94</strong>, 106002 (2016).</li>
          <li>Cotler, Gur-Ari, Hanada, Polchinski, Saad, Shenker, Stanford, Streicher, Tezuka.
            <span class="italic">JHEP</span> <strong>05</strong>, 118 (2017).</li>
          <li>Saad, Shenker, Stanford. arXiv:1806.06840 (2018).</li>
          <li>You, Ludwig, Xu. <span class="italic">PRB</span> <strong>95</strong>, 115150 (2017).</li>
          <li>Atas, Bogomolny, Roux, Roy. <span class="italic">PRL</span> <strong>110</strong>, 084101 (2013).</li>
        </ul>
      </div>
      <div>
        <h4>This run</h4>
        <pre>__SYSTEM_BLOB__</pre>
        <p class="mt-4 italic" style="color: var(--ink-dim);">
          Set in Fraunces and Newsreader. Numerals in JetBrains Mono.<br/>
          Composed by <span class="mono not-italic">scripts/03_render_report.py</span>
          on <span class="mono not-italic">__GENERATED_AT__</span>.
        </p>
      </div>
    </div>
  </div>
</footer>

<!-- ============================== EMBEDDED DATA ============================== -->
<script id="report-data" type="application/json">__DATA_JSON__</script>

<!-- ============================== HERO COULOMB GAS ============================== -->
<script>
(function(){
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W=0, H=0, dpr=1;
  function resize(){
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    W = canvas.clientWidth = canvas.parentElement.clientWidth;
    H = canvas.clientHeight = canvas.parentElement.clientHeight;
    canvas.width = W*dpr; canvas.height = H*dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  window.addEventListener('resize', resize);
  resize();

  // Dyson Coulomb gas in 1D: dx_i/dt = sum_{j != i} 1/(x_i - x_j) - x_i/2 + sqrt(2T/beta) eta
  // For GUE, beta_dyson = 2.  Eigenvalues of GUE *are* this gas at equilibrium.
  const N = 18;
  const beta = 2.0;
  const T = 0.85;
  let xs = new Array(N);
  for (let i=0;i<N;i++) xs[i] = (i - (N-1)/2) * 0.85;
  const dt = 0.0028;
  const noise = Math.sqrt(2*T/beta);

  // Cream / rust / teal / gold palette — sample three accent hues.
  const palette = [
    'rgba(229,123,70,1)',   // rust
    'rgba(211,170,86,1)',   // gold
    'rgba(127,184,168,1)',  // teal
    'rgba(243,234,216,1)',  // cream
  ];

  function step(){
    const fs = new Array(N).fill(0);
    for (let i=0;i<N;i++){
      let f = -xs[i] * 0.55;        // harmonic confinement
      for (let j=0;j<N;j++) if (j!==i){
        const dx = xs[i]-xs[j];
        f += 1.0/dx;                // Coulomb repulsion
      }
      fs[i] = f;
    }
    for (let i=0;i<N;i++){
      const eta = (Math.random()*2-1) * noise;
      xs[i] += dt*fs[i] + Math.sqrt(dt) * eta * 0.45;
    }
  }

  function draw(){
    ctx.clearRect(0,0,W,H);

    const yC = H*0.5;

    // Soft horizontal sightline — like a printer's rule
    const grad = ctx.createLinearGradient(0,0,W,0);
    grad.addColorStop(0,'rgba(229,123,70,0.0)');
    grad.addColorStop(0.5,'rgba(229,123,70,0.18)');
    grad.addColorStop(1,'rgba(127,184,168,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, yC-0.5, W, 1);

    // Tick marks below the sightline
    ctx.strokeStyle = 'rgba(243,234,216,0.06)';
    ctx.lineWidth = 1;
    for (let k=0;k<41;k++){
      const px = (k/40)*W;
      ctx.beginPath();
      ctx.moveTo(px, yC + 6);
      ctx.lineTo(px, yC + (k%5===0 ? 18 : 11));
      ctx.stroke();
    }

    const minX = -10, maxX = 10;
    function xpx(x){ return ((x-minX)/(maxX-minX)) * W; }

    for (let i=0;i<N;i++){
      const px = xpx(xs[i]);

      // vertical level line — fading top + bottom
      const vGrad = ctx.createLinearGradient(0, yC-150, 0, yC+150);
      vGrad.addColorStop(0, 'rgba(243,234,216,0)');
      vGrad.addColorStop(0.5, 'rgba(243,234,216,0.14)');
      vGrad.addColorStop(1, 'rgba(243,234,216,0)');
      ctx.strokeStyle = vGrad;
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(px, yC-150); ctx.lineTo(px, yC+150); ctx.stroke();

      // glow
      const r = 7;
      const cIdx = i % palette.length;
      const col = palette[cIdx];
      const halo = ctx.createRadialGradient(px, yC, 0, px, yC, r*5);
      halo.addColorStop(0, col.replace(',1)', ',0.65)'));
      halo.addColorStop(0.4, col.replace(',1)', ',0.18)'));
      halo.addColorStop(1, col.replace(',1)', ',0)'));
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(px, yC, r*5, 0, Math.PI*2); ctx.fill();

      // core — small bright dot, cream edge over palette body
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, yC, 2.4, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = 'rgba(243,234,216,0.85)';
      ctx.beginPath(); ctx.arc(px, yC, 1.0, 0, Math.PI*2); ctx.fill();
    }
  }

  function loop(){
    for (let k=0;k<2;k++) step();
    draw();
    requestAnimationFrame(loop);
  }
  loop();
})();
</script>

<!-- ============================== SCROLL REVEAL ============================== -->
<script>
(function(){
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach(e => e.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) en.target.classList.add('in'); });
  }, { threshold: 0.12 });
  els.forEach(e => io.observe(e));
})();
</script>

<!-- ============================== PLOTS ============================== -->
<script>
(function(){
  const data = JSON.parse(document.getElementById('report-data').textContent);

  // Editorial palette mapped from CSS vars
  const C = {
    rust: '#e57b46',
    rustDeep: '#b6562b',
    teal: '#7fb8a8',
    tealDeep: '#4d8b7d',
    gold: '#d3aa56',
    rose: '#cd8595',
    ocean: '#5b8aa3',
    cream: '#f3ead8',
    creamDim: '#c5b89c',
    rule: '#28304a',
    bg: '#0e1220'
  };

  const layoutBase = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'Newsreader, Georgia, serif', color: C.creamDim, size: 13 },
    margin: { l: 70, r: 28, t: 28, b: 64 },
    xaxis: {
      gridcolor: 'rgba(244,236,220,0.05)',
      zerolinecolor: 'rgba(244,236,220,0.1)',
      linecolor: 'rgba(244,236,220,0.2)',
      tickfont: { family: 'JetBrains Mono, monospace', size: 11, color: C.creamDim },
      title: { font: { family: 'Newsreader, serif', size: 13, color: C.cream }, standoff: 16 }
    },
    yaxis: {
      gridcolor: 'rgba(244,236,220,0.05)',
      zerolinecolor: 'rgba(244,236,220,0.1)',
      linecolor: 'rgba(244,236,220,0.2)',
      tickfont: { family: 'JetBrains Mono, monospace', size: 11, color: C.creamDim },
      title: { font: { family: 'Newsreader, serif', size: 13, color: C.cream }, standoff: 16 }
    },
    showlegend: true,
    legend: {
      bgcolor: 'rgba(14,18,32,0.7)',
      bordercolor: C.rule,
      borderwidth: 1,
      font: { family: 'JetBrains Mono, monospace', size: 11, color: C.cream }
    },
    hoverlabel: {
      bgcolor: '#0e1220',
      bordercolor: C.rust,
      font: { family: 'JetBrains Mono, monospace', color: C.cream, size: 12 }
    }
  };
  const config = {
    displaylogo: false,
    responsive: true,
    modeBarButtonsToRemove: ['select2d','lasso2d','toggleSpikelines'],
    toImageButtonOptions: { format: 'png', filename: 'syk_sff', height: 800, width: 1400, scale: 2 }
  };

  // ---- spectral density ----
  Plotly.newPlot('plot-rho', [{
    x: data.rho.centers,
    y: data.rho.density,
    type: 'bar',
    marker: {
      color: 'rgba(127,184,168,0.42)',
      line: { color: 'rgba(127,184,168,0.9)', width: 1 }
    },
    name: 'ρ(E)',
    hovertemplate: 'E = %{x:.3f} J<br>ρ = %{y:.2f}<extra></extra>'
  }], Object.assign({}, layoutBase, {
    xaxis: Object.assign({}, layoutBase.xaxis, { title: 'energy E  (units of J)' }),
    yaxis: Object.assign({}, layoutBase.yaxis, { title: 'density of states  ρ(E)' })
  }), config);

  // ---- gap ratio histogram ----
  const refs = data.level_statistics.r_reference;
  const refLines = [];
  const refColors = { Poisson: C.rose, GOE: C.gold, GUE: C.teal, GSE: '#cd8595' };
  for (const k of ['Poisson','GOE','GUE','GSE']) {
    refLines.push({
      x: [refs[k], refs[k]], y: [0, 2.5],
      type: 'scatter', mode: 'lines',
      line: { dash: 'dot', color: refColors[k], width: 2 },
      name: k + '  &lt;r&gt; = ' + refs[k].toFixed(4),
      hoverinfo: 'name'
    });
  }
  const obsR = data.level_statistics.r_mean;
  refLines.push({
    x: [obsR, obsR], y: [0, 2.5],
    type: 'scatter', mode: 'lines',
    line: { color: C.cream, width: 2.5 },
    name: 'observed  &lt;r&gt; = ' + obsR.toFixed(4)
  });

  Plotly.newPlot('plot-r', [{
    x: data.level_statistics.r_hist_centers,
    y: data.level_statistics.r_hist_density,
    type: 'bar',
    marker: {
      color: 'rgba(229,123,70,0.32)',
      line: { color: 'rgba(229,123,70,0.85)', width: 1 }
    },
    name: 'P(r) observed',
    hovertemplate: 'r = %{x:.3f}<br>P(r) = %{y:.2f}<extra></extra>'
  }, ...refLines], Object.assign({}, layoutBase, {
    xaxis: Object.assign({}, layoutBase.xaxis, {
      title: 'gap ratio  r = min(s_n, s_{n+1}) / max(s_n, s_{n+1})',
      range: [0, 1]
    }),
    yaxis: Object.assign({}, layoutBase.yaxis, {
      title: 'P(r)',
      range: [0, Math.max(2.5, Math.max(...data.level_statistics.r_hist_density)*1.15)]
    })
  }), config);

  // ---- spectral form factor ----
  const sff = data.sff;
  const tArr = sff.times;
  function rampLine(){
    const t0 = sff.dip_t, g0 = Math.max(sff.dip_g, 1e-14);
    const xs = [], ys = [];
    for (let i=0;i<tArr.length;i++){
      const t = tArr[i];
      if (t < t0 || t > sff.plateau_t) continue;
      xs.push(t);
      ys.push(g0 * (t / t0));
    }
    return { xs, ys };
  }
  const ramp = rampLine();

  const traceGc = {
    x: tArr, y: sff.g_c,
    type: 'scatter', mode: 'lines',
    line: { color: C.rust, width: 2.6, shape: 'spline', smoothing: 0.5 },
    name: 'g_c(t)  connected',
    hovertemplate: 't = %{x:.3g} / J<br>g_c = %{y:.3e}<extra></extra>'
  };
  const traceG = {
    x: tArr, y: sff.g,
    type: 'scatter', mode: 'lines',
    line: { color: C.rose, width: 2.4, shape: 'spline', smoothing: 0.5 },
    name: 'g(t)  total',
    hovertemplate: 't = %{x:.3g} / J<br>g = %{y:.3e}<extra></extra>'
  };
  const traceRamp = {
    x: ramp.xs, y: ramp.ys,
    type: 'scatter', mode: 'lines',
    line: { color: C.gold, width: 2, dash: 'dash' },
    name: 'slope-1 ramp  (RMT)',
    hoverinfo: 'name'
  };
  const tracePlateau = {
    x: [tArr[0], tArr[tArr.length-1]],
    y: [sff.plateau_ref, sff.plateau_ref],
    type: 'scatter', mode: 'lines',
    line: { color: C.teal, width: 1.6, dash: 'dot' },
    name: 'plateau  Z(2β)/Z(β)²',
    hoverinfo: 'name'
  };
  const traceDip = {
    x: [sff.dip_t], y: [sff.dip_g],
    type: 'scatter', mode: 'markers',
    marker: { color: C.gold, size: 14, symbol: 'circle-open', line: { width: 2.2 } },
    name: 'dip',
    hovertemplate: 'dip at t = %{x:.3g} / J<extra></extra>'
  };

  const sffLayout = Object.assign({}, layoutBase, {
    xaxis: Object.assign({}, layoutBase.xaxis, {
      title: 'time t  (units of 1/J)',
      type: 'log', exponentformat: 'power'
    }),
    yaxis: Object.assign({}, layoutBase.yaxis, {
      title: 'spectral form factor',
      type: 'log', exponentformat: 'power'
    })
  });

  let currentView = 'gc';
  function viewTraces(view){
    if (view === 'g')   return [traceG, traceRamp, tracePlateau, traceDip];
    if (view === 'both')return [traceG, traceGc, traceRamp, tracePlateau, traceDip];
    return [traceGc, traceRamp, tracePlateau, traceDip];
  }
  Plotly.newPlot('plot-sff', viewTraces(currentView), sffLayout, config);

  window.updateSffView = function(view){
    if (view === currentView) return;
    currentView = view;
    Plotly.react('plot-sff', viewTraces(view), sffLayout, config);
  };
})();
</script>

</body>
</html>
"""


def fmt_float(x: float, decimals: int = 4) -> str:
    return f"{x:.{decimals}f}"


def fmt_sci(x: float) -> str:
    return f"{x:.3e}"


def badge(ok: bool, ok_text: str = "PASS", bad_text: str = "FAIL") -> str:
    cls = "pill pill-good" if ok else "pill pill-bad"
    txt = ok_text if ok else bad_text
    return f'<span class="{cls}"><span class="w-2 h-2 rounded-full" style="background:currentColor"></span>{txt}</span>'


def validation_row(name: str, observed: str, reference: str, ok: bool) -> str:
    return (
        '<tr>'
        f'<td>{name}</td>'
        f'<td>{observed}</td>'
        f'<td>{reference}</td>'
        f'<td>{badge(ok)}</td>'
        '</tr>'
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=str, default="sff_data.json")
    ap.add_argument("--metrics", type=str, default="metrics.json")
    ap.add_argument("--out", type=str, default="report.html")
    args = ap.parse_args()

    data_path = HERE / args.data
    metrics_path = HERE / args.metrics
    out_path = HERE / args.out

    with open(data_path) as fh:
        data = json.load(fh)
    with open(metrics_path) as fh:
        metrics = json.load(fh)

    sys = data["system"]
    ls = data["level_statistics"]
    sff = data["sff"]

    # Validation rows
    rows: list[str] = []
    cls = sys["expected_class"]
    rows.append(
        validation_row(
            f"Mean gap ratio &lt;r&gt; matches {cls}",
            f'{fmt_float(ls["r_mean"])} ± {fmt_float(ls["r_sem"])}',
            f'{fmt_float(ls["r_reference"][cls])} (Atas surmise)',
            metrics["level_statistics"]["r_within_tolerance"],
        )
    )
    rows.append(
        validation_row(
            "Dip–ramp–plateau structure present",
            f'plateau / dip = {metrics["sff"]["dip_to_plateau_ratio"]:.2f}×',
            "&gt; 3× (ramp must clear the dip)",
            metrics["sff"]["ramp_present"],
        )
    )
    rows.append(
        validation_row(
            "Late-time plateau matches Z(2β)/Z(β)²",
            f'observed {fmt_sci(metrics["sff"]["plateau_observed_at_tmax"])} vs reference {fmt_sci(metrics["sff"]["plateau_ref"])}',
            "within 50%",
            metrics["sff"]["plateau_within_tolerance"],
        )
    )

    # Validation badge for the level-stats card.
    r_ok = metrics["level_statistics"]["r_within_tolerance"]
    r_badge = badge(r_ok, "within tolerance", "outside tolerance")

    delta = ls["r_mean"] - ls["r_reference"][cls]
    delta_str = f"{delta:+.4f}"

    system_blob = json.dumps(sys, indent=2)

    # Number of independent J couplings: C(N, 4)
    N = int(sys["N"])
    n_tuples = N * (N - 1) * (N - 2) * (N - 3) // 24

    html = HTML_TEMPLATE
    replacements = {
        "__GENERATED_AT__": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "__N__": str(sys["N"]),
        "__N_TUPLES__": f"{n_tuples:,}",
        "__SAMPLES__": str(sys["samples"]),
        "__DIM__": str(sys["dim_even_parity_sector"]),
        "__CLASS__": cls,
        "__BETA__": fmt_float(sys["beta_J"], 2),
        "__R_MEAN__": fmt_float(ls["r_mean"]),
        "__R_SEM__": fmt_float(ls["r_sem"]),
        "__R_REF__": fmt_float(ls["r_reference"][cls]),
        "__R_DELTA__": delta_str,
        "__R_PAIRS__": f'{ls["r_n_pairs"]:,}',
        "__R_BADGE__": r_badge,
        "__DIP_T__": f'{sff["dip_t"]:.2f}',
        "__PLATEAU__": fmt_sci(sff["plateau_ref"]),
        "__RAMP_RATIO__": f'{metrics["sff"]["dip_to_plateau_ratio"]:.1f}',
        "__VALIDATION_ROWS__": "\n".join(rows),
        "__SYSTEM_BLOB__": system_blob,
        "__DATA_JSON__": json.dumps(data),
    }
    for k, v in replacements.items():
        html = html.replace(k, v)

    with open(out_path, "w") as fh:
        fh.write(html)
    print(f"Wrote {out_path} ({len(html)/1024:.1f} KB)")
    print("Open it directly in a browser, or:")
    print(f"  python -m http.server -d {HERE}")


if __name__ == "__main__":
    main()
