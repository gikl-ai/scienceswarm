"""Stage 2 — compute the spectral form factor and level statistics.

Reads spectra.npz (the disorder ensemble produced by 01_diagonalize.py)
and computes:

  - the spectral form factor at finite inverse temperature beta,
        g(t; beta) = < |Z(beta + i t)|^2 / Z(beta)^2 >_disorder,
    on a logarithmic grid in t, where Z(z) = sum_n exp(-z E_n).  Also
    reports the disconnected piece <Z(beta+it)/Z(beta)>^2 and the
    connected SFF g_c = g - g_disc.
  - the unfolded nearest-neighbor gap ratio
        r_n = min(s_n, s_{n+1}) / max(s_n, s_{n+1}),  s_n = E_{n+1} - E_n,
    which has a parameter-free distribution P(r) (Atas et al. 2013) that
    distinguishes Poisson, GOE, GUE, and GSE.  For GSE spectra, exact
    two-fold Kramers pairs are collapsed before computing r_n.
  - the spectral density rho(E), averaged over disorder realizations.

Reference values for <r> from the Atas-Bogomolny-Roux-Roy 2013 surmise
(PRL 110.084101).  The surmise mean is computed by integrating r * P(r)
on r in [0, 1] for each ensemble class:
    Poisson:  2 ln 2 - 1                     ~  0.38629
    GOE:      Atas surmise mean              ~  0.53071
    GUE:      Atas surmise mean              ~  0.59945
    GSE:      Atas surmise mean              ~  0.67617

(Do not confuse the GOE gap-ratio surmise mean ~ 0.5307 with the unrelated
Wigner level-spacing value 4 - 2 sqrt 3 ~ 0.5359, which is the mean of the
spacing distribution P(s) and not the gap-ratio surmise.)

For N = 22 (the default), N mod 8 = 6 -> GUE in the even-parity sector.

Outputs:
  - sff_data.json (curves and reference overlays for the HTML report)
  - metrics.json  (validation gates; non-zero exit if any gate fails)

For non-degenerate spectra the SFF plateau gate compares against the
finite-sample average of Z(2 beta) / Z(beta)^2.  For GSE spectra, the plateau
reference is degeneracy-aware for Kramers pairs; using the naive all-eigenvalue
ratio would underestimate the physical late-time diagonal contribution.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

# Atas-Bogomolny-Roux-Roy 2013 surmise reference values for <r>.
R_REFERENCE: dict[str, float] = {
    "Poisson": 0.38629,
    "GOE": 0.53071,
    "GUE": 0.59945,
    "GSE": 0.67617,
}


def gap_ratio(eigvals: np.ndarray) -> np.ndarray:
    """Return r_n = min(s_n, s_{n+1}) / max(s_n, s_{n+1}) for each row."""
    spacings = np.diff(eigvals, axis=-1)
    s1 = spacings[..., :-1]
    s2 = spacings[..., 1:]
    denominator = np.maximum(s1, s2)
    return np.minimum(s1, s2) / denominator


def collapse_kramers_pairs(eigvals: np.ndarray) -> tuple[np.ndarray, float, float]:
    """Collapse adjacent two-fold Kramers pairs for GSE gap statistics.

    The physical spectrum still contains the two-fold degeneracy.  The Atas
    GSE gap-ratio surmise, however, is defined on the sequence of distinct
    Kramers pairs.  Without this collapse, every other spacing is numerically
    zero and <r> is forced to zero even when the GSE block is correct.
    """
    n_samples, dim = eigvals.shape
    if dim % 2 != 0:
        raise ValueError(
            f"GSE Kramers collapse expected an even spectrum dimension, got {dim}"
        )
    pairs = eigvals.reshape(n_samples, dim // 2, 2)
    pair_splits = np.abs(pairs[..., 1] - pairs[..., 0])
    scale = max(1.0, float(eigvals.max() - eigvals.min()))
    tolerance = 1e-8 * scale
    max_split = float(pair_splits.max())
    if max_split > tolerance:
        raise ValueError(
            "GSE Kramers-pair collapse failed: adjacent pair split "
            f"{max_split:.3e} exceeds tolerance {tolerance:.3e}. "
            "Check parity projection and eigenvalue ordering."
        )
    return pairs.mean(axis=-1), max_split, tolerance


def plateau_reference(
    eigvals: np.ndarray, beta: float, cls: str
) -> tuple[float, str]:
    """Return the finite-sample plateau reference for the connected SFF.

    For non-degenerate spectra this is the sample mean of
    Z(2 beta) / Z(beta)^2.  For GSE, Kramers degeneracy doubles each
    eigenvalue's multiplicity.  The late-time diagonal contribution is then
    sum_j d_j^2 exp(-2 beta E_j) / (sum_j d_j exp(-beta E_j))^2, not the
    naive all-eigenvalue Z(2 beta) / Z(beta)^2, which would be too small by
    roughly a factor of two.
    """
    if cls == "GSE":
        distinct, _, _ = collapse_kramers_pairs(eigvals)
        degeneracy = 2.0
        numerator = (degeneracy**2) * np.exp(-2 * beta * distinct).sum(axis=1)
        denominator = (degeneracy * np.exp(-beta * distinct).sum(axis=1)) ** 2
        return (
            float(np.mean(numerator / denominator)),
            "degeneracy-aware Kramers-pair time average",
        )

    numerator = np.exp(-2 * beta * eigvals).sum(axis=1)
    denominator = np.exp(-beta * eigvals).sum(axis=1) ** 2
    return float(np.mean(numerator / denominator)), "sample-mean Z(2 beta) / Z(beta)^2"


def expected_class(N: int) -> str:
    """Wigner-Dyson class of the q=4 SYK even-parity block by N mod 8.

    Standard SYK Bott-periodicity classification (You-Ludwig-Xu 2017):
      N mod 8 = 0  -> GOE
      N mod 8 = 2  -> GUE
      N mod 8 = 4  -> GSE
      N mod 8 = 6  -> GUE
    """
    table = {0: "GOE", 2: "GUE", 4: "GSE", 6: "GUE"}
    if N % 8 not in table:
        raise ValueError(
            f"N = {N} is odd; SYK_4 requires an even number of Majoranas. "
            "Re-run 01_diagonalize.py with --N <even>."
        )
    return table[N % 8]


def spectral_form_factor(
    spectra: np.ndarray, beta: float, times: np.ndarray
) -> dict[str, np.ndarray]:
    """Compute g(t; beta), g_disc(t; beta), g_c(t; beta), and the per-time
    standard deviation across disorder realizations.

    Vectorized: the bottleneck is exp(-i t E) for (n_times, dim).  For
    n_samples ~ 80, dim ~ 1024, n_times ~ 200 this is well under a GB.
    """
    n_samples, dim = spectra.shape
    n_t = times.size

    Z_b = np.exp(-beta * spectra).sum(axis=1)  # (n_samples,)

    g_per_sample = np.empty((n_samples, n_t), dtype=np.float64)
    mean_ratio = np.zeros(n_t, dtype=np.complex128)

    # Sum_n exp(-(beta + i t) E_n).  Process samples in a loop to keep
    # peak memory at one (n_t, dim) matrix.
    for s in range(n_samples):
        E = spectra[s]
        w = np.exp(-beta * E)  # weight_n = exp(-beta E_n), (dim,)
        phases = np.exp(-1j * np.outer(times, E))  # (n_t, dim)
        Z_complex = phases @ w  # Z(beta + i t), (n_t,)
        ratio = Z_complex / Z_b[s]
        g_per_sample[s] = np.abs(ratio) ** 2
        mean_ratio += ratio
    mean_ratio /= n_samples

    g = g_per_sample.mean(axis=0)
    g_disc = np.abs(mean_ratio) ** 2
    g_c = g - g_disc
    g_std = g_per_sample.std(axis=0) / np.sqrt(n_samples)  # SEM

    return {
        "g": g,
        "g_disc": g_disc,
        "g_c": g_c,
        "g_sem": g_std,
        "Z_b_mean": float(Z_b.mean()),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_path", type=str, default="spectra.npz")
    ap.add_argument("--out-data", type=str, default="sff_data.json")
    ap.add_argument("--out-metrics", type=str, default="metrics.json")
    ap.add_argument("--beta", type=float, default=5.0, help="Inverse temperature beta * J")
    ap.add_argument("--n-times", type=int, default=240, help="Points on the SFF time grid")
    ap.add_argument("--t-min", type=float, default=0.05, help="Min t (in units of 1/J)")
    ap.add_argument("--t-max", type=float, default=4000.0, help="Max t (in units of 1/J)")
    ap.add_argument("--n-bins-rho", type=int, default=120, help="Bins for rho(E)")
    ap.add_argument("--n-bins-r", type=int, default=40, help="Bins for P(r)")
    args = ap.parse_args()

    npz = np.load(HERE / args.in_path)
    spectra: np.ndarray = npz["spectra"]
    N = int(npz["N"])
    J = float(npz["J"])
    sigma = float(npz["sigma"])
    samples = int(npz["samples"])
    dim = int(npz["dim_even"])
    cls = expected_class(N)
    print(
        f"Loaded ensemble: N={N}, dim_even={dim}, samples={samples}, "
        f"expected class={cls}"
    )

    # ---- Spectral density rho(E) -----------------------------------------
    e_lo = float(spectra.min())
    e_hi = float(spectra.max())
    rho_edges = np.linspace(e_lo, e_hi, args.n_bins_rho + 1)
    rho_counts = np.zeros(args.n_bins_rho, dtype=np.float64)
    for s in range(samples):
        rho_counts += np.histogram(spectra[s], bins=rho_edges)[0]
    rho_counts /= samples
    rho_centers = 0.5 * (rho_edges[:-1] + rho_edges[1:])
    rho_density = rho_counts / (rho_edges[1] - rho_edges[0])  # per unit E

    # ---- Gap ratio statistics --------------------------------------------
    gap_spectra = spectra
    kramers_info: dict[str, float | bool] = {"pairs_collapsed": False}
    if cls == "GSE":
        gap_spectra, max_split, pair_tolerance = collapse_kramers_pairs(spectra)
        kramers_info = {
            "pairs_collapsed": True,
            "max_pair_split": max_split,
            "pair_tolerance": pair_tolerance,
        }
        print(
            "Collapsed Kramers pairs for GSE gap statistics: "
            f"dim {spectra.shape[1]} -> {gap_spectra.shape[1]}, "
            f"max pair split {max_split:.3e}"
        )

    r_all = gap_ratio(gap_spectra).reshape(-1)
    r_mean = float(r_all.mean())
    r_sem = float(r_all.std() / np.sqrt(r_all.size))
    r_hist_counts, r_hist_edges = np.histogram(
        r_all, bins=args.n_bins_r, range=(0.0, 1.0), density=True
    )
    r_hist_centers = 0.5 * (r_hist_edges[:-1] + r_hist_edges[1:])

    print(f"<r> = {r_mean:.4f} +/- {r_sem:.4f}  (reference {cls} = {R_REFERENCE[cls]:.4f})")

    # ---- Spectral form factor --------------------------------------------
    times = np.logspace(np.log10(args.t_min), np.log10(args.t_max), args.n_times)
    print(
        f"Computing SFF on {args.n_times} log-spaced t in "
        f"[{args.t_min}, {args.t_max}] / J  at beta*J = {args.beta} ..."
    )
    t0 = time.time()
    sff = spectral_form_factor(spectra, beta=args.beta, times=times)
    print(f"  done in {time.time() - t0:.1f}s")

    # Plateau reference (finite-sample theoretical asymptote at t -> infty).
    # For GSE this must account for Kramers degeneracy; see plateau_reference.
    plateau_ref, plateau_ref_kind = plateau_reference(spectra, args.beta, cls)

    # The slope-1 ramp reference: K_RMT(t) ~ t / (pi * Z(beta)^2)? In our
    # normalization (per-sample |Z(beta+it)|^2 / Z(beta)^2 averaged) the
    # ramp slope on log-log is 1 over a window between dip time ~ sqrt(N)
    # and Heisenberg time ~ dim.  We just emit a slope-1 line anchored to
    # the dip for the visual overlay.
    g_c = sff["g_c"]
    # Identify the dip: minimum of g_c at moderate t (avoid early and late
    # transients).
    mask = (times > 0.5) & (times < 0.5 * times.max())
    if mask.any():
        idx = np.argmin(g_c[mask])
        dip_t = float(times[mask][idx])
        dip_g = float(g_c[mask][idx])
    else:
        dip_t, dip_g = float(times[len(times) // 4]), float(g_c[len(times) // 4])

    # Asymptotic plateau reached when g_c returns to the plateau_ref level.
    above = np.where((times > dip_t) & (g_c > plateau_ref))[0]
    if above.size > 1:
        plateau_t = float(times[above[-1]])
    else:
        plateau_t = float(times[-1])

    # ---- Write the report payload ----------------------------------------
    payload: dict = {
        "system": {
            "model": "SYK_4",
            "N": N,
            "J": J,
            "sigma_J": sigma,
            "samples": samples,
            "dim_even_parity_sector": dim,
            "expected_class": cls,
            "beta_J": args.beta,
        },
        "rho": {
            "edges": rho_edges.tolist(),
            "centers": rho_centers.tolist(),
            "density": rho_density.tolist(),
        },
        "level_statistics": {
            "r_mean": r_mean,
            "r_sem": r_sem,
            "r_reference": R_REFERENCE,
            "r_hist_centers": r_hist_centers.tolist(),
            "r_hist_density": r_hist_counts.tolist(),
            "r_n_pairs": int(r_all.size),
            "kramers": kramers_info,
        },
        "sff": {
            "times": times.tolist(),
            "g": sff["g"].tolist(),
            "g_disc": sff["g_disc"].tolist(),
            "g_c": sff["g_c"].tolist(),
            "g_sem": sff["g_sem"].tolist(),
            "plateau_ref": plateau_ref,
            "plateau_ref_kind": plateau_ref_kind,
            "dip_t": dip_t,
            "dip_g": dip_g,
            "plateau_t": plateau_t,
            "Z_beta_mean": float(np.exp(-args.beta * spectra).sum(axis=1).mean()),
            "Z_2beta_mean": float(np.exp(-2 * args.beta * spectra).sum(axis=1).mean()),
        },
    }

    with open(HERE / args.out_data, "w") as fh:
        json.dump(payload, fh)
    print(f"Wrote {args.out_data}")

    # ---- Validation gates ------------------------------------------------
    # Reference tolerance for <r>: empirically, with parity projection and
    # 60+ samples in dim ~ 1024+, <r> lands within ~0.015 of the surmise.
    r_ref = R_REFERENCE[cls]
    r_tol = 0.020
    r_ok = abs(r_mean - r_ref) < r_tol

    # SFF must show a real ramp: g_c at the largest sampled t should be
    # within 50% of the theoretical plateau, and the minimum (dip) should
    # be at least 3x below the plateau.
    plateau_g = float(g_c[-1])
    plateau_ok = abs(plateau_g - plateau_ref) / plateau_ref < 0.5
    ramp_ok = (plateau_ref / dip_g) > 3.0

    metrics: dict = {
        "system": payload["system"],
        "level_statistics": {
            "r_mean": r_mean,
            "r_sem": r_sem,
            "expected_class": cls,
            "r_reference": r_ref,
            "r_tolerance": r_tol,
            "r_within_tolerance": bool(r_ok),
            "kramers": kramers_info,
        },
        "sff": {
            "plateau_ref": plateau_ref,
            "plateau_ref_kind": plateau_ref_kind,
            "plateau_observed_at_tmax": plateau_g,
            "plateau_within_tolerance": bool(plateau_ok),
            "dip_g_c": dip_g,
            "dip_to_plateau_ratio": plateau_ref / dip_g,
            "ramp_present": bool(ramp_ok),
        },
    }
    with open(HERE / args.out_metrics, "w") as fh:
        json.dump(metrics, fh, indent=2)

    print(json.dumps(metrics["level_statistics"], indent=2))
    print(json.dumps(metrics["sff"], indent=2))

    failures = []
    if not r_ok:
        failures.append(
            f"<r> = {r_mean:.4f} differs from {cls} reference {r_ref:.4f} "
            f"by more than tolerance {r_tol}; check parity projection or "
            f"increase samples"
        )
    if not ramp_ok:
        failures.append(
            f"dip-to-plateau ratio {plateau_ref/dip_g:.2f} < 3; either too "
            f"few samples or t_max too small to expose the ramp"
        )
    if not plateau_ok:
        failures.append(
            f"plateau at t_max ({plateau_g:.3e}) differs from "
            f"theoretical Z(2 beta)/Z(beta)^2 ({plateau_ref:.3e}) by >50%; "
            f"extend t_max"
        )
    if failures:
        for f in failures:
            print("FAIL:", f)
        raise SystemExit(1)

    print("\nOK: <r> within tolerance for the expected Wigner-Dyson class")
    print("OK: dip-ramp-plateau structure present")
    print("OK: late-time plateau matches Z(2 beta) / Z(beta)^2")


if __name__ == "__main__":
    main()
