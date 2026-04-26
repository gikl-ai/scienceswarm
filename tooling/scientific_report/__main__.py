"""CLI entry point for scientific_report.

Usage:
    python -m scientific_report --spec path/to/spec.json --out path/to/report.html
                                [--theme broadsheet]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .render import render_report


def main() -> int:
    ap = argparse.ArgumentParser(prog="scientific_report")
    ap.add_argument("--spec", required=True, type=Path,
                    help="Path to the JSON spec file describing the report.")
    ap.add_argument("--out", required=True, type=Path,
                    help="Output HTML file path.")
    ap.add_argument("--theme", default=None,
                    help="Theme name to use (default: spec.meta.theme or 'broadsheet').")
    args = ap.parse_args()

    with open(args.spec, encoding="utf-8") as fh:
        spec = json.load(fh)
    if args.theme:
        spec.setdefault("meta", {})["theme"] = args.theme

    out_path = render_report(spec, args.out)
    size_kb = out_path.stat().st_size / 1024
    print(f"Wrote {out_path} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
