# ScienceSwarm MD pipeline walkthrough

This walkthrough is the UI runbook for driving ScienceSwarm's
molecular-dynamics planning skills on the
[lysozyme MD quickstart](md-quickstart/README.md). By the end, you should
have:

- eight durable MD planning assets in the project brain,
- an OpenHands-ready execution handoff,
- a completed lysozyme OpenMM run,
- `analysis/metrics.json`, production logs, and three analysis plots,
- a final interpretation and refinement decision.

The normal path is ScienceSwarm-first. You should not need to open a
terminal or type Linux commands to complete this walkthrough.

---

## Before you start

1. Start ScienceSwarm and complete `/setup` if the app asks for setup.
2. Open or create a project workspace.
3. Import this checkout, or just `docs/tutorials/md-quickstart/`, into the
   project so ScienceSwarm can see `environment.yml` and `scripts/`.
4. Confirm the project chat composer is visible. It has an `Assistant`
   selector, a message box, and a `Send` button.

Use two agents for this walkthrough:

| Phase | Agent | Where to select it | Why |
|---|---|---|---|
| Planning and interpretation | OpenClaw | Project chat composer `Assistant` selector | Runs the MD slash-command skills and saves the scientific assets. |
| Execution | OpenHands | Settings > Project AI destinations | Runs the approved handoff as a task-capable local execution destination. |

For planning, click the project chat `Assistant` selector and choose
`OpenClaw`. Keep the project policy `Local only` unless ScienceSwarm asks
for a different policy.

For execution, open Settings > Project AI destinations, select the same
project, then set:

| Control | Value |
|---|---|
| Project policy | `Execution ok` |
| Mode | `Task` |
| Destination | `OpenHands` |

Return to the project chat after changing those settings. The next task
send will show a `Review before sending` sheet. Click `Approve and send`
after checking that the destination is OpenHands and the included data is
the project prompt/files you expect.

---

## How to run a skill

All MD planning steps use the same pattern:

1. Make sure the project chat `Assistant` selector says `OpenClaw`.
2. Click the message box.
3. Type the slash command and request shown in the relevant step below.
4. Press `Send`.
5. Wait for the answer to finish before starting the next step.

When you type `/`, ScienceSwarm should show command suggestions. Use the
short MD aliases in this walkthrough:

| Step | Command | Asset produced |
|---|---|---|
| 1 | `/md-study` | `md_study_brief` |
| 2 | `/md-evidence` | `md_evidence_grounding_packet` |
| 3 | `/md-system` | `md_system_definition` |
| 4 | `/md-parameters` | `md_parameter_decision_ledger` |
| 5 | `/md-review` | `md_protocol_review_note` |
| 6 | `/md-handoff` | `md_execution_handoff_plan` |
| 7 | `/md-results` | `md_results_interpretation_note` |
| 8 | `/md-refine` | `md_refinement_decision_update` |

If a skill asks a clarifying question, answer it in the same chat thread,
then continue with the next step after the skill produces the asset.

---

## 1. Create the MD Study Brief

In project chat, with `Assistant` set to `OpenClaw`, send:

```text
/md-study Create an MD Study Brief for the lysozyme quickstart.

Scientific goal: prove that ScienceSwarm can plan and run a small
explicit-solvent MD example end to end on commodity hardware.

System: hen egg-white lysozyme, PDB 1AKI, apo protein in water.

Question: does the protein remain folded and stable during a short
1 ns x 3 seed equilibrium MD tutorial run?

Desired claim: this is a validated tutorial scaffold, not a new
biological result. Map the claim to C-alpha RMSD, C-alpha RMSF, and
radius of gyration. Save the result as a durable MD Study Brief.
```

Check that the output includes:

- `MD Suitability Verdict` = `md-fit` or `md-with-caveats`.
- a claim-to-observable map with C-alpha RMSD, RMSF, and Rg.
- stop criteria and a confidence boundary.
- a clear statement that this does not prove a new biological claim.

---

## 2. Ground the evidence

Send:

```text
/md-evidence Build the MD Evidence Grounding Packet for the lysozyme
quickstart. Use the MD Study Brief from the previous turn.

Search the project paper library first. If this project has no relevant
papers yet, use external evidence for PDB 1AKI, AMBER ff14SB / TIP3P
solution MD behavior, OpenMM, and the published C-alpha RMSD reference
band used by the tutorial. Label each evidence item as project-literature,
external-literature, common-heuristic, tool-default, or speculative.
```

Check that the output includes:

