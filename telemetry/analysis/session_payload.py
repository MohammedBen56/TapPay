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
        detection_count = 0
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
                elif record.get("type") == "bump_detected":
                    detection_count += 1
                elif record.get("type") == "sensor_batch":
                    sample_count += len(record.get("samples", []))
        sessions.append(
            {
                "session_id": path.stem,
                "roles": sorted(roles),
                "marker_count": marker_count,
                "detection_count": detection_count,
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


def _position_by_nearest_t_server(records: list[dict], streams: dict[str, RoleStream], roles: dict[str, dict]) -> list[dict]:
    """Shared positioning logic for both bump_marker and bump_detected records: each
    carries its own t_device_ns, but on a different, unrelated clock (JS Date.now()
    for markers, also Date.now() for detections -- see TelemetryClient.sendBumpMarker
    / sendBumpDetected) than the sensor stream's device clock. Position via nearest
    t_server_ns match instead, same as plot_session.py.
    """
    positioned = []
    for record in records:
        role = record.get("device_role")
        stream = streams.get(role)
        if stream is None:
            continue
        idx = int(np.argmin(np.abs(stream.t_server_ns - record["t_server_ns"])))
        t_rel_s = roles[role]["t_rel_s"][idx]
        positioned.append({"role": role, "t_rel_s": t_rel_s, "record": record})
    return positioned


def build_payload(session_file: Path) -> dict:
    streams, bump_markers, bump_detections = load_session(session_file)

    roles: dict[str, dict] = {role: _role_payload(stream) for role, stream in sorted(streams.items())}

    markers = [
        {"role": p["role"], "t_rel_s": p["t_rel_s"], "tag": p["record"].get("tag", {})}
        for p in _position_by_nearest_t_server(bump_markers, streams, roles)
    ]
    detections = [
        {
            "role": p["role"],
            "t_rel_s": p["t_rel_s"],
            "peak_g": p["record"].get("peak_g"),
            "threshold_g": p["record"].get("threshold_g"),
        }
        for p in _position_by_nearest_t_server(bump_detections, streams, roles)
    ]

    return {
        "session_id": session_file.stem,
        "roles": roles,
        "markers": markers,
        "detections": detections,
    }
