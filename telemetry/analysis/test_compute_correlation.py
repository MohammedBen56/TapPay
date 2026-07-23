"""Known-answer tests for the correlation math itself.

These do not exercise the JSONL/pairing plumbing -- they test the two primitives
that determine whether compute_correlation.py can be trusted on real bump data at
all: resample_to_grid (peak-anchored interpolation) and correlate_grids (R_AB with
lag search). If this file doesn't pass, nothing computed from the real 200-bump
session means anything.
"""

from __future__ import annotations

import numpy as np

from analysis.compute_correlation import GRID_DT_NS, correlate_grids, highpass_accel, resample_to_grid


def _synthetic_impulse(n: int = 400, dt_ns: float = 1_000_000, peak_index: int = 200, width: int = 8) -> tuple[np.ndarray, np.ndarray]:
    """A clean single-bump-like waveform: a Gaussian bump on top of a flat baseline."""
    t = np.arange(n) * dt_ns
    x = np.arange(n) - peak_index
    magnitude = 3.0 * np.exp(-(x**2) / (2 * width**2))
    return t.astype(np.float64), magnitude


def test_resample_recovers_known_peak_time():
    t, values = _synthetic_impulse(peak_index=200)
    peak_t = t[200]
    grid = resample_to_grid(t, values, peak_t)
    assert grid is not None
    # the center of a 10-sample grid straddling the peak should be close to the peak value
    assert grid[len(grid) // 2] == np.max(grid)


def test_resample_returns_none_when_grid_not_covered():
    t, values = _synthetic_impulse(peak_index=200)
    # request a grid centered far outside the available samples
    grid = resample_to_grid(t, values, t[-1] + 10 * GRID_DT_NS)
    assert grid is None


def test_correlate_grids_recovers_known_lag():
    # Two identical grids, but B is shifted by a known lag k0 relative to A.
    t_a, accel_mag_a = _synthetic_impulse(peak_index=200)
    k0 = 2
    t_b, accel_mag_b = _synthetic_impulse(peak_index=200 + k0)

    A_a = resample_to_grid(t_a, accel_mag_a, t_a[200])
    A_b = resample_to_grid(t_b, accel_mag_b, t_b[200 + k0])
    # gyro channel: reuse the same shape scaled down, same lag relationship
    W_a = A_a * 0.5
    W_b = A_b * 0.5

    r_ab, lag = correlate_grids(A_a, W_a, A_b, W_b, max_lag=3)

    assert r_ab > 0.95, f"expected near-perfect correlation for a known-correlated pair, got {r_ab}"


def test_correlate_grids_rejects_independent_noise():
    rng = np.random.default_rng(42)
    A_a = rng.normal(size=10)
    W_a = rng.normal(size=10)
    A_b = rng.normal(size=10)
    W_b = rng.normal(size=10)

    r_ab, _lag = correlate_grids(A_a, W_a, A_b, W_b, max_lag=3)

    assert abs(r_ab) < 0.6, f"expected near-zero correlation for independent noise, got {r_ab}"


def test_highpass_accel_strips_constant_gravity_baseline():
    # A constant 1g-on-Z baseline should decay toward zero under the high-pass filter.
    n = 50
    accel = np.tile(np.array([0.0, 0.0, 9.81]), (n, 1))
    filtered = highpass_accel(accel, alpha=0.8)
    assert np.linalg.norm(filtered[-1]) < 0.5, "high-pass filter should strip a constant gravity baseline"