- PDB 1AKI as the starting structure.
- AMBER ff14SB / TIP3P as the reference force-field/water context.
- a 0.6-2.0 Angstrom C-alpha RMSD reference band for the tutorial gate.
- evidence gaps, if any, instead of invented certainty.

---

## 3. Define the molecular system

Send:

```text
/md-system Define the exact molecular system for the lysozyme
quickstart using the MD Study Brief and Evidence Grounding Packet.

Use PDB 1AKI chain A, residues 1-129, apo lysozyme, pH 7.0, AMBER
ff14SB, TIP3P water, a 10 Angstrom padded box, neutralization plus
0.15 M NaCl, 300 K, and 1 atm. Include identity locks, preparation
risks, and blocking uncertainties. Do not add ligands, membranes,
mutations, or enhanced sampling.
```

Check that the output includes:

- 129 protein residues as an identity lock.
- neutral net charge after solvation as an identity lock.
- explicit exclusions for ligands, membranes, and enhanced sampling.
- preparation risks such as missing residues, protonation, and ion setup.

---

## 4. Choose parameters

Send:

```text
/md-parameters Create the Parameter Decision Ledger for the lysozyme
quickstart. Use the previous MD assets and keep the protocol aligned
with docs/tutorials/md-quickstart.

Record force field, water model, ions, box, timestep, constraints,
thermostat, barostat, equilibration, production length, seeds, analysis
metrics, and validation thresholds. Label standard defaults separately
from tutorial-only choices. Mark 1 ns x 3 seeds as acceptable for a
tutorial scaffold but not a default for biological claims.
```

Check that the output includes:

| Choice | Expected value |
|---|---|
| Force field | AMBER ff14SB |
| Water | TIP3P |
| Salt | 0.15 M NaCl |
| Timestep | 2 fs with constrained bonds to hydrogen |
| Production | 1 ns each for seeds 11, 22, and 33 |
| Validation | RMSD band 0.6-2.0 Angstrom, seed plateau spread < 0.4 Angstrom |

---

## 5. Review the protocol before execution

Send:

```text
/md-review Review the lysozyme MD protocol before execution. Use the
MD Study Brief, Evidence Grounding Packet, Molecular System Definition,
and Parameter Decision Ledger from this project.

Return approved-to-run, approved-with-caveats, or blocked. If approved,
list the exact caveats, validation gates, and overclaim risks the
execution agent must preserve. If blocked, list the required fixes
instead of producing runnable instructions.
```

For this tutorial, the expected result is `approved-with-caveats`: the
run can demonstrate the scaffold and protein stability gate, but it
cannot support a novel biological or therapeutic claim.

Do not continue to execution if the result is `blocked`.

---

## 6. Create the execution handoff

Send:

```text
/md-handoff Create an OpenHands-ready MD Execution Handoff Plan for
the lysozyme quickstart.

Use the approved protocol assets. The implementation files already live
under docs/tutorials/md-quickstart. The execution agent may create or
reuse the scienceswarm-md-quickstart environment from environment.yml,
fetch PDB 1AKI, run the tutorial stages in order, collect logs and
artifacts, and stop on failed validation gates.

The execution agent must not change the scientific protocol, substitute
force fields, change the protein system, skip seeds, or treat successful
completion as a biological discovery. Include a copyable task prompt
for OpenHands.
```

Check that the handoff includes:

- environment check,
- system preparation,
- solvation,
- minimization and equilibration,
- production for seeds 11, 22, and 33,
- analysis,
- stage gates,
- expected artifacts,
- run provenance.

This is the last planning step before compute.

---

## 7. Run the lysozyme example

Switch the project to OpenHands task mode before sending the execution
request:

1. Open Settings > Project AI destinations.
2. Select the same project.
3. Set `Project policy` to `Execution ok`.
4. Set `Mode` to `Task`.
5. Set `Destination` to `OpenHands`.
6. Return to the project chat.

Now send this in the project chat message box:

```text
Run the lysozyme MD quickstart end to end using docs/tutorials/md-quickstart.

Use the approved MD Execution Handoff Plan from this project and the
bundled environment.yml. Create or reuse the scienceswarm-md-quickstart
environment. Fetch PDB 1AKI into the tutorial scripts folder. Run stages
01 through 05 in order. Run production for seeds 11, 22, and 33 at
1.0 ns each. Stop immediately if any validation gate fails.

Keep generated files inside the tutorial folder. When finished, summarize
analysis/metrics.json, list the generated plots and logs, and say which OpenMM
platform was used.
```

If you have CUDA available, add this sentence before sending:

```text
Use CUDA if OpenMM can see it; otherwise fall back to CPU and report the fallback.
```

