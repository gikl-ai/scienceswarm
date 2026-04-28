# ScienceSwarm SYK pipeline walkthrough

This walkthrough shows a new ScienceSwarm user how to drive the
[SYK spectral form factor tutorial](syk-spectral-form-factor/README.md) from
the UI. You should not need to open a terminal or type shell commands. The
expected final state is:

- a Study-scoped SYK Study Brief saved in gbrain,
- Claude Code execution run logs for the fast preview and default tutorial run,
- generated `scripts/spectra.npz`, `scripts/sff_data.json`,
  `scripts/metrics.json`, and `scripts/report.html`,
- a results interpretation note and a refinement decision,
- all generated files stored inside the ScienceSwarm Study workspace.

The example is a tutorial scaffold for quantum-chaos numerics, not a new
physics result.

---

## 0. Create the Study and choose Claude Code

1. Start ScienceSwarm and complete setup if the app asks.
2. Open the dashboard and create a Study. A name like
   `SYK spectral form factor tutorial` is fine.
3. Open the Study. You should see the study chat composer at the bottom of
   the page.
4. Click `+ Add`, choose `Import Local Folder`, and import
   `docs/tutorials/syk-spectral-form-factor/`.
5. If the import says `README.md` or `environment.yml` were saved without typed
   conversion, continue. They are still available to the assistant as Study
   files.
6. In the study chat composer, open the assistant selector and choose
   `Claude Code`.
7. If ScienceSwarm shows a send-review sheet for Claude Code, confirm the
   destination is `Claude Code`, the Study is your SYK Study, and the
   included data is the prompt plus Study context. Then click the send button
   in that sheet.

Use Claude Code for every step below. Do not switch assistants mid-walkthrough.

---

## How to run each step

For each step:

1. Stay on the Study page.
2. Confirm the assistant selector says `Claude Code`.
3. Click the message box.
4. Paste the text block for the step.
5. Click `Send`.
6. Wait until the `Stop` button disappears and the assistant reports a saved
   gbrain slug before starting the next step.

If you update this tutorial checkout while a Study is already imported, use
`+ Add` then `Check for Changes` before asking Claude Code to rerun anything.

---

## 1. Create the SYK Study Brief

Paste this into the study chat:

```text
Create a SYK Tutorial Study Brief for this Study. Use the imported README.md
and scripts as context.

Goal: reproduce the SYK_4 spectral form factor dip-ramp-plateau tutorial from
the ScienceSwarm UI, not from terminal instructions typed by the user.

Record the model, run modes (fast preview and full tutorial), validation
gates, expected outputs, artifact locations, and confidence boundary. Do not
run the scripts yet. Save a durable Study-scoped Study Brief with
gbrain_capture before answering.
```

Continue only after the assistant says it saved a Study Brief. Check that the
output includes the SYK_4 model, `N mod 8` ensemble classes, the fast preview
and default tutorial modes, validation gates, output files, and a confidence
boundary saying this is a didactic reproduction rather than a new result.

---

## 2. Run the fast preview

Paste:

```text
Create a SYK Execution Handoff and run the fast preview end to end from this
ScienceSwarm Study workspace.

Use the imported tutorial files. The scripts live in scripts/ and the
environment file is environment.yml. Work inside the Study workspace, not the
ScienceSwarm app checkout and not the original tutorial checkout.

First check whether python3 can import NumPy and SciPy. If that works, reuse
that environment and report the Python, NumPy, and SciPy versions. If it does
not work, do not install anything yet; report the missing dependency and the
proposed managed environment location under
$SCIENCESWARM_DIR/runtimes/conda/envs/scienceswarm-syk-sff.

Run the fast preview: 01_diagonalize.py with N=20 and samples=60, then
02_spectral_form_factor.py, then 03_render_report.py. Keep generated files
inside the Study scripts folder. Stop if any validation gate fails.

When finished, summarize metrics.json, explicitly mention whether the GSE
Kramers-pair handling was used, list spectra.npz, sff_data.json, metrics.json,
and report.html with sizes, and save a durable Study-scoped SYK Execution
Run Log with gbrain_capture before answering.
```

The expected successful fast-preview metrics are:

| Metric | Expected result |
|---|---|
| `expected_class` | `GSE` for `N=20` |
| `<r>` | within `0.020` of the GSE Atas reference `0.67617` |
| `kramers.pairs_collapsed` | `true` |
| `plateau_ref_kind` | collapsed Kramers-pair time average |
| `ramp_present` | `true` |
| `plateau_within_tolerance` | `true` |

If stage 2 fails with `<r>` close to zero, the Study is probably using an
old copy of `02_spectral_form_factor.py`. Click `+ Add`, click
`Check for Changes`, and rerun this step.

---

## 3. Inspect the generated artifacts

