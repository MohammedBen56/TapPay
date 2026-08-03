"""Exploratory M0 feasibility check: given one real ~20-bump session, do simple
physics features (R_AB, peak accel/gyro, cross-device timing) already separate true
simultaneous bumps from ordinary incidental motion -- or do we need more data / a
fancier model before a threshold-based gate (the spec's actual target architecture,
CLAUDE.md S5) is viable?

Reuses compute_correlation.py's math directly (load_session, cluster_markers,
find_peak_in_window, resample_to_grid, correlate_grids) rather than reimplementing
it, so "positive" (near-marker) and "negative" (elsewhere in the session) windows are
scored through the exact same pipeline -- an apples-to-apples comparison, not two
different measurements.

Deliberately does NOT reach for scikit-learn or any trained model on the first pass.
With ~20 positives from a single session/device-pair, a fitted model would be
overfit noise dressed up as a result. A numpy-only best-threshold sweep answers the
actual question ("is this easy enough") without that risk, and if it works, its
output IS the spec's threshold policy in the format CLAUDE.md S5 already wants
(config values, not a model). Only if this fails to separate cleanly is a heavier
approach (more data, more features, an actual classifier) worth reaching for --
this script says so explicitly in that case rather than silently pretending to
answer the question.
"""

from __future__ import annotations

import argparse
import json
import random
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from analysis.compute_correlation import (
    RoleStream,
    cluster_markers,
    correlate_grids,
    find_peak_in_window,
    load_session,
    resample_to_grid,
)

WINDOW_S = 1.5
NEG_EXCLUSION_S = 3.0  # keep negative centers at least this far from any real bump
NEG_PER_POS = 3  # oversample negatives for a less noisy separability read


@dataclass
class Example:
    label: int  # 1 = real bump (near a marker cluster), 0 = negative (elsewhere)
    r_ab: float
    lag_abs: int
    peak_accel_a: float
    peak_accel_b: float
    accel_diff: float
    peak_gyro_a: float
    peak_gyro_b: float
    gyro_diff: float


def extract_example(streams: dict[str, RoleStream], center_ns: float, label: int) -> Example | None:
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

    r_ab, lag = correlate_grids(A_a, W_a, A_b, W_b)
    peak_accel_a = float(a.A[peak_a_idx])
    peak_accel_b = float(b.A[peak_b_idx])
    peak_gyro_a = float(a.W[peak_a_idx])
    peak_gyro_b = float(b.W[peak_b_idx])

    return Example(
        label=label,
        r_ab=r_ab,
        lag_abs=abs(lag),
        peak_accel_a=peak_accel_a,
        peak_accel_b=peak_accel_b,
        accel_diff=abs(peak_accel_a - peak_accel_b),
        peak_gyro_a=peak_gyro_a,
        peak_gyro_b=peak_gyro_b,
        gyro_diff=abs(peak_gyro_a - peak_gyro_b),
    )


def sample_negative_centers(
    streams: dict[str, RoleStream], positive_centers: list[float], count: int, seed: int
) -> list[float]:
    """Draws candidates from actual recorded sample timestamps (pooled across both
    roles), not a uniform continuous span. A real session can have gaps -- a pause
    between capture bursts, the app backgrounded -- and a uniform-over-span draw
    would happily propose centers that fall inside one, which then fail at the
    peak-finding step and silently vanish (this is exactly what happened on the
    first pass against a session with one ~113s gap: 59 of 60 candidates were
    unusable). Sampling from where data actually exists avoids that class of
    failure entirely rather than working around its symptom.
    """
    pool = np.concatenate([streams["A"].t_server_ns, streams["B"].t_server_ns])
    exclusion_ns = NEG_EXCLUSION_S * 1e9

    rng = random.Random(seed)
    centers: list[float] = []
    attempts = 0
    while len(centers) < count and attempts < count * 50:
        attempts += 1
        candidate = float(rng.choice(pool))
        if any(abs(candidate - p) < exclusion_ns for p in positive_centers):
            continue
        centers.append(candidate)
    return centers