ScienceSwarm will show a `Review before sending` sheet. Confirm:

- destination is OpenHands,
- mode is task,
- data included is the prompt and expected project context,
- project policy is `Execution ok`.

Then click `Approve and send`.

You can monitor the run in the project chat stream. Settings > Project AI
destinations also shows task sessions and session history.

The expected run artifacts are:

| Artifact | Meaning |
|---|---|
| `prepared.pdb` | cleaned lysozyme with hydrogens |
| `solvated.pdb` and `system.xml` | solvated, neutralized OpenMM system |
| `equilibrated.pdb` and `equilibrated.xml` | equilibrated starting point |
| `prod_seed11.dcd`, `prod_seed22.dcd`, `prod_seed33.dcd` | production trajectories |
| `prod_seed*.log` and `eq_*.log` | runtime diagnostics |
| `analysis/metrics.json` | validation metrics |
| `analysis/rmsd_ca.png`, `analysis/rmsf_ca.png`, `analysis/rg.png` | plots |

---

## 8. Interpret the results

After OpenHands finishes, switch back to OpenClaw:

1. In Settings > Project AI destinations, set `Mode` to `Chat`,
   `Destination` to `OpenClaw`, and `Project policy` to `Local only`.
2. Return to the project chat.
3. If the generated files appear in the workspace, type `@` in the
   composer and attach or mention `analysis/metrics.json`, the production logs,
   and the analysis plots.

Then send:

```text
/md-results Interpret the completed lysozyme MD quickstart.

Use the generated analysis/metrics.json, production logs, and analysis plots.
Classify each candidate claim as supported, suggestive, weak, or
unsupported. Separate "the run completed" from scientific support.
Report whether the C-alpha RMSD plateau lands in the 0.6-2.0 Angstrom
reference band and whether the seed plateau spread is below 0.4 Angstrom.
```

Expected interpretation:

| Candidate claim | Expected class |
|---|---|
| The pipeline ran end to end on commodity hardware | `supported` if all stages completed |
| Lysozyme apo backbone stayed stable on this short run | `supported` or `suggestive` if validation gates passed |
| Three 1 ns seeds are enough for a biological conclusion | `unsupported` |
| The scaffold is ready to adapt to a new target | `suggestive`, with caveats |

---

## 9. Decide what to do next

Send:

```text
/md-refine Create the MD Refinement Decision Update for the lysozyme
quickstart using the planning assets, execution handoff, and results
interpretation.

Choose one of: stop, rerun-same-protocol, extend-run, adjust-parameters,
change-system-definition, switch-method, seek-expert-review, or
seek-experimental-validation. For this tutorial, explain whether the
right next step is to stop, extend the run, or define a new system such
as a ligand-bound lysozyme example.
```

For a successful tutorial run, the likely decision is `stop` for the
lysozyme scaffold, with `change-system-definition` as the natural next
learning path if you want to add a ligand.

---

## Done checklist

You are done when the project has these planning assets:

- MD Study Brief
- MD Evidence Grounding Packet
- Molecular System Definition
- Parameter Decision Ledger
- Protocol Review Note
- Execution Handoff Plan
- Results Interpretation Note
- Refinement Decision Update

And these run outputs:

- `analysis/metrics.json`
- three production trajectories
- production and equilibration logs
- `analysis/rmsd_ca.png`
- `analysis/rmsf_ca.png`
- `analysis/rg.png`

The final answer you want from ScienceSwarm is not just "the job ran."
It is a traceable chain from study question, to protocol decisions, to
execution artifacts, to validation metrics, to an explicit stop or
refinement decision.

---

## What this walkthrough does not cover

- **Small-molecule and covalent ligand parameterization.** The skills
  cover the decision and provenance side; ligand parameterization itself
  requires GAFF + AM1-BCC via `openmmforcefields` or CGenFF.
- **Cluster / multi-node MD.** OpenMM's MPI / multi-replica strategies
  are out of scope here.
- **Trajectory storage strategy.** Long-running MD generates many
  gigabytes; pick a storage tier appropriate to your institution before
  scaling production.

---

## Further reading

- [`docs/tutorials/md-quickstart/README.md`](md-quickstart/README.md) -
  the runnable lysozyme example.
- `skills/scienceswarm-md-*/hosts/openclaw/SKILL.md` - the OpenClaw skill
  instructions used by the slash commands.
- Maier et al. 2015 (PMID 26574453) - AMBER ff14SB.
- Eastman et al. 2017 (PMID 28746537) - OpenMM.
