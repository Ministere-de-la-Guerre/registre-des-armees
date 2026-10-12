"""Unit-pricing model for NTW3 Theatre-of-War and Custom armies (the pricing package).

Structure (per the ex-dev: price is a linear combination of unit type, speed,
stats, traits and abilities, then multiplied by unit size and other factors):

    price = M × size^p × (b0 + Σ_j β_j·stat_j^(a_j) + flags + categoricals) + c

  size  unit size: models (men_raw / 2) for infantry and cavalry, GUNS for
        artillery (crew per gun is 10 foot / 6 horse, so models misprice one type
        against the other)
  p     size power — profiled by cross-validation
  a_j   per-stat powers on the numeric stats (still added together) — fitted by
        coordinate descent inside each training fold (nested CV)
  M     product of one factor per variable placed "multiplicative"
  c     optional flat per-unit constant, outside the multiplier

Which of corps rating, training level, drill set (infantry), packing
(rank_depth) and side belong in β·x, in M, or nowhere is searched
exhaustively; the headline is the simplest model within one standard error of
the best. Faction modifiers are fitted on top of the final model; the adopted
army-level form (FCLASS_FORM, from the blind study) replaces the free rating
levels by the divisor 8/N and adds a ridge-shrunk faction × unit_class
multiplier fitted jointly with the stats (run "FC"). Staff generals:
price = b·stars^q·(8/N), 1 gold without stars (T3). See analysis/PRICING_MODEL_REPORT.md
for the model written out and analysis/HANDOFF.md for how to work on it.

Validation is 5-fold cross-validation where every fold is an 80/20 split built
to keep identical units together, stratify by unit type, cover every
categorical level in train, and spread each faction evenly.

Inputs:  data/generated/ntw3_units_analysis.csv  (tools/build_analysis_dataset.py)
         data/generated/army_corps_catalog.csv   (corps ratings)
Outputs: analysis/output/unit_pricing_report.md
         analysis/output/search_results.csv
         analysis/output/coefficients.csv
         analysis/output/oof_predictions.csv

Run from the repository root (~50 minutes with the default 6 worker processes):

    python analysis/unit_pricing.py [--seeds 500] [--workers 6] [--out DIR] [--artillery-cal …] [--linear]

The code is split into one module per stage; analysis/unit_pricing.py is the front that scripts
import and run, and lists the modules. Depends on numpy and scikit-learn (no pandas).
"""