def best_single_threshold(values: np.ndarray, labels: np.ndarray) -> dict:
    """Sweeps every candidate cut point in BOTH directions (`value >= t` and
    `value <= t`) and returns whichever rule maximizes accuracy.

    Deliberately does not take a hardcoded "higher is more bump-like" assumption
    per feature -- an early version of this script guessed that direction by hand
    (e.g. "a real bump should have a *small* diff between phones, since it's one
    synchronized event") and got it backwards for more than one feature: on this
    session's real data, real bumps actually show a *larger* peak-accel diff
    between phones than incidental motion does (plausibly: one phone takes the
    direct impact, the other doesn't, while ambient jostling affects both
    similarly) and *lower* gyro than incidental handling does (a deliberate tap
    is a controlled, mostly-linear motion; picking the phone up to look at it
    isn't). Letting the data pick the direction avoids baking in a physically
    wrong assumption and silently under-reporting a feature's real accuracy.
    """
    candidates = np.unique(values)
    best = {"threshold": None, "accuracy": -1.0, "direction": None, "tp": 0, "fp": 0, "tn": 0, "fn": 0}
    for t in candidates:
        for direction, pred in ((">=", values >= t), ("<=", values <= t)):
            tp = int(np.sum(pred & (labels == 1)))
            fp = int(np.sum(pred & (labels == 0)))
            fn = int(np.sum(~pred & (labels == 1)))
            tn = int(np.sum(~pred & (labels == 0)))
            acc = (tp + tn) / len(labels)
            if acc > best["accuracy"]:
                best = {"threshold": float(t), "accuracy": acc, "direction": direction, "tp": tp, "fp": fp, "tn": tn, "fn": fn}
    return best


def describe(values: np.ndarray) -> dict:
    return {
        "min": float(np.min(values)),
        "p25": float(np.percentile(values, 25)),
        "median": float(np.median(values)),
        "p75": float(np.percentile(values, 75)),
        "max": float(np.max(values)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_file", type=Path)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    streams, bump_markers, _bump_detections = load_session(args.session_file)
    if "A" not in streams or "B" not in streams:
        raise SystemExit("session needs both phone A and phone B streams")

    positive_centers = cluster_markers(bump_markers, WINDOW_S)
    negative_centers = sample_negative_centers(
        streams, positive_centers, count=len(positive_centers) * NEG_PER_POS, seed=args.seed
    )

    examples: list[Example] = []
    for c in positive_centers:
        ex = extract_example(streams, c, label=1)
        if ex:
            examples.append(ex)
    for c in negative_centers:
        ex = extract_example(streams, c, label=0)
        if ex:
            examples.append(ex)

    n_pos = sum(e.label for e in examples)
    n_neg = len(examples) - n_pos
    print(f"positives (real bumps): {n_pos} / {len(positive_centers)} clustered markers")
    print(f"negatives (elsewhere):  {n_neg} / {len(negative_centers)} sampled candidates")
    print()

    labels = np.array([e.label for e in examples])
    feature_specs = [
        ("r_ab", "r_ab"),
        ("accel_diff (g, between phones)", "accel_diff"),
        ("peak_accel_a (g)", "peak_accel_a"),
        ("peak_accel_b (g)", "peak_accel_b"),
        ("gyro_diff (rad/s, between phones)", "gyro_diff"),
        ("peak_gyro_a (rad/s)", "peak_gyro_a"),
        ("peak_gyro_b (rad/s)", "peak_gyro_b"),
        ("lag_abs (10ms grid steps)", "lag_abs"),
    ]

    print(f"{'feature':38s} {'pos median':>12s} {'neg median':>12s} {'best acc':>10s} {'rule':>14s}")
    results = {}
    for label, attr in feature_specs:
        values = np.array([getattr(e, attr) for e in examples], dtype=np.float64)
        pos_stats = describe(values[labels == 1])
        neg_stats = describe(values[labels == 0])
        best = best_single_threshold(values, labels)
        results[attr] = {"positive": pos_stats, "negative": neg_stats, "best_single_threshold": best}
        print(
            f"{label:38s} {pos_stats['median']:12.3f} {neg_stats['median']:12.3f} "
            f"{best['accuracy']:10.1%} {best['direction']:>3s} {best['threshold']:.3f}"
        )

    print()
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
