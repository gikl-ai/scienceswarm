# ScienceSwarm MD pipeline walkthrough

This walkthrough shows a new ScienceSwarm user how to drive the
[lysozyme MD quickstart](md-quickstart/README.md) from the UI. You should not
need to open a terminal or type shell commands. The expected final state is:

- study-scoped MD planning assets saved in gbrain,
- a Claude Code-ready execution handoff,
- a completed lysozyme OpenMM run,
- `analysis/metrics.json`, production logs, trajectories, and plots,
- a final interpretation and refinement decision.

The example is a tutorial scaffold, not a new biological result.

---

## 0. Create the study and choose Claude Code

1. Start ScienceSwarm and complete setup if the app asks.
2. Open the dashboard and create a study. A name like `Lysozyme MD quickstart`
   is fine.
3. Open the study. You should see the study chat composer at the bottom of
   the page.
4. Import this checkout, or the `docs/tutorials/md-quickstart/` folder, into
   the project. The important imported files are `environment.yml` and the
   `scripts/` folder.
5. If the import says `README.md` or `environment.yml` were saved without typed
   conversion, continue. They are still available to the assistant as project
   notes/files.
6. In the study chat composer, open the assistant selector and choose
   `Claude Code`.
7. If ScienceSwarm shows a send-review sheet for Claude Code, confirm the
   destination is `Claude Code`, the study is the lysozyme project, and the
   included data is the prompt plus study context. Then click the send button
   in that sheet.

Use Claude Code for every step below. Do not switch to OpenHands for this
walkthrough.

---

## How to run each skill

For each planning step:

1. Stay on the study page.
2. Confirm the assistant selector says `Claude Code`.
3. Click the message box.
4. Paste the text block for the step.
5. Click `Send`.
6. Wait until the `Stop` button disappears and the assistant reports a saved
   gbrain slug before starting the next step.

The MD slash commands used here are:

| Step | Command | Asset |
|---|---|---|
| 1 | `/md-study` | `md_study_brief` |
| 2 | `/md-evidence` | `md_evidence_grounding_packet` |
| 3 | `/md-system` | `md_system_definition` |
| 4 | `/md-parameters` | `md_parameter_decision_ledger` |
| 5 | `/md-review` | `md_protocol_review_note` |
| 6 | `/md-handoff` | `md_execution_handoff_plan` |
| 8 | `/md-results` | `md_results_interpretation_note` |
| 9 | `/md-refine` | `md_refinement_decision_update` |

---

## 1. Create the MD Study Brief

Paste this into the study chat:

```text
/md-study Create an MD Study Brief for the lysozyme quickstart.

Scientific goal: prove that ScienceSwarm can plan and run a small
explicit-solvent MD example end to end on commodity hardware.

System: hen egg-white lysozyme, PDB 1AKI, apo protein in water.

Question: does the protein remain folded and stable during a short
1 ns x 3 seed equilibrium MD tutorial run?

Desired claim: this is a validated tutorial scaffold, not a new
biological result. Map the claim to C-alpha RMSD, C-alpha RMSF, and
radius of gyration. Save the result as a durable study-scoped MD Study
Brief with gbrain_capture before answering.
```

Continue only after the assistant says it saved an `MD Study Brief`. Check that
the output includes `md-fit` or `md-with-caveats`, the C-alpha RMSD/RMSF/Rg
observables, stop criteria, and a confidence boundary.

---

## 2. Ground the evidence

Paste:

```text
/md-evidence Build the MD Evidence Grounding Packet for the lysozyme
quickstart. Use the latest study-scoped MD Study Brief from this study.

Search the study paper library first. If this study has no relevant papers
yet, use external evidence for PDB 1AKI, AMBER ff14SB / TIP3P solution MD
behavior, OpenMM, and the published C-alpha RMSD reference band used by the
tutorial. Label each evidence item as project-literature, external-literature,
common-heuristic, tool-default, or speculative. Save a durable study-scoped
MD Evidence Grounding Packet with gbrain_capture before answering.
```

Check for PDB 1AKI, AMBER ff14SB/TIP3P, OpenMM, the 0.6-2.0 Angstrom C-alpha
RMSD reference band, and explicit evidence gaps.

