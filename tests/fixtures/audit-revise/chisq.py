#!/usr/bin/env python3
"""Naive chi-square analysis for the Mendel revise-and-resubmit fixture.

The CSV uses one row per observed phenotype. Rows with the same
``experiment_id`` form one goodness-of-fit test, and ``expected_ratio`` holds
the Mendelian ratio weight for that phenotype.
"""

from __future__ import annotations

import argparse
import csv
import importlib.metadata
import json
import math
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


SEED = 42
ITMAX = 100
EPS = 3.0e-7
FPMIN = 1.0e-30


@dataclass(frozen=True)
class Observation:
    experiment_id: str
    trait: str
    phenotype: str
    observed: int
    expected_ratio: float
    source_note: str


def _gser(a: float, x: float) -> float:
    """Lower regularized incomplete gamma P(a, x)."""
    if x <= 0:
        return 0.0
    gln = math.lgamma(a)
    ap = a
    summation = 1.0 / a
    delta = summation
    for _ in range(ITMAX):
        ap += 1.0
        delta *= x / ap
        summation += delta
        if abs(delta) < abs(summation) * EPS:
            return summation * math.exp(-x + a * math.log(x) - gln)
    return summation * math.exp(-x + a * math.log(x) - gln)


def _gcf(a: float, x: float) -> float:
    """Upper regularized incomplete gamma Q(a, x)."""
    gln = math.lgamma(a)
    b = x + 1.0 - a
    c = 1.0 / FPMIN
    d = 1.0 / max(b, FPMIN)
    h = d
    for i in range(1, ITMAX + 1):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < FPMIN:
            d = FPMIN
        c = b + an / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < EPS:
            break
    return math.exp(-x + a * math.log(x) - gln) * h


def gammaincc(a: float, x: float) -> float:
    """Upper regularized incomplete gamma Q(a, x), stdlib-only fallback."""
    if a <= 0:
        raise ValueError("a must be positive")
    if x < 0:
        raise ValueError("x must be non-negative")
    if x < a + 1.0:
        return 1.0 - _gser(a, x)
    return _gcf(a, x)


def chi_square_sf(statistic: float, degrees_of_freedom: int) -> float:
    """Survival function for a chi-square variate."""
    try:
        from scipy.stats import chi2  # type: ignore

        return float(chi2.sf(statistic, degrees_of_freedom))
    except Exception:
        return gammaincc(degrees_of_freedom / 2.0, statistic / 2.0)


def read_observations(path: Path) -> list[Observation]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        required = {
            "experiment_id",
            "trait",
            "phenotype",
            "observed",
            "expected_ratio",
        }
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"CSV missing required columns: {sorted(missing)}")
        observations = []
        for row_number, row in enumerate(reader, start=2):
            try:
                observed = int(row["observed"])
                expected_ratio = float(row["expected_ratio"])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"invalid numeric value on row {row_number}") from exc
            if observed < 0 or expected_ratio <= 0:
                raise ValueError(f"invalid count or ratio on row {row_number}")
            observations.append(
                Observation(
                    experiment_id=row["experiment_id"].strip(),
                    trait=row["trait"].strip(),
                    phenotype=row["phenotype"].strip(),
                    observed=observed,
                    expected_ratio=expected_ratio,
                    source_note=(row.get("source_note") or "").strip(),
                )
            )
    return observations


def grouped(observations: Iterable[Observation]) -> dict[str, list[Observation]]:
    groups: dict[str, list[Observation]] = {}
    for observation in observations:
        groups.setdefault(observation.experiment_id, []).append(observation)
    return groups


def analyze_group(rows: list[Observation]) -> dict[str, object]:
    if len(rows) < 2:
        raise ValueError(f"{rows[0].experiment_id} must have at least two phenotypes")
    total_observed = sum(row.observed for row in rows)
    ratio_total = sum(row.expected_ratio for row in rows)
    components = []
    statistic = 0.0
    for row in rows:
        expected = total_observed * row.expected_ratio / ratio_total
        contribution = ((row.observed - expected) ** 2) / expected
        statistic += contribution
        components.append(
            {
                "phenotype": row.phenotype,
                "observed": row.observed,
                "expected": round(expected, 6),
                "expected_ratio": row.expected_ratio,
                "chi_square_component": round(contribution, 9),
            }
        )
    degrees_of_freedom = len(rows) - 1
    p_value = chi_square_sf(statistic, degrees_of_freedom)
    return {
        "experiment_id": rows[0].experiment_id,
        "trait": rows[0].trait,
        "n": total_observed,
        "degrees_of_freedom": degrees_of_freedom,
        "chi_square": round(statistic, 9),
        "p_value": round(p_value, 9),
        "components": components,
    }


def analyze(path: Path) -> dict[str, object]:
    observations = read_observations(path)
    experiments = [analyze_group(rows) for rows in grouped(observations).values()]
    aggregate_chi_square = sum(float(item["chi_square"]) for item in experiments)
    aggregate_degrees_of_freedom = sum(int(item["degrees_of_freedom"]) for item in experiments)
    return {
        "analysis": "mendel_chi_square_goodness_of_fit",
        "seed": SEED,
        "input": str(path),
        "experiment_count": len(experiments),
        "row_count": len(observations),
        "aggregate": {
            "degrees_of_freedom": aggregate_degrees_of_freedom,
            "chi_square": round(aggregate_chi_square, 9),
            "p_value": round(
                chi_square_sf(aggregate_chi_square, aggregate_degrees_of_freedom),
                9,
            ),
        },
        "experiments": experiments,
        "env": {
            "python": platform.python_version(),
            "scipy": optional_version("scipy"),
            "pymc": optional_version("pymc"),
            "matplotlib": optional_version("matplotlib"),
        },
    }


def optional_version(module_name: str) -> str:
    try:
        return importlib.metadata.version(module_name)
    except importlib.metadata.PackageNotFoundError:
        return "not_installed"


def render_markdown(result: dict[str, object]) -> str:
    aggregate = result["aggregate"]
    assert isinstance(aggregate, dict)
    lines = [
        "# Mendel chi-square fixture analysis",
        "",
        f"Seed: {result['seed']}",
        f"Experiments: {result['experiment_count']}",
        f"Rows: {result['row_count']}",
        "",
        "## Aggregate",
        "",
        f"- chi_square: {aggregate['chi_square']}",
        f"- degrees_of_freedom: {aggregate['degrees_of_freedom']}",
        f"- p_value: {aggregate['p_value']}",
        "",
        "## Per-experiment results",
        "",
    ]
    experiments = result["experiments"]
    assert isinstance(experiments, list)
    for item in experiments:
        assert isinstance(item, dict)
        lines.append(
            "- {experiment_id}: n={n}, df={degrees_of_freedom}, "
            "chi_square={chi_square}, p_value={p_value}".format(**item)
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "csv_path",
        nargs="?",
        default=Path(__file__).with_name("mendel-counts.csv"),
        type=Path,
        help="Path to mendel-counts.csv",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON only",
    )
    args = parser.parse_args()

    result = analyze(args.csv_path)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(render_markdown(result))
        print()
        print("```json")
        print(json.dumps(result, indent=2, sort_keys=True))
        print("```")


if __name__ == "__main__":
    main()
