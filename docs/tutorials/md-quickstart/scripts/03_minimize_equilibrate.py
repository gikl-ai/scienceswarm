"""Stage 3 — minimize, then 50 ps NVT + 50 ps NPT (restrained) + 50 ps NPT (free).

Reads `system.xml` + `solvated.pdb`. Writes `equilibrated.pdb` and
`equilibrated.xml`. Three small log files (`eq_nvt.log`, `eq_npt_restrained.log`,
`eq_npt_free.log`) capture per-step diagnostics.

Run:
    python 03_minimize_equilibrate.py
"""
import os
import time
from pathlib import Path

from openmm import (
    CustomExternalForce,
    LangevinMiddleIntegrator,
    MonteCarloBarostat,
    Platform,
    XmlSerializer,
)
from openmm.app import PDBFile, Simulation, StateDataReporter
from openmm.unit import (
    angstrom,
    bar,
    femtosecond,
    kelvin,
    kilojoule_per_mole,
    picosecond,
)

HERE = Path(__file__).resolve().parent
SYSTEM_XML = HERE / "system.xml"
SOLVATED = HERE / "solvated.pdb"
EQ_PDB = HERE / "equilibrated.pdb"
EQ_XML = HERE / "equilibrated.xml"

PROTEIN_RESNAMES = {
    "ALA","ARG","ASN","ASP","CYS","GLN","GLU","GLY","HIS","ILE","LEU","LYS",
    "MET","PHE","PRO","SER","THR","TRP","TYR","VAL",
}

EQ_NVT_STEPS = 25_000        # 50 ps
EQ_NPT_R_STEPS = 25_000      # 50 ps with restraints
EQ_NPT_F_STEPS = 25_000      # 50 ps free
SEED = 1


def add_protein_restraint(system, pdb: PDBFile, k_kj_per_A2: float = 5.0):
    restraint = CustomExternalForce("k*((x-x0)^2+(y-y0)^2+(z-z0)^2)")
    restraint.addGlobalParameter("k", k_kj_per_A2 * kilojoule_per_mole / angstrom**2)
    restraint.addPerParticleParameter("x0")
    restraint.addPerParticleParameter("y0")
    restraint.addPerParticleParameter("z0")
    for atom in pdb.topology.atoms():
        if (
            atom.residue.name in PROTEIN_RESNAMES
            and atom.element is not None
            and atom.element.symbol != "H"
        ):
            pos = pdb.positions[atom.index]
            restraint.addParticle(atom.index, [pos.x, pos.y, pos.z])
    system.addForce(restraint)


def main() -> None:
    if not SYSTEM_XML.exists() or not SOLVATED.exists():
        raise SystemExit("run 02_solvate.py first")

    with open(SYSTEM_XML) as fh:
        system = XmlSerializer.deserialize(fh.read())
    pdb = PDBFile(str(SOLVATED))
    add_protein_restraint(system, pdb)

    integrator = LangevinMiddleIntegrator(
        300 * kelvin, 1.0 / picosecond, 2 * femtosecond
    )
    integrator.setRandomNumberSeed(SEED)
    platform_name = os.environ.get("OPENMM_PLATFORM", "CPU")
    platform = Platform.getPlatformByName(platform_name)
    sim = Simulation(pdb.topology, system, integrator, platform)
    sim.context.setPositions(pdb.positions)
    print(f"platform: {platform_name}")

    print("minimizing ...")
    t0 = time.time()
    sim.minimizeEnergy(maxIterations=2000)
    print(f"  ok ({time.time() - t0:.1f} s)")

    print(f"NVT 50 ps with protein heavy-atom restraints ...")
    sim.context.setVelocitiesToTemperature(300 * kelvin, SEED)
    sim.reporters.append(StateDataReporter(
        str(HERE / "eq_nvt.log"), 500,
        step=True, temperature=True, density=True, volume=True,
    ))
    t0 = time.time(); sim.step(EQ_NVT_STEPS); print(f"  ok ({time.time() - t0:.1f} s)")

    print("NPT 50 ps with restraints ...")
    system.addForce(MonteCarloBarostat(1 * bar, 300 * kelvin, 25))
    sim.context.reinitialize(preserveState=True)
    sim.reporters.clear()
    sim.reporters.append(StateDataReporter(
        str(HERE / "eq_npt_restrained.log"), 500,
        step=True, temperature=True, density=True, volume=True,
    ))
    t0 = time.time(); sim.step(EQ_NPT_R_STEPS); print(f"  ok ({time.time() - t0:.1f} s)")

    sim.context.setParameter("k", 0.0)
    print("NPT 50 ps free ...")
    sim.reporters.clear()
    sim.reporters.append(StateDataReporter(
        str(HERE / "eq_npt_free.log"), 500,
        step=True, temperature=True, density=True, volume=True,
    ))
    t0 = time.time(); sim.step(EQ_NPT_F_STEPS); print(f"  ok ({time.time() - t0:.1f} s)")

    state = sim.context.getState(
        getPositions=True, getVelocities=True, enforcePeriodicBox=True,
    )
    with open(EQ_XML, "w") as fh:
        fh.write(XmlSerializer.serialize(state))
    with open(EQ_PDB, "w") as fh:
        PDBFile.writeFile(pdb.topology, state.getPositions(), fh)
    print(f"wrote {EQ_PDB.name} and {EQ_XML.name}")

    # Validation gate: end-of-NPT density must be physical for TIP3P at
    # 300 K, 1 atm. Densities far outside this band typically indicate
    # a barostat problem or an undersized box.
    #
    # StateDataReporter writes a quoted CSV with a leading "#"-prefixed
    # header. Parse the header to locate the density column by name
    # rather than relying on a fixed index, so this gate stays correct
    # if the reporter's column set is reordered later.
    densities = []
    density_idx: int | None = None
    with open(HERE / "eq_npt_free.log") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                header_cells = [c.strip().strip('"') for c in line.lstrip("#").split(",")]
                for i, cell in enumerate(header_cells):
                    if cell.lower().startswith("density"):
                        density_idx = i
                        break
                continue
            if density_idx is None:
                continue
            parts = line.split(",")
            if len(parts) > density_idx:
                try:
                    densities.append(float(parts[density_idx]))
                except ValueError:
                    continue
    if densities:
        last_window = densities[-min(20, len(densities)):]
        mean_density = sum(last_window) / len(last_window)
        print(f"end-of-NPT density (last {len(last_window)} samples): {mean_density:.4f} g/mL")
        assert 0.95 <= mean_density <= 1.05, (
            f"density {mean_density:.4f} g/mL is outside the 0.95–1.05 band; "
            "check thermostat/barostat coupling and box size"
        )
    else:
        print("warning: could not parse density column from eq_npt_free.log; skipping density gate")


if __name__ == "__main__":
    main()