After Claude Code reports success:

1. Expand the Study file tree.
2. Expand `scripts/`.
3. Open `metrics.json` and verify the validation gates passed.
4. Open `report.html` from the tree. The report is a standalone HTML artifact;
   if your current ScienceSwarm build shows it as source text rather than a
   rendered page, ask Claude Code to summarize the report and open the file
   from the Study workspace until HTML artifact preview is available.

Expected files:

| Artifact | Meaning |
|---|---|
| `scripts/spectra.npz` | disorder-ensemble eigenvalue spectra |
| `scripts/sff_data.json` | curves and overlays for the report |
| `scripts/metrics.json` | validation-gate payload |
| `scripts/report.html` | interactive HTML report with CDN-loaded Plotly assets |

---

## 4. Interpret the results

Paste:

```text
Interpret the completed SYK fast-preview run.

Use scripts/metrics.json and scripts/report.html from this Study workspace.
Classify each candidate claim as supported, suggestive, weak, or unsupported.
Separate "the tutorial pipeline completed" from any scientific claim. Explain
what the dip-ramp-plateau, gap-ratio check, and plateau gate support, and name
the limits of the N=20 fast preview. Save a durable Study-scoped SYK Results
Interpretation Note with gbrain_capture before answering.
```

Expected interpretation: the pipeline completion is supported if every stage
finished and all gates passed; the presence of textbook Wigner-Dyson/SFF
structure is supported for the small tutorial ensemble; broader claims about
large-N physics, holography, or new scientific discovery are unsupported.

---

## 5. Decide what to do next

Paste:

```text
Create a SYK Refinement Decision Update using the Study Brief, Execution Run
Log, generated artifacts, and Results Interpretation Note from this Study.

Choose one of: stop, rerun-same-protocol, run-default-tutorial,
increase-samples, increase-N, adjust-time-grid, inspect-code, or
seek-expert-review. For this tutorial, explain whether the right next step is
to stop after the fast preview, run the default N=22 tutorial, or run the
larger N=24 case for a sharper ramp. Save a durable Study-scoped SYK
Refinement Decision Update with gbrain_capture before answering.
```

For a successful fast preview, `run-default-tutorial` is the expected next step
if you want the headline tutorial artifact. `stop` is acceptable only when you
are smoke-testing the platform wiring. `increase-N` is the natural next
learning path after the default `N=22` run.

---

## 6. Run the default tutorial

If the refinement decision is `run-default-tutorial`, paste:

```text
Run the default SYK tutorial now from this ScienceSwarm Study workspace.

Use the imported tutorial files under scripts/. Run 01_diagonalize.py with its
defaults (N=22, samples=80, seed=2026), then 02_spectral_form_factor.py with
its defaults, then 03_render_report.py. Work only inside this Study
workspace. It is okay that the default run overwrites the fast-preview
spectra.npz, sff_data.json, metrics.json, and report.html; the fast-preview
record is already preserved in gbrain.

Stop immediately if any validation gate fails. When finished, summarize
metrics.json, list spectra.npz, sff_data.json, metrics.json, and report.html
with sizes, say whether the expected class is GUE and whether Kramers-pair
collapse was not needed, and save a durable Study-scoped SYK Default Tutorial
Run Log with gbrain_capture before answering.
```

Expected default result:

| Metric | Expected result |
|---|---|
| `expected_class` | `GUE` for `N=22` |
| `<r>` | within `0.020` of the GUE Atas reference `0.59945` |
| `kramers.pairs_collapsed` | `false` |
| `ramp_present` | `true` |
| `plateau_within_tolerance` | `true` |
| `report.html` | regenerated with the default tutorial curves |

---

## Done checklist

You are done when gbrain contains:

- SYK Study Brief
- SYK fast-preview Execution Run Log
- SYK Results Interpretation Note
- SYK Refinement Decision Update
- SYK Default Tutorial Run Log

And the Study workspace contains:

- `scripts/spectra.npz`
- `scripts/sff_data.json`
- `scripts/metrics.json`
- `scripts/report.html`

The final answer you want from ScienceSwarm is a traceable chain from tutorial
goal, to runtime decision, to execution artifacts, to validation metrics, to an
explicit stop or refinement decision.

---

## Further reading

- [`docs/tutorials/syk-spectral-form-factor/README.md`](syk-spectral-form-factor/README.md)
  - the runnable tutorial package.
- `docs/tutorials/md-pipeline-walkthrough.md` - a longer planning-skill
  walkthrough for the lysozyme MD tutorial.
- You, Ludwig, Xu. *PRB* **95**, 115150 (2017) - SYK symmetry classes.
- Atas, Bogomolny, Roux, Roy. *PRL* **110**, 084101 (2013) - gap-ratio
  surmise values used by the validation gate.
