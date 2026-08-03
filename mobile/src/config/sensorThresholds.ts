/**
 * Qualification-gate thresholds (spec S4.3). Most fields here are still placeholders
 * seeded from the spec's baseline values -- NOT tuned numbers. They exist so nothing
 * in the codebase hardcodes a bare number (CLAUDE.md S5: "thresholds live in config,
 * never hardcoded").
 *
 * `peakAccelMinG` is the one field that IS real, data-derived, per-device: from
 * telemetry/analysis/bump_separability.py run against a real 20-bump session
 * (telemetry/data/1.jsonl), a single feature -- peak high-pass-filtered accel
 * magnitude -- gave 100% separation between real bumps and 48 sampled non-bump
 * windows from that same session. The two calibrated devices below came out with
 * meaningfully different thresholds (nearly 2x apart), confirming per-device-class
 * thresholds aren't a hypothetical future need -- they're already required. See that
 * script's docstring for why this stayed a plain numpy threshold sweep instead of a
 * trained model, and why device weight/size don't explain the gap well enough to
 * extrapolate a formula from (mass ratio ~1.35x vs. observed threshold ratio
 * ~2.06x -- the remaining gap is most likely accelerometer hardware/calibration
 * differences between the two device tiers, not something in a public spec sheet).
 *
 * Everything else here is still the untouched spec S4.3 baseline, pending the full
 * M0 200-bump varied-condition session; see docs/M0_correlation_results.md.
 */

/** Recursive high-pass filter coefficient (spec S4.2):
 * filtered[n] = alpha * (filtered[n-1] + raw[n] - raw[n-1]).
 * Shared between telemetry/analysis/compute_correlation.py (offline) and the
 * on-device live detector (TelemetryScreen.tsx) -- the peakAccelMinG values above
 * were calibrated against THIS alpha; changing it without recalibrating silently
 * invalidates those numbers. */
export const HIGH_PASS_ALPHA = 0.8;

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
  /** Minimum peak high-pass-filtered accel magnitude (g) for a candidate bump on
   * THIS device. The one calibrated-per-device-model field -- see deviceThresholds. */
  peakAccelMinG: number;
}

const FALLBACK: SensorThresholds = {
  rssiMinDbm: -70,
  peakTimeDiffMaxMs: 100,
  accelPeakDiffMaxRatio: 0.4,
  gyroMinRadPerSec: 1.5,
  rAbMin: 0.8,
  // Roughly between the two calibrated devices below -- an uncalibrated guess, not
  // a derived value. Any device hitting this fallback should get a real calibration
  // pass added to deviceThresholds rather than being left on this indefinitely.
  peakAccelMinG: 2.5,
};

/**
 * Keyed by Platform.constants.Model on Android (Build.MODEL, e.g. "SM-S928B") --
 * see getThresholdsForDevice. Add an entry here once a device has its own real
 * bump_separability.py calibration; everything else in the row still comes from
 * FALLBACK until it's recalibrated too.
 */
const deviceThresholds: Record<string, SensorThresholds> = {
  'SM-S928B': { ...FALLBACK, peakAccelMinG: 1.92 }, // Galaxy S24 Ultra
  'SM-A515F': { ...FALLBACK, peakAccelMinG: 3.95 }, // Galaxy A51
};

/** `modelName` should come from `Platform.constants.Model` (Android only; the
 * caller is responsible for the Platform.OS check, this module has no RN
 * dependency of its own). Falls back to FALLBACK for any unrecognized or
 * missing model rather than throwing -- an uncalibrated device should still
 * run, just with an honestly-labeled, not-yet-tuned threshold. */
export function getThresholdsForDevice(modelName: string | null | undefined): SensorThresholds {
  if (modelName && modelName in deviceThresholds) {
    return deviceThresholds[modelName]!;
  }
  return FALLBACK;
}

/** @deprecated Prefer getThresholdsForDevice() so device-specific calibration (see
 * peakAccelMinG above) is actually used. Kept only as the pre-calibration fallback. */
export const defaultThresholds: SensorThresholds = FALLBACK;
