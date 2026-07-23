"""Offline session viewer: plots a captured telemetry session with fixed, stable
axes -- unlike the live dashboard (which exists only to confirm data is flowing,
not to analyze it), this is meant for actually inspecting bump shape and comparing
candidate detectors.

Plots four stacked signals per role (A/B, overlaid where both are present):
  1. Raw accel magnitude (g)      -- context: was the phone resting flat, etc.
  2. High-pass filtered accel magnitude (g) -- spec S4.2's current fiducial candidate
  3. Jerk magnitude (g/s)         -- d(accel_raw)/dt; a real bump is a fast rise and
                                     fall (a derivative/shape property), not just a
                                     magnitude threshold. Computed from each role's
                                     own device clock, independent of #2.
  4. Gyro magnitude (rad/s)       -- spec's secondary confirmation signal

bump_marker events are drawn as vertical lines across all panels.

Usage:
  python plot_session.py <session.jsonl>                       # whole session
  python plot_session.py <session.jsonl> --start 12 --end 20    # explicit window, seconds from session start
  python plot_session.py <session.jsonl> --around-marker 0 --window-s 6   # centered on a bump marker
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # headless -- no display in the container
import matplotlib.pyplot as plt
import numpy as np

from analysis.compute_correlation import RoleStream, compute_jerk, load_session

ROLE_COLORS = {"A": "#2b6cb0", "B": "#dd6b20"}
GRAVITY = 9.80665


def resolve_window(streams: dict[str, RoleStream], bump_markers: list[dict], args) -> tuple[float, float]:
    all_server_t = np.concatenate([s.t_server_ns for s in streams.values()])
    session_start = all_server_t.min()

    if args.around_marker is not None:
        if args.around_marker >= len(bump_markers):
            raise SystemExit(f"--around-marker {args.around_marker} out of range ({len(bump_markers)} markers)")
        center = bump_markers[args.around_marker]["t_server_ns"]
        half_ns = args.window_s / 2 * 1e9
        return (center - half_ns - session_start) / 1e9, (center + half_ns - session_start) / 1e9

    start = args.start if args.start is not None else 0.0
    end = args.end if args.end is not None else (all_server_t.max() - session_start) / 1e9
    return start, end


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("session_file", type=Path)
    parser.add_argument("--start", type=float, default=None, help="window start, seconds from session start")
    parser.add_argument("--end", type=float, default=None, help="window end, seconds from session start")
    parser.add_argument("--around-marker", type=int, default=None, help="center window on the Nth bump_marker (0-indexed)")
    parser.add_argument("--window-s", type=float, default=6.0, help="window width when using --around-marker")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    streams, bump_markers = load_session(args.session_file)
    if not streams:
        raise SystemExit("no sensor_batch data found in this session")

    start_s, end_s = resolve_window(streams, bump_markers, args)
    all_server_t = np.concatenate([s.t_server_ns for s in streams.values()])
    session_start = all_server_t.min()
    window_start_ns = session_start + start_s * 1e9
    window_end_ns = session_start + end_s * 1e9

    fig, axes = plt.subplots(4, 1, figsize=(12, 10), sharex=True)
    panel_titles = [
        "Accel magnitude, raw (g)",
        "Accel magnitude, high-pass filtered (g) -- spec S4.2 fiducial",
        "Jerk magnitude, d(accel)/dt (g/s)",
        "Gyro magnitude (rad/s)",
    ]
    for ax, title in zip(axes, panel_titles):
        ax.set_title(title, fontsize=10, loc="left")
        ax.grid(True, alpha=0.3)

    any_plotted = False
    # Per role: the window-start device time (for the x-axis) and the parallel
    # (t_server_ns, t_rel) arrays (for approximating marker position -- see below).
    role_window_start_device_ns: dict[str, float] = {}
    role_t_server_masked: dict[str, np.ndarray] = {}
    role_t_rel: dict[str, np.ndarray] = {}
    for role, stream in sorted(streams.items()):
        # Window selection uses t_server_ns (the only reference shared across devices,
        # same as compute_correlation.py's coarse pairing). But t_server_ns is identical
        # for every sample within a batch (stamped once per ingested message), so it's
        # unusable as a plotting x-axis -- it collapses each batch's ~10 samples onto a
        # single x position, producing fake vertical zigzags. For the actual timeline,
        # use this role's own per-sample device clock instead, relative to the first
        # selected sample -- correct fine-grained spacing, at the cost of not being
        # cross-device-aligned (fine for visual shape inspection; the aligned numerical
        # comparison is compute_correlation.py's job, not this tool's).
        mask = (stream.t_server_ns >= window_start_ns) & (stream.t_server_ns <= window_end_ns)
        if not np.any(mask):
            continue
        any_plotted = True
        t_device_masked = stream.t_device_ns[mask]
        role_window_start_device_ns[role] = t_device_masked[0]
        t_rel = (t_device_masked - t_device_masked[0]) / 1e9
        role_t_server_masked[role] = stream.t_server_ns[mask]
        role_t_rel[role] = t_rel
        color = ROLE_COLORS.get(role, "#888888")

        raw_mag = np.linalg.norm(stream.accel[mask], axis=1) / GRAVITY
        filtered_mag = stream.A[mask] / GRAVITY
        jerk = compute_jerk(stream)[mask] / GRAVITY
        gyro_mag = stream.W[mask]

        axes[0].plot(t_rel, raw_mag, color=color, label=f"Phone {role}", linewidth=1)
        axes[1].plot(t_rel, filtered_mag, color=color, linewidth=1)
        axes[2].plot(t_rel, jerk, color=color, linewidth=1)
        axes[3].plot(t_rel, gyro_mag, color=color, linewidth=1)

    if not any_plotted:
        raise SystemExit("no samples fall inside the requested window")

    for marker in bump_markers:
        if not (window_start_ns <= marker["t_server_ns"] <= window_end_ns):
            continue
        # NOTE: bump_marker.t_device_ns is NOT usable here -- TelemetryClient stamps it
        # with JS Date.now() (wall-clock epoch), while sensor samples use Android's
        # elapsedRealtimeNanos() (time since boot). Those are unrelated clocks; naively
        # subtracting them produces a garbage multi-decade offset that blows out the
        # x-axis (this broke the first version of this plot -- see conversation/commit
        # history). The only clock a marker shares with the sensor stream is server
        # receipt time, so approximate its position by nearest-t_server_ns sample in
        # this role's own (already plotted) device-time axis -- coarse (batch-level,
        # ~100ms resolution) but not wrong. Fixing the marker's own clock at the source
        # (native elapsedRealtimeNanos instead of Date.now()) would give exact
        # positioning; tracked as a follow-up, not needed for this exploratory tool.
        marker_role = marker.get("device_role")
        if marker_role not in role_t_server_masked:
            continue
        idx = np.argmin(np.abs(role_t_server_masked[marker_role] - marker["t_server_ns"]))
        t_marker = role_t_rel[marker_role][idx]
        for ax in axes:
            ax.axvline(t_marker, color="#e53e3e", linestyle="--", linewidth=1, alpha=0.7)

    axes[0].legend(loc="upper right", fontsize=8)
    axes[-1].set_xlabel("time (s, relative to window start)")
    fig.tight_layout()

    out_path = args.out or args.session_file.with_name(
        f"{args.session_file.stem}_{start_s:.1f}-{end_s:.1f}s.png"
    )
    fig.savefig(out_path, dpi=120)
    print(f"saved: {out_path}")


if __name__ == "__main__":
    main()
