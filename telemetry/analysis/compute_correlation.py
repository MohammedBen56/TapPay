"""Computes the bump cross-correlation R_AB from a captured telemetry session.

A and B are never clock-synchronized (that's M3 scope), and two phone models deliver
SensorManager samples at different actual rates/phases even when both request 100 Hz.
Aligning by device timestamp and correlating index-to-index would compare samples
taken at different real times -- the resulting R_AB would be noise, not signal.

So alignment is anchored on the physical impact event, never on clock time:

  1. Coarse pairing by t_server_ns proximity (harness receipt time) narrows the
     search to candidate simultaneous-bump windows. bump_marker events (human taps)
     seed this step but are not trusted for precision -- they can be off by hundreds
     of ms between the two phones.
  2. Fine alignment: within a candidate window, the ||a_filtered|| peak is located
     independently on each device's own stream, in that device's own local time.
     This is the fiducial -- since both sides locate it in their own clock, the
     unsynced-clock problem stops mattering.
  3. Each device's A[n]/W[n] magnitude profile is linearly interpolated onto a
     common uniform 100 Hz grid (10 samples, spec S4.2), anchored at that device's
     own peak.
  4. R_AB[k] (spec S4.2 formula) is computed over the resampled windows with a small
     lag search to absorb whatever residual offset the peak-alignment didn't remove.
"""

from __future__ import annotations

import argparse
import json
import statistics
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

HIGH_PASS_ALPHA = 0.8
GRID_SAMPLES = 10
GRID_DT_NS = 10_000_000  # 10 ms -> 100 Hz
GRID_HALF_SPAN_NS = 50_000_000  # 50 ms either side of the peak, per spec S4.2
MAX_LAG_SAMPLES = 3


@dataclass
class RoleStream:
    t_device_ns: np.ndarray  # (n,)
    t_server_ns: np.ndarray  # (n,) approx: the server-receipt time of the batch this sample arrived in
    accel: np.ndarray  # (n, 3) raw
    gyro: np.ndarray  # (n, 3) raw
    mag: np.ndarray  # (n, 3) raw -- not used in R_AB, kept for plotting/exploration
    accel_filtered: np.ndarray = field(default=None)  # (n, 3)
    A: np.ndarray = field(default=None)  # (n,) = ||accel_filtered||
    W: np.ndarray = field(default=None)  # (n,) = ||gyro||


@dataclass
class BumpResult:
    window_center_server_ns: int
    r_ab: float
    lag_samples: int
    tag: dict


# --- Core math primitives (unit-tested directly against known-answer fixtures) ---


def highpass_accel(accel: np.ndarray, alpha: float = HIGH_PASS_ALPHA) -> np.ndarray:
    """accel: (n, 3) raw samples in device stream order. Strips the ~1g gravity baseline.

    a_filtered[n] = alpha * (a_filtered[n-1] + a_raw[n] - a_raw[n-1])   (spec S4.2)
    """
    n = accel.shape[0]
    filtered = np.zeros_like(accel, dtype=np.float64)
    for i in range(1, n):
        filtered[i] = alpha * (filtered[i - 1] + accel[i] - accel[i - 1])
    return filtered


def compute_jerk(stream: RoleStream) -> np.ndarray:
    """||d(accel_raw)/dt||, using each sample's own device-clock spacing."""
    dt_s = np.diff(stream.t_device_ns) / 1e9
    dt_s[dt_s == 0] = np.nan  # avoid divide-by-zero on duplicate timestamps
    d_accel = np.diff(stream.accel, axis=0) / dt_s[:, None]
    jerk = np.linalg.norm(d_accel, axis=1)
    return np.concatenate([[0.0], jerk])  # align length with the stream