---

## 3. Define the molecular system

Paste:

```text
/md-system Define the exact molecular system for the lysozyme quickstart using
the MD Study Brief and Evidence Grounding Packet from this study.

Use PDB 1AKI chain A, residues 1-129, apo lysozyme, pH 7.0, AMBER ff14SB,
TIP3P water, a 10 Angstrom padded box, neutralization plus 0.15 M NaCl, 300 K,
and 1 atm. Include identity locks, preparation risks, and blocking
uncertainties. Do not add ligands, membranes, mutations, or enhanced sampling.
Save a durable study-scoped Molecular System Definition with gbrain_capture
before answering.
```

Check for identity locks: 1AKI, chain A, residues 1-129, apo protein, no ligand,
no membrane, no mutation, ff14SB/TIP3P, neutralized 0.15 M NaCl solution.

---

## 4. Choose parameters

Paste:

```text
/md-parameters Create the Parameter Decision Ledger for the lysozyme
quickstart. Use the previous MD assets in this study and keep the protocol
aligned with docs/tutorials/md-quickstart.

Record force field, water model, ions, box, timestep, constraints, thermostat,
barostat, equilibration, production length, seeds, analysis metrics, and
validation thresholds. Label standard defaults separately from tutorial-only
choices. Mark 1 ns x 3 seeds as acceptable for a tutorial scaffold but not a
default for biological claims. Save a durable study-scoped Parameter Decision
Ledger with gbrain_capture before answering.
```

Expected values include AMBER ff14SB, TIP3P, 0.15 M NaCl, 10 Angstrom padding,
2 fs timestep with constrained bonds to hydrogen, 1 ns production for seeds 11,
22, and 33, and RMSD/seed-spread validation gates.

---

## 5. Review the protocol before execution

Paste:

```text
/md-review Review the lysozyme MD protocol before execution. Use the MD Study
Brief, Evidence Grounding Packet, Molecular System Definition, and Parameter
Decision Ledger from this study.

Return approved-to-run, approved-with-caveats, or blocked. If approved, list
the exact caveats, validation gates, and overclaim risks the execution agent
must preserve. If blocked, list the required fixes instead of producing
runnable instructions. Save a durable study-scoped Protocol Review Note with
gbrain_capture before answering.
```

For this tutorial the expected verdict is `approved-with-caveats`. Stop if the
verdict is `blocked`.

---

## 6. Create the execution handoff

Paste:

```text
/md-handoff Create a Claude Code-ready MD Execution Handoff Plan for the
lysozyme quickstart.

Use the approved protocol assets from this study. The implementation files
already live under docs/tutorials/md-quickstart. The execution assistant may
create or reuse the scienceswarm-md-quickstart environment from
environment.yml, fetch PDB 1AKI, run the tutorial stages in order, collect logs
and artifacts, and stop on failed validation gates.

The execution assistant must not change the scientific protocol, substitute
force fields, change the protein system, skip seeds, or treat successful
completion as a biological discovery. Include a copyable task prompt for
Claude Code. Save a durable study-scoped MD Execution Handoff Plan with
gbrain_capture before answering.
```

Check that the handoff includes environment checks, fetch, preparation,
solvation, equilibration, production for seeds 11/22/33, analysis, validation
gates, artifacts, and run provenance.

---

## 7. Run the lysozyme example

Keep the assistant selector on `Claude Code`. Paste:

```text
Run the lysozyme MD quickstart end to end using this ScienceSwarm project
workspace.

Use the approved MD Execution Handoff Plan from this study and the imported
tutorial files under the study workspace. The scripts live in scripts/ and
the environment file is environment.yml. First check whether python3 can
already import OpenMM, PDBFixer, MDTraj, NumPy, and Matplotlib. If that works,
reuse that environment and report the versions. If it does not work and
ScienceSwarm is allowed to install tools, create or reuse a managed
scienceswarm-md-quickstart conda/mamba environment under
$SCIENCESWARM_DIR/runtimes/conda/envs/.

Use CUDA or OpenCL if OpenMM can see it; otherwise fall back to CPU and report
the fallback. Fetch PDB 1AKI into the scripts folder. Run stages 01 through 05
in order. Run production for seeds 11, 22, and 33 at 1.0 ns each. Stop
immediately if any validation gate fails.

Keep generated files inside the study scripts folder. When finished,
summarize analysis/metrics.json, list generated plots/logs/trajectories, say
which OpenMM platform was used, and save a durable study-scoped Simulation
Run Log with gbrain_capture before answering.
```

