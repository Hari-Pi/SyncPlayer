import init, {
  correction_mode,
  drift_ms,
  media_identity_hint,
  suggested_rate
} from "@sync-core-wasm";

let initPromise: Promise<void> | null = null;

export type DriftReading = {
  driftMs: number;
  mode: "hold" | "soft" | "firm" | "seek";
  rate: number;
};

export function loadSyncCore() {
  initPromise ??= init();
  return initPromise;
}

export async function readDrift(localPositionSecs: number, hostPositionSecs: number, latencyMs: number): Promise<DriftReading> {
  await loadSyncCore();

  return {
    driftMs: drift_ms(localPositionSecs, hostPositionSecs, latencyMs),
    mode: correction_mode(localPositionSecs, hostPositionSecs, latencyMs) as DriftReading["mode"],
    rate: suggested_rate(localPositionSecs, hostPositionSecs, latencyMs)
  };
}

export async function createMediaHint(sizeBytes: number, durationSecs: number, modifiedMs: number) {
  await loadSyncCore();
  return media_identity_hint(sizeBytes, durationSecs, modifiedMs);
}

// ─── Extended functions implemented in JS (WASM equivalents) ────────────────
// These match the Rust implementations exactly. When Cargo/wasm-pack is
// available the Rust versions should be swapped in for even faster execution.

/** Snap a position to the nearest frame boundary. Prevents sub-frame drift fights. */
export function quantisePositionSync(positionSecs: number, fps: number): number {
  if (fps <= 0) return positionSecs;
  const frameDuration = 1 / fps;
  return Math.round(positionSecs / frameDuration) * frameDuration;
}

/**
 * EWMA smoothed latency over a rolling sample window.
 * Alpha=0.25 matches the Rust implementation.
 */
export function smoothLatencySync(samples: number[]): number {
  if (samples.length === 0) return 0;
  const ALPHA = 0.25;
  let ema = samples[0];
  for (let i = 1; i < samples.length; i++) {
    ema = ALPHA * samples[i] + (1 - ALPHA) * ema;
  }
  return ema;
}

/**
 * FNV-1a 64-bit hash — JS BigInt implementation, matches Rust exactly.
 * Returns a 16-char lowercase hex string.
 */
export function fnv1aHashSync(data: Uint8Array): string {
  const FNV_OFFSET = 14695981039346656037n;
  const FNV_PRIME = 1099511628211n;
  const MASK = 0xFFFFFFFFFFFFFFFFn;
  let hash = FNV_OFFSET;
  for (const byte of data) {
    hash = (hash ^ BigInt(byte)) & MASK;
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Per-chunk checksum: FNV-1a of (index_le_bytes ++ data). Matches Rust exactly.
 */
export function chunkChecksumSync(index: number, data: Uint8Array): string {
  const FNV_OFFSET = 14695981039346656037n;
  const FNV_PRIME = 1099511628211n;
  const MASK = 0xFFFFFFFFFFFFFFFFn;
  let hash = FNV_OFFSET;
  // Mix in 4 little-endian index bytes
  const indexBytes = new Uint8Array(new Uint32Array([index]).buffer);
  for (const byte of indexBytes) {
    hash = (hash ^ BigInt(byte)) & MASK;
    hash = (hash * FNV_PRIME) & MASK;
  }
  for (const byte of data) {
    hash = (hash ^ BigInt(byte)) & MASK;
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