def resample_to_grid(
    t_ns: np.ndarray,
    values: np.ndarray,
    peak_t_ns: float,
    n_samples: int = GRID_SAMPLES,
    dt_ns: float = GRID_DT_NS,
) -> np.ndarray | None:
    """Linearly interpolate `values` (sampled at `t_ns`) onto a uniform grid of
    `n_samples` centered on `peak_t_ns`. Returns None if the grid isn't covered by
    the input samples (can't extrapolate a fiducial window from too little data).
    """
    half = (n_samples / 2 - 0.5) * dt_ns
    grid_t = peak_t_ns + np.arange(n_samples) * dt_ns - half
    if grid_t[0] < t_ns[0] or grid_t[-1] > t_ns[-1]:
        return None
    return np.interp(grid_t, t_ns, values)


def correlate_grids(
    A_a: np.ndarray,
    W_a: np.ndarray,
    A_b: np.ndarray,
    W_b: np.ndarray,
    max_lag: int = MAX_LAG_SAMPLES,
) -> tuple[float, int]:
    """R_AB[k] per spec S4.2, small lag search. Returns (best R_AB, best lag).

    R_AB[k] = (sum A_A*A_B[n+k] + sum W_A*W_B[n+k])
              / sqrt((sum A_A^2 + sum W_A^2) * (sum A_B^2 + sum W_B^2))
    """
    denom = np.sqrt((np.sum(A_a**2) + np.sum(W_a**2)) * (np.sum(A_b**2) + np.sum(W_b**2)))
    if denom == 0:
        return 0.0, 0

    best_r = -1.0
    best_lag = 0
    n = len(A_a)
    for k in range(-max_lag, max_lag + 1):
        if k >= 0:
            a_slice = slice(0, n - k) if k > 0 else slice(0, n)
            b_slice = slice(k, n)
        else:
            a_slice = slice(-k, n)
            b_slice = slice(0, n + k)
        num = np.sum(A_a[a_slice] * A_b[b_slice]) + np.sum(W_a[a_slice] * W_b[b_slice])
        r = num / denom
        if r > best_r:
            best_r, best_lag = float(r), k
    return best_r, best_lag


# --- Session loading + pairing pipeline ---


def load_session(path: Path) -> tuple[dict[str, RoleStream], list[dict], list[dict]]:
    """Returns (streams, bump_markers, bump_detections). bump_markers are human "Mark
    Bump" taps; bump_detections are the on-device live detector's own self-reported
    fires (TelemetryClient.sendBumpDetected) -- kept separate since they answer
    different questions: did a bump happen here (marker) vs. did the live detector
    actually catch it (detection). See templates.py for how a session viewer checks
    one against the other.
    """
    per_role_samples: dict[str, list[tuple]] = {"A": [], "B": []}
    bump_markers: list[dict] = []
    bump_detections: list[dict] = []

    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            role = record.get("device_role")
            if record.get("type") == "sensor_batch" and role in per_role_samples:
                t_server = record["t_server_ns"]
                for sample in record["samples"]:
                    per_role_samples[role].append(
                        (sample["t_device_ns"], t_server, sample["accel"], sample["gyro"], sample["mag"])
                    )
            elif record.get("type") == "bump_marker":
                bump_markers.append(record)
            elif record.get("type") == "bump_detected":
                bump_detections.append(record)

    streams: dict[str, RoleStream] = {}
    for role, rows in per_role_samples.items():
        if not rows:
            continue
        rows.sort(key=lambda r: r[0])
        t_device = np.array([r[0] for r in rows], dtype=np.float64)
        t_server = np.array([r[1] for r in rows], dtype=np.float64)
        accel = np.array([r[2] for r in rows], dtype=np.float64)
        gyro = np.array([r[3] for r in rows], dtype=np.float64)
        mag = np.array([r[4] for r in rows], dtype=np.float64)
        accel_filtered = highpass_accel(accel)
        A = np.linalg.norm(accel_filtered, axis=1)
        W = np.linalg.norm(gyro, axis=1)
        streams[role] = RoleStream(t_device, t_server, accel, gyro, mag, accel_filtered, A, W)

    return streams, bump_markers, bump_detections


