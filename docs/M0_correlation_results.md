# M0 — Bump Correlation Results

This is the exit-gate artifact for Milestone 0 (Build Guide Phase 2 / spec S9). Fill
this in after running `telemetry/analysis/compute_correlation.py` against the real
~200-bump session captured with the telemetry harness.

## Session info
- Session id(s):
- Date(s):
- Phone A: model / OS version
- Phone B: model / OS version
- Number of bumps captured:
- Number of bumps the analysis script could pair (some may be dropped if only one
  phone was in the coarse pairing window, or the peak-grid wasn't fully covered by
  samples):

## R_AB distribution (overall)
| stat | value |
|------|-------|
| count | |
| mean | |
| stdev | |
| p05 | |
| p25 | |
| p50 (median) | |
| p75 | |
| p95 | |

## R_AB by grip / orientation / contact point
(paste the grouped output of `compute_correlation.py`, or summarize the notable
splits -- e.g. does `loose` grip pull the distribution down significantly?)

## Threshold policy decision
- [ ] Single baseline threshold works across both device models
- [ ] Per-device-class thresholds are needed (models diverge)

Chosen `R_AB` minimum: \_\_\_\_ (spec S4.3 baseline was 0.80 -- pending real data)

Update `mobile/src/config/sensorThresholds.ts` (`rAbMin`, and any other threshold
that the real data suggests should move from its spec-baseline placeholder) to match
this decision.

## Exit gate
- [ ] Correlation is reliable enough across grips/orientations/contact points to
      proceed to M1.
- [ ] Correlation is NOT reliable -- stop and revisit intent binding (loosen the
      gate, add a second confirmation signal, or lean harder on RSSI + timing)
      before Phase 3, per the Build Guide's M0 exit gate.
