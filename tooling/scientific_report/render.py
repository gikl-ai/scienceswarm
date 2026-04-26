"""Spec → HTML rendering pipeline.

The renderer is deliberately minimal: it picks a theme, hands the spec to
the theme module, and writes the result.  Theme modules own their entire
HTML/CSS/JS surface (nothing is shared across themes by accident); shared
helpers only kick in when a theme explicitly opts in.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .themes import broadsheet

_THEMES = {
    "broadsheet": broadsheet,
}


def render_to_string(spec: dict[str, Any]) -> str:
    """Render a spec to an HTML string."""
    theme_name = spec.get("meta", {}).get("theme") or "broadsheet"
    if theme_name not in _THEMES:
        raise ValueError(
            f"unknown theme {theme_name!r}; available: {sorted(_THEMES)}"
        )
    theme = _THEMES[theme_name]
    return theme.render(spec)


def render_report(spec: dict[str, Any], out_path: Path) -> Path:
    """Render a spec and write it to disk.  Returns the absolute path."""
    out = Path(out_path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    html = render_to_string(spec)
    out.write_text(html, encoding="utf-8")
    return out


def load_spec(spec_path: Path) -> dict[str, Any]:
    """Convenience loader.  UTF-8 explicit so non-ASCII characters in case
    names, interpretation prose, etc. round-trip cleanly on locales whose
    default encoding is not UTF-8 (Windows being the most common case)."""
    with open(spec_path, encoding="utf-8") as fh:
        return json.load(fh)
