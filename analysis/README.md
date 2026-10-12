# Analysis pipeline — the in-app optimiser's data

This folder regenerates the three files the app's optimiser ships, from the game data in this repository
alone:

| File (`data/generated/`) | What it holds |
|---|---|
| `ntw3_optimiser_values.csv` | every valued unit and commander card's value per mode (Quantity, Quality, size bands) |
| `ntw3_optimiser_params.json` | per pool (ToW + Custom, Army Corps): the staff-general price rule and the command correction |
| `ntw3_optimiser_army_values.csv` | every army's best-build value per mode, for the planner's "Suggest team" |

`tools/build_web_data.py` merges them into the app's data. Nothing here is needed to build or run the app;
it is needed only when unit stats, prices or rosters change and the values must follow.

## Setup

Python 3.13 and the pinned packages (the fits are cached as pickles, which depend on these versions):

```bash
py -3.13 -m pip install -r analysis/requirements.txt
```

## Run

```bash
py -3.13 analysis/run_pipeline.py            # everything, in order (a few hours on a 16-thread PC)
py -3.13 analysis/run_pipeline.py --from team   # resume from a stage
```

Every step caches its fits in `analysis/.cache/` and writes intermediate outputs to `analysis/output/`
(both gitignored), so an interrupted run resumes by running the same command again. The stages, in order
(steps within a stage run in parallel):

| Stage | Steps | Produces | Time |
|---|---|---|---|
| `dataset` | `tools/build_analysis_dataset.py` | `data/generated/ntw3_units_analysis.csv` (from the builder CSV and `source/tables/`) | seconds |
| `base` | `unit_pricing.py` · `class_structure.py` · `build_commander_pairs.py` · `ac_discounts.py` | the ToW + Custom price model (coefficients, out-of-fold predictions), its per-class form V4, regular/commander pairs, AC formation rebates | ~40 min |
| `commanders` | `commander_model.py` | the commander model and the price database | ~1 min |
| `ac` | `ac_pricing.py --phase model` per arm | the Army Corps price models (incl. V4 and the size-band model's folds) | up to ~90 min |
| `ac-staff` | `ac_pricing.py --phase staff` · `--phase commanders` | AC staff-general rule, AC commander model | minutes |
| `team` | `team_values.py` | card values per version (`analysis/output/teams/values_*.csv`) | ~5 min |
| `builds` | `ac_builds.py` (and `--no-rebates`) | every AC corps' best build per version, with formation rebates and the recruit-order rule | ~6 min |
| `search` | `team_search.py` | every army's best-build value; the best 4-corps teams | ~2 min |
| `export` | `export_optimiser_values.py` | the three files above | seconds |

Then for the app: `py -3.13 tools/build_web_data.py`, and to refresh the app's parity fixture
`py -3.13 analysis/export_optimiser_values.py --fixture` (`docs/HANDOFF.md` §4.6).

## Code map

- `unit_pricing.py` is the front of the price model; the model itself is the `pricing/` package, one module
  per stage (data, spec, design matrix, `PriceModel`, folds, cross-validation, searches, faction × class,
  staff generals, report). `pricing/final.py` holds the adopted final model per arm.
- `common.py` holds the shared paths, game constants and helpers; `checkpoints.py` names every cached fit.
- `cost_effective_builds.py` (ToW / Custom values and builds), `team_values.py`, `ac_builds.py`,
  `team_search.py` and `export_optimiser_values.py` turn the models into values, builds and the app's files.

## Tests

```bash
py -3.13 -m unittest discover -s analysis/tests -t analysis/tests
```

Without a pipeline run, the tests of the module contract and the shared helpers run; after one, the tests
also check every cached fit against the reference fingerprints (`tests/golden/`) and that recomputed values
and builds equal the written outputs.

## Notes

- **Deterministic:** fold plans come from fixed seeds and every fit is a deterministic optimisation, so a
  run reproduces the shipped files (checked from an empty cache).
- **Optional checks:** `cost_effective_builds.py` and `team_values.py` contain two report-only checks against
  ladder replay data (`analysis/build_blind/data/`). That data is not in this repository; without it the checks
  are skipped and say so. No shipped value depends on them.
- **Hand-set parts:** the command correction for staff generals (λ, σ, the bodyguard bonus, `M_REF`) is set by
  hand from calibration anchors, as documented in `cost_effective_builds.py`.
