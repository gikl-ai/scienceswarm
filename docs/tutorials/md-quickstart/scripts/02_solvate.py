"""Stage 2 — solvate in a 10 Å TIP3P box at 0.15 M NaCl, build the OpenMM system.

Reads `prepared.pdb`, writes `solvated.pdb` and `system.xml`.

Run:
    python 02_solvate.py
"""
from pathlib import Path

from openmm import NonbondedForce, XmlSerializer
from openmm.app import ForceField, HBonds, Modeller, PDBFile, PME
from openmm.unit import elementary_charge, molar, nanometer

HERE = Path(__file__).resolve().parent
INPUT = HERE / "prepared.pdb"
OUT_PDB = HERE / "solvated.pdb"
OUT_XML = HERE / "system.xml"


def main() -> None:
    if not INPUT.exists():
        raise SystemExit(f"missing {INPUT}; run 01_prepare.py first")

    pdb = PDBFile(str(INPUT))
    ff = ForceField("amber14-all.xml", "amber14/tip3p.xml")
    modeller = Modeller(pdb.topology, pdb.positions)
    modeller.addSolvent(
        ff,
        model="tip3p",
        padding=1.0 * nanometer,
        ionicStrength=0.15 * molar,
        neutralize=True,
    )

    system = ff.createSystem(
        modeller.topology,
        nonbondedMethod=PME,
        nonbondedCutoff=1.0 * nanometer,
        constraints=HBonds,
        rigidWater=True,
        removeCMMotion=True,
    )

    total_charge = 0.0
    for force in system.getForces():
        if isinstance(force, NonbondedForce):
            for i in range(force.getNumParticles()):
                q, _, _ = force.getParticleParameters(i)
                total_charge += q.value_in_unit(elementary_charge)

    n_atoms = modeller.topology.getNumAtoms()
    print(f"solvated atoms:   {n_atoms}")
    print(f"net charge:       {total_charge:+.4f} e (must be ~0)")

    # Validation gate.
    assert abs(total_charge) < 0.01, f"system not neutral: {total_charge}"
    assert 15_000 <= n_atoms <= 60_000, (
        f"unexpected solvated atom count {n_atoms}; check padding / box"
    )

    with open(OUT_PDB, "w") as fh:
        PDBFile.writeFile(modeller.topology, modeller.positions, fh)
    with open(OUT_XML, "w") as fh:
        fh.write(XmlSerializer.serialize(system))
    print(f"wrote {OUT_PDB.name} and {OUT_XML.name}")


if __name__ == "__main__":
    main()
