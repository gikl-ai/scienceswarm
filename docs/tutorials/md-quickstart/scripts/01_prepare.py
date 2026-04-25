"""Stage 1 — clean the input PDB and add hydrogens at pH 7.

Reads `1AKI.pdb`, drops crystal waters and any non-standard residues,
fills missing heavy atoms, and writes `prepared.pdb`.

Run:
    python 01_prepare.py
"""
from pathlib import Path

from pdbfixer import PDBFixer
from openmm.app import ForceField, Modeller, PDBFile

PROTEIN_RESNAMES = {
    "ALA","ARG","ASN","ASP","CYS","GLN","GLU","GLY","HIS","ILE","LEU","LYS",
    "MET","PHE","PRO","SER","THR","TRP","TYR","VAL",
}

HERE = Path(__file__).resolve().parent
INPUT = HERE / "1AKI.pdb"
OUTPUT = HERE / "prepared.pdb"


def main() -> None:
    if not INPUT.exists():
        raise SystemExit(
            f"missing {INPUT}. Download with:\n"
            f"  curl -o {INPUT} https://files.rcsb.org/download/1AKI.pdb"
        )

    fixer = PDBFixer(filename=str(INPUT))
    fixer.findMissingResidues()
    fixer.findNonstandardResidues()
    fixer.replaceNonstandardResidues()
    fixer.removeHeterogens(keepWater=False)
    fixer.findMissingAtoms()
    fixer.addMissingAtoms()

    modeller = Modeller(fixer.topology, fixer.positions)
    ff = ForceField("amber14-all.xml", "amber14/tip3p.xml")
    modeller.addHydrogens(ff, pH=7.0)

    n_protein = sum(
        1 for r in modeller.topology.residues() if r.name in PROTEIN_RESNAMES
    )
    n_atoms = modeller.topology.getNumAtoms()
    print(f"protein residues: {n_protein}")
    print(f"total atoms:      {n_atoms}")

    # Validation gate: lysozyme 1AKI is 129 residues. If you swap in a
    # different PDB, change this assertion.
    assert n_protein == 129, (
        f"expected 129 protein residues for 1AKI, got {n_protein}"
    )

    with open(OUTPUT, "w") as fh:
        PDBFile.writeFile(modeller.topology, modeller.positions, fh)
    print(f"wrote {OUTPUT.name}")


if __name__ == "__main__":
    main()
