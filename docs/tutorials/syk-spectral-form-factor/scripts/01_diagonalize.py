"""Stage 1 — build the SYK_4 Hamiltonian and diagonalize a disorder ensemble.

For N Majorana fermions (N even), the q=4 SYK Hamiltonian is

    H = sum_{a<b<c<d} J_{abcd} chi_a chi_b chi_c chi_d

with J_{abcd} drawn from N(0, sigma^2) where sigma^2 = 6 J^2 / N^3 (the
standard q=4 SYK normalization, see Maldacena-Stanford 2016 eq. 1.1).
We set J = 1, so all energies are reported in units of J.

We represent Majoranas via Jordan-Wigner on M = N/2 qubits:
    chi_{2k-1} = Z_1 ... Z_{k-1} X_k        (k = 1..M)
    chi_{2k}   = Z_1 ... Z_{k-1} Y_k        (k = 1..M)
which satisfy {chi_a, chi_b} = 2 delta_{ab}.

Each 4-Majorana product preserves fermion parity P = Z_1 ... Z_M, so we
project H onto the even-parity sector to land in a single irreducible
random-matrix block.  For N mod 8 in {2, 6}, that block is GUE (this
tutorial defaults to N = 22, mod 8 = 6 -> GUE).

Output: spectra.npz with the full ensemble spectrum and metadata.

Run:
    python 01_diagonalize.py                # default N=22, 80 samples (~4 min CPU)
    python 01_diagonalize.py --N 20 --samples 60   # ~30 s preview
    python 01_diagonalize.py --N 24 --samples 40   # ~12 min, sharper ramp
"""

from __future__ import annotations

import argparse
import time
from itertools import combinations
from pathlib import Path

import numpy as np
from scipy import sparse

HERE = Path(__file__).resolve().parent


def build_majoranas(N: int) -> list[sparse.csr_matrix]:
    """Return [chi_1, ..., chi_N] as sparse 2^M x 2^M matrices, M = N/2."""
    if N % 2 != 0:
        raise ValueError("N must be even")
    M = N // 2
    sx = sparse.csr_matrix(np.array([[0, 1], [1, 0]], dtype=np.complex128))
    sy = sparse.csr_matrix(np.array([[0, -1j], [1j, 0]], dtype=np.complex128))
    sz = sparse.csr_matrix(np.array([[1, 0], [0, -1]], dtype=np.complex128))
    eye = sparse.eye(2, dtype=np.complex128, format="csr")
    chis: list[sparse.csr_matrix] = []
    for k in range(1, M + 1):
        for s in (sx, sy):
            op = s
            for _ in range(k - 1):
                op = sparse.kron(sz, op, format="csr")
            for _ in range(M - k):
                op = sparse.kron(op, eye, format="csr")
            chis.append(op)
    return chis


def parity_even_indices(N: int) -> np.ndarray:
    """Indices in the computational basis with an even number of |1>'s
    (eigenvalue +1 of P = Z_1 ... Z_{N/2})."""
    M = N // 2
    dim = 1 << M
    idx = np.arange(dim, dtype=np.int64)
    bits = np.zeros(dim, dtype=np.int64)
    for b in range(M):
        bits += (idx >> b) & 1
    return np.flatnonzero(bits % 2 == 0)


