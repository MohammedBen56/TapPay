/**
 * Qualification-gate thresholds (spec S4.3). These are placeholders seeded from the
 * spec's baseline values -- NOT the final, tuned numbers. They exist so nothing in
 * the codebase hardcodes a bare number (CLAUDE.md S5: "thresholds live in config,
 * never hardcoded"). Update this file once the M0 200-bump session's real R_AB
 * distribution is in; see docs/M0_correlation_results.md for the analysis that
 * should drive the update.
 */

export interface SensorThresholds {
  /** Minimum BLE RSSI, in dBm, for a candidate peer to qualify. */
  rssiMinDbm: number;
  /** Maximum allowed difference between the two devices' corrected peak times, ms. */
  peakTimeDiffMaxMs: number;
  /** Maximum allowed relative difference between the two devices' accel peaks. */
  accelPeakDiffMaxRatio: number;
  /** Minimum peak gyro magnitude required on both devices, rad/s. */
  gyroMinRadPerSec: number;
  /** Minimum accel-cross-correlation R_AB for a qualifying bump. */
  rAbMin: number;
}

/**
 * Single baseline vs. per-device-class thresholds is exactly the M0 exit-gate
 * decision (Build Guide Phase 2 step 4). This starts as a single baseline; if the
 * real distribution shows the two phone models diverge, key this map by a
 * device-class identifier instead (e.g. model string) and update every call site
 * that reads `defaultThresholds`.
 */
export const defaultThresholds: SensorThresholds = {
  rssiMinDbm: -70,
  peakTimeDiffMaxMs: 100,
  accelPeakDiffMaxRatio: 0.4,
  gyroMinRadPerSec: 1.5,
  rAbMin: 0.8,
};
