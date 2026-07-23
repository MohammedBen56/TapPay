"""Builds the JSON payload consumed by the interactive Plotly session viewer
(telemetry/app/main.py's /sessions/{session_id} route). Shares all math with
compute_correlation.py / plot_session.py -- no logic duplicated in JS.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from analysis.compute_correlation import RoleStream, compute_jerk, load_session

GRAVITY = 9.80665


def list_sessions(data_dir: Path) -> list[dict]:
    """Lightweight per-file summary for the /sessions index -- avoids the numpy/jerk
    work build_payload does, since that's wasted for every file just to list them.
    """
    sessions = []
    for path in sorted(data_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        roles: set[str] = set()
        marker_count = 0
        sample_count = 0
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                role = record.get("device_role")
                if role:
                    roles.add(role)
                if record.get("type") == "bump_marker":
                    marker_count += 1
                elif record.get("type") == "sensor_batch":
                    sample_count += len(record.get("samples", []))
        sessions.append(
            {
                "session_id": path.stem,
                "roles": sorted(roles),
                "marker_count": marker_count,
                "sample_count": sample_count,
                "size_bytes": path.stat().st_size,
                "mtime": path.stat().st_mtime,
            }
        )
    return sessions


def _role_payload(stream: RoleStream) -> dict:
    t_rel_s = ((stream.t_device_ns - stream.t_device_ns[0]) / 1e9).tolist()
    return {
        "t_rel_s": t_rel_s,
        "raw_accel_g": (np.linalg.norm(stream.accel, axis=1) / GRAVITY).tolist(),
        "filtered_accel_g": (stream.A / GRAVITY).tolist(),
        "jerk_g_s": (compute_jerk(stream) / GRAVITY).tolist(),
        "gyro_rad_s": stream.W.tolist(),
        "mag_ut": np.linalg.norm(stream.mag, axis=1).tolist(),
    }


def build_payload(session_file: Path) -> dict:
    streams, bump_markers = load_session(session_file)

    roles: dict[str, dict] = {role: _role_payload(stream) for role, stream in sorted(streams.items())}

    markers = []
    for marker in bump_markers:
        role = marker.get("device_role")
        stream = streams.get(role)
        if stream is None:
            continue
        # Same caveat as plot_session.py: marker.t_device_ns uses a different clock
        # (JS Date.now()) than the sensor stream's elapsedRealtimeNanos(), so position
        # via nearest t_server_ns match instead of trusting the marker's own device_ns.
        idx = int(np.argmin(np.abs(stream.t_server_ns - marker["t_server_ns"])))
        t_rel_s = roles[role]["t_rel_s"][idx]
        markers.append({"role": role, "t_rel_s": t_rel_s, "tag": marker.get("tag", {})})

    return {
        "session_id": session_file.stem,
        "roles": roles,
        "markers": markers,
    }