def precompute_quartic_perms(
    chis: list[sparse.csr_matrix], even_idx: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """For every (a<b<c<d), compute chi_a chi_b chi_c chi_d restricted to
    the even-parity sector and return (cols, signs) such that

        H[i, cols[t, i]] += J[t] * signs[t, i]

    where i indexes the even sector.  Each restricted operator is a
    signed-and-phased permutation (one nonzero per row), since a Pauli
    string is itself a signed permutation up to a global phase.
    """
    N = len(chis)
    dim = chis[0].shape[0]
    dim_even = even_idx.size
    inv = -np.ones(dim, dtype=np.int64)
    inv[even_idx] = np.arange(dim_even, dtype=np.int64)

    n_tuples = sum(1 for _ in combinations(range(N), 4))
    cols = np.empty((n_tuples, dim_even), dtype=np.int32)
    signs = np.empty((n_tuples, dim_even), dtype=np.complex128)

    for t, (a, b, c, d) in enumerate(combinations(range(N), 4)):
        # Restrict input vector to even sector, multiply, then read off
        # which even-sector column each row maps to.
        op = chis[a] @ chis[b] @ chis[c] @ chis[d]
        op = op.tocsr()
        # For each row i in even sector, find the single nonzero column j
        # and verify j is also in the even sector (parity is preserved by
        # any 4-Majorana product, since each chi flips parity).
        sub = op[even_idx, :]
        sub = sub.tocoo()
        order = np.argsort(sub.row)
        rows_sorted = sub.row[order]
        cols_full = sub.col[order]
        data_sorted = sub.data[order]
        # One nonzero per row.
        if not np.array_equal(rows_sorted, np.arange(dim_even)):
            raise RuntimeError(
                f"tuple {(a,b,c,d)} did not give one nonzero per row "
                f"in the even sector; check Majorana construction"
            )
        cols_even = inv[cols_full]
        if (cols_even < 0).any():
            raise RuntimeError(
                f"tuple {(a,b,c,d)} maps an even-parity state out of the "
                "even sector; this should be impossible for a 4-Majorana product"
            )
        cols[t] = cols_even
        signs[t] = data_sorted

    return cols, signs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--N", type=int, default=22, help="Number of Majoranas (even)")
    ap.add_argument("--samples", type=int, default=80, help="Disorder realizations")
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--J", type=float, default=1.0, help="SYK coupling (units)")
    ap.add_argument("--out", type=str, default="spectra.npz")
    args = ap.parse_args()

    N = args.N
    M = N // 2
    dim = 1 << M
    sigma = np.sqrt(6.0 * args.J ** 2 / N ** 3)

    print(f"SYK_4 ensemble: N={N}, M={M}, dim_full={dim}, sigma_J={sigma:.5f}")
    print(f"            samples={args.samples}, seed={args.seed}")

    print("Building Majorana operators...", flush=True)
    t0 = time.time()
    chis = build_majoranas(N)
    print(f"  {len(chis)} chi_a built in {time.time() - t0:.1f}s")

    even_idx = parity_even_indices(N)
    dim_even = even_idx.size
    print(f"Even-parity sector: dim={dim_even}")

    print("Precomputing quartic products on the even sector...", flush=True)
    t0 = time.time()
    cols, signs = precompute_quartic_perms(chis, even_idx)
    n_tuples = cols.shape[0]
    mem_mb = (cols.nbytes + signs.nbytes) / 1e6
    print(f"  {n_tuples} tuples, {mem_mb:.0f} MB, {time.time() - t0:.1f}s")

    rng = np.random.default_rng(args.seed)
    rows = np.arange(dim_even, dtype=np.int64)
    spectra = np.empty((args.samples, dim_even), dtype=np.float64)

    print("Diagonalizing the disorder ensemble...", flush=True)
    t0 = time.time()
    last_progress = t0
    for s in range(args.samples):
        coeffs = rng.normal(0.0, sigma, size=n_tuples)
        H = np.zeros((dim_even, dim_even), dtype=np.complex128)
        for t in range(n_tuples):
            np.add.at(H, (rows, cols[t]), coeffs[t] * signs[t])
        # Numerical Hermitization (the construction is exactly Hermitian
        # in exact arithmetic; this guards against rounding asymmetry).
        H = 0.5 * (H + H.conj().T)
        spectra[s] = np.linalg.eigvalsh(H)
        now = time.time()
        if (s + 1) == 1 or (s + 1) % max(1, args.samples // 10) == 0 or now - last_progress > 30:
            avg = (now - t0) / (s + 1)
            eta = avg * (args.samples - s - 1)
            print(
                f"  sample {s+1:>3d}/{args.samples}  "
                f"{avg:.2f}s/sample  eta {eta:>5.0f}s",
                flush=True,
            )
            last_progress = now

    out_path = HERE / args.out
    np.savez_compressed(
        out_path,
        spectra=spectra,
        N=N,
        J=args.J,
        sigma=sigma,
        samples=args.samples,
        seed=args.seed,
        dim_even=dim_even,
    )
    print(f"\nSaved {out_path} ({spectra.nbytes/1e6:.1f} MB)")
    print("Spectrum summary (mean over ensemble):")
    print(f"  E_min = {spectra.min(axis=1).mean():+.4f}  E_max = {spectra.max(axis=1).mean():+.4f}")
    print(f"  bandwidth W ~ {(spectra.max(axis=1) - spectra.min(axis=1)).mean():.4f} J")


if __name__ == "__main__":
    main()
