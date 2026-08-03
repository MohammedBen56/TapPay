"""Follow-up to bump_separability.py: that script found a single feature (peak
accel magnitude, per phone) gave 100% train-accuracy separation on ONE real session
(1.jsonl, 20 bumps). Testing that fixed threshold against later sessions (2, 4)
showed it doesn't generalize -- session 4 alone had 6 of 13 real bumps go
undetected, because those taps were genuinely gentler than session 1's calibration
taps. A single fixed magnitude threshold can't tell "gentle real bump" from "no
bump" when a harder incidental jostle in some OTHER session could exceed it too.

This script combines every valid real session (correct A/B role labeling, unlike
3.jsonl where both phones were accidentally set to role A) and fits a small,
interpretable logistic regression over multiple features -- notably including peak
JERK (d(accel)/dt magnitude, via compute_jerk) alongside peak accel, gyro, and R_AB.
The physical intuition for jerk mattering: a sharp impact is a fast CHANGE in
acceleration, not just a large one -- slowly building your arm up to a high but
smooth acceleration (swinging, walking) can hit a similar peak-accel magnitude
without ever being a bump, whereas a real tap is abrupt. Peak accel alone can't
distinguish those two cases; peak jerk plausibly can.

Evaluated with leave-one-session-out cross-validation (train on 2 sessions, test on
the 3rd, repeat for each) rather than a single train/test split or in-sample
accuracy -- with only 3 real sessions, in-sample accuracy would mostly just measure
whether the model can memorize idiosyncrasies of the sessions it saw, which is
exactly the generalization failure being diagnosed here in the first place.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from analysis.bump_separability import NEG_PER_POS, WINDOW_S, sample_negative_centers
from analysis.compute_correlation import (
    RoleStream,
    cluster_markers,
    compute_jerk,
    correlate_grids,
    find_peak_in_window,
    load_session,
    resample_to_grid,
)

GRAVITY = 9.80665

FEATURE_NAMES = [
    "r_ab",
    "accel_diff",
    "peak_accel_a",
    "peak_accel_b",
    "gyro_diff",
    "peak_gyro_a",
    "peak_gyro_b",
    "jerk_diff",
    "peak_jerk_a",
    "peak_jerk_b",
]


@dataclass
class Example:
    session: str
    label: int
    features: dict[str, float]


def extract_example(
    streams: dict[str, RoleStream],
    jerks: dict[str, np.ndarray],
    center_ns: float,
    label: int,
    session_name: str,
) -> Example | None:
    half_window_ns = WINDOW_S / 2 * 1e9
    peak_a_idx = find_peak_in_window(streams["A"], center_ns, half_window_ns)
    peak_b_idx = find_peak_in_window(streams["B"], center_ns, half_window_ns)
    if peak_a_idx is None or peak_b_idx is None:
        return None

    a, b = streams["A"], streams["B"]
    A_a = resample_to_grid(a.t_device_ns, a.A, a.t_device_ns[peak_a_idx])
    W_a = resample_to_grid(a.t_device_ns, a.W, a.t_device_ns[peak_a_idx])
    A_b = resample_to_grid(b.t_device_ns, b.A, b.t_device_ns[peak_b_idx])
    W_b = resample_to_grid(b.t_device_ns, b.W, b.t_device_ns[peak_b_idx])
    if A_a is None or W_a is None or A_b is None or W_b is None:
        return None

    r_ab, _lag = correlate_grids(A_a, W_a, A_b, W_b)
    peak_accel_a = float(a.A[peak_a_idx]) / GRAVITY
    peak_accel_b = float(b.A[peak_b_idx]) / GRAVITY
    peak_gyro_a = float(a.W[peak_a_idx])
    peak_gyro_b = float(b.W[peak_b_idx])
    peak_jerk_a = float(jerks["A"][peak_a_idx]) / GRAVITY
    peak_jerk_b = float(jerks["B"][peak_b_idx]) / GRAVITY

    return Example(
        session=session_name,
        label=label,
        features={
            "r_ab": r_ab,
            "accel_diff": abs(peak_accel_a - peak_accel_b),
            "peak_accel_a": peak_accel_a,
            "peak_accel_b": peak_accel_b,
            "gyro_diff": abs(peak_gyro_a - peak_gyro_b),
            "peak_gyro_a": peak_gyro_a,
            "peak_gyro_b": peak_gyro_b,
            "jerk_diff": abs(peak_jerk_a - peak_jerk_b),
            "peak_jerk_a": peak_jerk_a,
            "peak_jerk_b": peak_jerk_b,
        },
    )


def load_examples(session_file: Path, seed: int) -> list[Example]:
    streams, bump_markers, _bump_detections = load_session(session_file)
    if "A" not in streams or "B" not in streams:
        print(f"skipping {session_file.name}: missing a role (see 3.jsonl -- both phones were role A)")
        return []

    jerks = {role: compute_jerk(stream) for role, stream in streams.items()}

    positive_centers = cluster_markers(bump_markers, WINDOW_S)
    negative_centers = sample_negative_centers(streams, positive_centers, count=len(positive_centers) * NEG_PER_POS, seed=seed)

    examples: list[Example] = []
    for c in positive_centers:
        ex = extract_example(streams, jerks, c, 1, session_file.stem)
        if ex:
            examples.append(ex)
    for c in negative_centers:
        ex = extract_example(streams, jerks, c, 0, session_file.stem)
        if ex:
            examples.append(ex)
    return examples


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_files", type=Path, nargs="+")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    all_examples: list[Example] = []
    for f in args.session_files:
        exs = load_examples(f, args.seed)
        n_pos = sum(e.label for e in exs)
        print(f"{f.name}: {n_pos} positive, {len(exs) - n_pos} negative examples")
        all_examples.extend(exs)

    sessions = sorted({e.session for e in all_examples})
    X = np.array([[e.features[name] for name in FEATURE_NAMES] for e in all_examples])
    y = np.array([e.label for e in all_examples])
    session_ids = np.array([e.session for e in all_examples])

    print(f"\ntotal: {len(all_examples)} examples across {len(sessions)} sessions: {sessions}")

    # Leave-one-session-out CV -- the honest generalization check, not in-sample fit.
    print("\nleave-one-session-out cross-validation:")
    accuracies = []
    for held_out in sessions:
        train_mask = session_ids != held_out
        test_mask = ~train_mask
        if test_mask.sum() == 0 or train_mask.sum() == 0:
            continue
        scaler = StandardScaler().fit(X[train_mask])
        clf = LogisticRegression(max_iter=1000).fit(scaler.transform(X[train_mask]), y[train_mask])
        pred = clf.predict(scaler.transform(X[test_mask]))
        acc = float(np.mean(pred == y[test_mask]))
        accuracies.append(acc)
        tp = int(np.sum((pred == 1) & (y[test_mask] == 1)))
        fn = int(np.sum((pred == 0) & (y[test_mask] == 1)))
        fp = int(np.sum((pred == 1) & (y[test_mask] == 0)))
        tn = int(np.sum((pred == 0) & (y[test_mask] == 0)))
        print(f"  held out {held_out:20s} acc={acc:.1%}  tp={tp} fn={fn} fp={fp} tn={tn}")
    print(f"  mean cross-validated accuracy: {np.mean(accuracies):.1%}")

    # Full-data fit purely for interpretability (which features the model leans on) --
    # NOT the accuracy figure to trust; the CV numbers above are.
    scaler = StandardScaler().fit(X)
    clf = LogisticRegression(max_iter=1000).fit(scaler.transform(X), y)
    print("\nfull-data fit coefficients (standardized units -- larger |weight| = more influence):")
    for name, weight in sorted(zip(FEATURE_NAMES, clf.coef_[0]), key=lambda kv: -abs(kv[1])):
        print(f"  {name:16s} {weight:+.3f}")


if __name__ == "__main__":
    main()