If ScienceSwarm needs to install a package manager or persistent scientific
software, it should ask before installing. The platform convention is
`$SCIENCESWARM_DIR/runtimes/` for package managers and
`$SCIENCESWARM_DIR/runtimes/conda/envs/` for named conda/mamba environments.

The expected run outputs are:

| Artifact | Meaning |
|---|---|
| `scripts/1AKI.pdb` | downloaded input structure |
| `scripts/prepared.pdb` | cleaned lysozyme with hydrogens |
| `scripts/solvated.pdb`, `scripts/system.xml` | solvated OpenMM system |
| `scripts/equilibrated.pdb`, `scripts/equilibrated.xml` | equilibrated state |
| `scripts/prod_seed11.dcd`, `scripts/prod_seed22.dcd`, `scripts/prod_seed33.dcd` | production trajectories |
| `scripts/prod_seed*.log`, `scripts/eq_*.log` | diagnostics |
| `scripts/analysis/metrics.json` | validation metrics |
| `scripts/analysis/rmsd_ca.png`, `scripts/analysis/rmsf_ca.png`, `scripts/analysis/rg.png` | plots |

---

## 8. Interpret the results

After Claude Code reports that the run finished, paste:

```text
/md-results Interpret the completed lysozyme MD quickstart.

Use the generated scripts/analysis/metrics.json, production logs, and analysis
plots. Classify each candidate claim as supported, suggestive, weak, or
unsupported. Separate "the run completed" from scientific support. Report
whether the C-alpha RMSD plateau lands in the 0.6-2.0 Angstrom reference band
and whether the seed plateau spread is below 0.4 Angstrom. Save a durable
study-scoped Results Interpretation Note with gbrain_capture before
answering.
```

Expected interpretation: the pipeline completion is supported if all stages
completed; lysozyme short-run stability is supported or suggestive if gates
passed; any broader biological conclusion is unsupported.

---

## 9. Decide what to do next

Paste:

```text
/md-refine Create the MD Refinement Decision Update for the lysozyme quickstart
using the planning assets, execution handoff, and results interpretation.

Choose one of: stop, rerun-same-protocol, extend-run, adjust-parameters,
change-system-definition, switch-method, seek-expert-review, or
seek-experimental-validation. For this tutorial, explain whether the right next
step is to stop, extend the run, or define a new system such as a ligand-bound
lysozyme example. Save a durable study-scoped Refinement Decision Update with
gbrain_capture before answering.
```

For a successful tutorial run, `stop` is the likely decision for the scaffold.
`change-system-definition` is the natural next learning path if you want to add
a ligand or a new target.

---

## Done checklist

You are done when gbrain contains:

- MD Study Brief
- MD Evidence Grounding Packet
- Molecular System Definition
- Parameter Decision Ledger
- Protocol Review Note
- MD Execution Handoff Plan
- Simulation Run Log
- Results Interpretation Note
- Refinement Decision Update

And the study workspace contains:

- `scripts/analysis/metrics.json`
- three production trajectories
- production and equilibration logs
- `scripts/analysis/rmsd_ca.png`
- `scripts/analysis/rmsf_ca.png`
- `scripts/analysis/rg.png`

The final answer you want from ScienceSwarm is a traceable chain from study
question, to protocol decisions, to execution artifacts, to validation metrics,
to an explicit stop or refinement decision.

---

## Further reading

- [`docs/tutorials/md-quickstart/README.md`](md-quickstart/README.md) - the
  runnable lysozyme example.
- `skills/scienceswarm-md-*/hosts/claude-code/SKILL.md` - the Claude Code skill
  instructions used by the slash commands.
- Maier et al. 2015 (PMID 26574453) - AMBER ff14SB.
- Eastman et al. 2017 (PMID 28746537) - OpenMM.