def cluster_markers(bump_markers: list[dict], window_s: float) -> list[float]:
    if not bump_markers:
        return []
    times = sorted(m["t_server_ns"] for m in bump_markers)
    window_ns = window_s * 1e9
    clusters: list[list[float]] = [[times[0]]]
    for t in times[1:]:
        if t - clusters[-1][-1] <= window_ns:
            clusters[-1].append(t)
        else:
            clusters.append([t])
    return [statistics.mean(c) for c in clusters]


def find_peak_in_window(stream: RoleStream, center_ns: float, half_window_ns: float) -> int | None:
    mask = np.abs(stream.t_server_ns - center_ns) <= half_window_ns
    if not np.any(mask):
        return None
    idx_candidates = np.nonzero(mask)[0]
    return int(idx_candidates[np.argmax(stream.A[idx_candidates])])


def compute_bumps(
    streams: dict[str, RoleStream],
    bump_markers: list[dict],
    window_s: float = 1.5,
) -> list[BumpResult]:
    if "A" not in streams or "B" not in streams:
        return []

    centers = cluster_markers(bump_markers, window_s)
    half_window_ns = window_s / 2 * 1e9
    results: list[BumpResult] = []

    for center in centers:
        peak_a_idx = find_peak_in_window(streams["A"], center, half_window_ns)
        peak_b_idx = find_peak_in_window(streams["B"], center, half_window_ns)
        if peak_a_idx is None or peak_b_idx is None:
            continue

        a_stream, b_stream = streams["A"], streams["B"]
        A_a = resample_to_grid(a_stream.t_device_ns, a_stream.A, a_stream.t_device_ns[peak_a_idx])
        W_a = resample_to_grid(a_stream.t_device_ns, a_stream.W, a_stream.t_device_ns[peak_a_idx])
        A_b = resample_to_grid(b_stream.t_device_ns, b_stream.A, b_stream.t_device_ns[peak_b_idx])
        W_b = resample_to_grid(b_stream.t_device_ns, b_stream.W, b_stream.t_device_ns[peak_b_idx])
        if A_a is None or W_a is None or A_b is None or W_b is None:
            continue

        r_ab, lag = correlate_grids(A_a, W_a, A_b, W_b)

        nearest_marker = min(bump_markers, key=lambda m: abs(m["t_server_ns"] - center), default=None)
        tag = nearest_marker.get("tag", {}) if nearest_marker else {}
        results.append(BumpResult(int(center), r_ab, lag, tag))

    return results


def summarize(results: list[BumpResult]) -> dict:
    if not results:
        return {"count": 0}
    values = [r.r_ab for r in results]
    quantiles = np.quantile(values, [0.05, 0.25, 0.5, 0.75, 0.95]).tolist()
    return {
        "count": len(values),
        "mean": statistics.mean(values),
        "stdev": statistics.pstdev(values) if len(values) > 1 else 0.0,
        "p05": quantiles[0],
        "p25": quantiles[1],
        "p50": quantiles[2],
        "p75": quantiles[3],
        "p95": quantiles[4],
    }


def group_by_tag(results: list[BumpResult], key: str) -> dict[str, list[BumpResult]]:
    groups: dict[str, list[BumpResult]] = {}
    for r in results:
        value = r.tag.get(key) or "unknown"
        groups.setdefault(value, []).append(r)
    return groups


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session_file", type=Path, help="path to a telemetry/data/<session>.jsonl file")
    parser.add_argument("--window-s", type=float, default=1.5, help="coarse pairing window, seconds")
    parser.add_argument("--out", type=Path, default=None, help="optional JSON report output path")
    args = parser.parse_args()

    streams, bump_markers, _bump_detections = load_session(args.session_file)
    results = compute_bumps(streams, bump_markers, window_s=args.window_s)

    report = {"overall": summarize(results)}
    for key in ("grip", "orientation", "contact_point"):
        report[key] = {group: summarize(group_results) for group, group_results in group_by_tag(results, key).items()}

    print(json.dumps(report, indent=2))
    if args.out:
        args.out.write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
