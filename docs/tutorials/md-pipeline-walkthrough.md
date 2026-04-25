# ScienceSwarm MD pipeline walkthrough

This walkthrough shows how to drive ScienceSwarm's eight molecular-dynamics
planning skills end-to-end on a small, runnable system. The skills produce
durable brain assets that capture the scientific judgment behind each
decision; this walkthrough pairs each skill with the artifact it should
produce, using the
[lysozyme MD quickstart](md-quickstart/README.md) as the concrete example.

The skills in execution order:

| # | Skill | Asset kind | Purpose |
|---|---|---|---|
| 1 | `scienceswarm-md-study-design` | `md_study_brief` | Decide whether MD is the right method, and for which scoped question. |
| 2 | `scienceswarm-md-evidence-grounding` | `md_evidence_grounding_packet` | Ground choices in project literature first, then external. |
| 3 | `scienceswarm-md-system-definition` | `md_system_definition` | Define exactly what gets simulated. |
| 4 | `scienceswarm-md-parameter-planning` | `md_parameter_decision_ledger` | Record force field, water, ions, integration choices with rationale. |
| 5 | `scienceswarm-md-protocol-review` | `md_protocol_review_note` | Pre-run quality gate. |
| 6 | `scienceswarm-md-execution-handoff` | `md_execution_handoff_plan` | Turn approved plans into a coding-agent contract. |
| 7 | `scienceswarm-md-results-interpretation` | `md_results_interpretation_note` | Separate run completion from scientific support. |
| 8 | `scienceswarm-md-refinement-planning` | `md_refinement_decision_update` | Decide what to do next: stop, rerun, extend, switch method. |

Each skill is documented in `skills/scienceswarm-md-*/hosts/<host>/SKILL.md`
and is invocable from OpenClaw, Claude Code, or Codex.

---

## Why a pipeline, not a single skill

Equilibrium MD is decision-dense. A single agent prompt that says "run
MD on protein X" gives you a run, not an answer — because the choices
that determine whether the run is interpretable (force field, water
model, ion strength, sampling adequacy, validation signals) are not in
the prompt and not in the trajectory. The pipeline asks for those
decisions explicitly, before any compute is spent.

Each skill produces a markdown asset with a `Confidence Boundary`
section: what the asset supports, what it does not support, and what
would change the recommendation. That section is the single most useful
part of every asset. It survives the run and tells future readers what
the run is actually evidence for.

---

## Walking the lysozyme example

### 1 — `scienceswarm-md-study-design`

Decide whether MD is appropriate. For lysozyme apo dynamics, the
verdict is `md-fit` because the question — "does the protein remain
folded and stable on a 1-ns timescale" — maps cleanly to Cα-RMSD,
RMSF, and Rg observables, and there is no enhanced-sampling or
free-energy claim being made.

Asset shape (excerpt):

```markdown
## MD Suitability Verdict

`md-fit`

## Claim-To-Observable Map

| Desired claim | MD observable | Decision threshold |
|---|---|---|
| Lysozyme is stable in TIP3P at 300 K | Cα-RMSD plateau | 0.6–2.0 Å |
| No global unfolding | Rg deviation | < 5% |
```

### 2 — `scienceswarm-md-evidence-grounding`

For lysozyme this is short: PDB 1AKI is the canonical 1.5-Å monomer
crystal structure, and the AMBER ff14SB / TIP3P solution-MD literature
sets the reference plateau band at 0.6–2.5 Å (Maier et al. 2015,
biobb_wf_amber tutorial). Label these citations as
`external-literature`.

For a real cancer target, this is where you would search the project
paper library first.

### 3 — `scienceswarm-md-system-definition`

Pin down exactly what gets simulated. For lysozyme:

- protein: 1AKI chain A, residues 1–129
- waters: stripped, re-added by `addSolvent`
- box: cubic, 10 Å padding
- water model: TIP3P
- ions: Na⁺/Cl⁻ to 0.15 M, neutralize
- pH: 7.0
- temperature, pressure: 300 K, 1 atm

Identity locks: 129 protein residues, neutral net charge after
solvation. These match the validation gates in
[`01_prepare.py`](md-quickstart/scripts/01_prepare.py) and
[`02_solvate.py`](md-quickstart/scripts/02_solvate.py).

### 4 — `scienceswarm-md-parameter-planning`

The `Parameter Decision Ledger` records every choice with a label
(`standard-default`, `expert-sensitive`, or `do-not-default`), a
plain-English explanation, and an expert caveat. For lysozyme nearly
every choice is `standard-default`:

