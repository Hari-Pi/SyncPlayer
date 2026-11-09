import type { DriftReading } from "@/lib/wasm/syncCore";

// Drift magnitude thresholds (milliseconds). Drive the meter's mode/tone and
// the actual correction applied to guests: soft/firm nudge playbackRate, seek
// for large drift.
const DRIFT_HOLD_MS = 40;
const DRIFT_SOFT_MS = 150;
const DRIFT_FIRM_MS = 500;
const SOFT_RATE = 0.05;
const FIRM_RATE = 0.1;

// A guest that's behind the host and needs to speed up to catch back
// up will burn through its buffer faster — if the buffer ahead is already
// thin, that's exactly what causes a stall, which then triggers another
// correction (the "endless catching" problem). Below this many seconds of
// buffer ahead, we hold instead of speeding up and let the buffer refill.
const MIN_SAFE_BUFFER_SECS = 1.5;


/** Seconds of buffered media ahead of the element's current playback position. */
export function getBufferedAheadSecs(element: HTMLMediaElement): number {
  const { buffered, currentTime } = element;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
      return buffered.end(i) - currentTime;
    }
  }
  return 0;
}

// Compute a DriftReading from the signed offset between local currentTime and
// the remote target position (both in seconds). Returns the correction
// multiplier relative to the host rate — applied to guests each tick.
export function readDrift(driftSecs: number, hostRate: number, bufferedAheadSecs: number): DriftReading {
  const driftMs = driftSecs * 1000;
  const abs = Math.abs(driftMs);

  if (abs < DRIFT_HOLD_MS) {
    return { driftMs, mode: "hold", rate: hostRate };
  }

  // Negative drift means we're behind the target and would need to speed up.
  const needsSpeedUp = driftMs < 0;
  if (needsSpeedUp && bufferedAheadSecs < MIN_SAFE_BUFFER_SECS && abs < DRIFT_FIRM_MS) {
    return { driftMs, mode: "hold", rate: hostRate };
  }

  if (abs < DRIFT_SOFT_MS) {
    return { driftMs, mode: "soft", rate: hostRate * (driftMs > 0 ? 1 - SOFT_RATE : 1 + SOFT_RATE) };
  }
  if (abs < DRIFT_FIRM_MS) {
    return { driftMs, mode: "firm", rate: hostRate * (driftMs > 0 ? 1 - FIRM_RATE : 1 + FIRM_RATE) };
  }
  return { driftMs, mode: "seek", rate: hostRate };
}

// ─── Predictive seeking ────────────────────────────────────────────────────────
// A seek isn't instant: the player has to decode from the previous keyframe and rebuffer (the
// spinner). Seeking to where the host is *now* lands behind by that much, which can trigger
// another seek — a catch-up loop. So we measure how long seeks take on this device and aim
// where the host will be once the seek completes.
export const SEEK_COST_DEFAULT_SECS = 0.3;
export const SEEK_COST_MAX_SECS = 3;

/** Where to seek so playback resumes level with the host. */
export function predictSeekTarget(hostTarget: number, hostRate: number, hostPaused: boolean, seekCostSecs: number): number {
  return hostPaused ? hostTarget : hostTarget + seekCostSecs * hostRate;
}

/** Fold a measured seek duration (seconds) into the running estimate. */
export function updateSeekCost(previousSecs: number, measuredSecs: number): number {
  const measured = Math.min(Math.max(measuredSecs, 0), SEEK_COST_MAX_SECS);
  return previousSecs * 0.5 + measured * 0.5;
}