| Choice | Value | Label |
|---|---|---|
| Force field | AMBER ff14SB | standard-default |
| Water | TIP3P | standard-default |
| Timestep | 2 fs with HBonds constrained | standard-default |
| Thermostat | LangevinMiddle, 300 K, γ=1 ps⁻¹ | standard-default |
| Barostat | Monte Carlo, 1 atm, 25-step | standard-default |
| Production length | 1 ns × 3 seeds | **do-not-default** for biology; standard for tutorial |

The `do-not-default` label on the duration is what stops you (or an
agent) from quietly extrapolating the tutorial to a real binding-pose
study without renegotiating the runtime budget.

### 5 — `scienceswarm-md-protocol-review`

This is the pre-run gate. It re-reads the previous four assets and
returns `approved-to-run`, `approved-with-caveats`, or `blocked`. For
the lysozyme tutorial the verdict is `approved-with-caveats`: the
protocol is sound but the conclusions it can support are scoped to
"the pipeline runs and the protein stays folded", not to any
biological claim.

### 6 — `scienceswarm-md-execution-handoff`

The handoff turns the approved plan into a runnable contract. For
lysozyme that contract is exactly the five scripts under
[`md-quickstart/scripts/`](md-quickstart/scripts/), with stage gates:

| Stage | Pass condition |
|---|---|
| `01_prepare.py` | 129 protein residues, no HET groups |
| `02_solvate.py` | net charge < 0.01 e |
| `03_minimize_equilibrate.py` | end-of-NPT density 0.95–1.05 g/mL |
| `04_produce.py` (per seed) | run completes target ns without NaN |
| `05_analyze.py` | per-seed Cα-RMSD plateau in 0.6–2.0 Å, seed std < 0.4 Å |

The handoff also requires a run-provenance manifest that captures
versions, command lines, seeds, and platform. The tutorial's
`metrics.json` is a minimal version of that manifest.

### 7 — `scienceswarm-md-results-interpretation`

After the run, audit each candidate claim against the trajectory.
Lysozyme outcomes you might see:

| Candidate claim | Class |
|---|---|
| "The pipeline runs end-to-end on commodity hardware" | `supported` |
| "Lysozyme apo backbone is stable on 1-ns timescale" | `supported` |
| "Three seeds give a converged plateau" | `suggestive` (for 1 ns) / `supported` (for 5 ns) |
| "Cα-RMSF profile reproduces published flexibility hierarchy" | `suggestive` until compared point-by-point |

The skill explicitly forbids treating "the run completed" as biological
evidence. For a real cancer target, this is the section that prevents
overclaim.

### 8 — `scienceswarm-md-refinement-planning`

Decide the next step from a fixed list: `stop`, `rerun-same-protocol`,
`extend-run`, `adjust-parameters`, `change-system-definition`,
`switch-method`, `seek-expert-review`, or `seek-experimental-validation`.
For the lysozyme tutorial, the natural follow-up is
`change-system-definition` (add a small-molecule ligand and
parameterize via GAFF + AM1-BCC) — but that is a separate study, not a
rerun.

---

## How to invoke the skills

In Claude Code with the scienceswarm plugin installed:

```text
/scienceswarm-md-study-design
```

Each skill is a guided workflow that produces the relevant asset. The
skills are designed to be invoked in order; later skills read the
artifacts produced by earlier ones.

In OpenClaw, the short aliases are `md-study`, `md-evidence`,
`md-system`, `md-parameters`, `md-review`, `md-handoff`, `md-results`,
`md-refine`.

---

## Where the assets live

When ScienceSwarm's gbrain backend is reachable, every asset is
captured to `gbrain` with frontmatter such as:

```yaml
type: method
asset_kind: md_study_brief
status: draft
privacy: local-only
tags: [molecular-dynamics, md-pipeline]
```

When gbrain is unavailable, the assets are written to disk under the
project workspace and reconciled later. The skills are designed so the
artifact survives whether the brain backend is up or not.

---

## What this walkthrough does not cover

- **Small-molecule and covalent ligand parameterization.** The skills
  cover the decision and provenance side; ligand parameterization
  itself requires GAFF + AM1-BCC (via `openmmforcefields`) or CGenFF.
- **Cluster / multi-node MD.** OpenMM's MPI / multi-replica strategies
  are out of scope here.
- **Trajectory storage strategy.** Long-running MD generates many
  gigabytes; pick a storage tier appropriate to your institution before
  scaling production.

---

## Further reading

- [`docs/tutorials/md-quickstart/README.md`](md-quickstart/README.md) —
  the runnable example.
- `skills/scienceswarm-md-*/hosts/<host>/SKILL.md` — full skill text.
- Maier et al. 2015 (PMID 26574453) — AMBER ff14SB.
- Eastman et al. 2017 (PMID 28746537) — OpenMM.
