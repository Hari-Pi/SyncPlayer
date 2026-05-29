export type DriftReading = {
  driftMs: number;
  mode: "hold" | "soft" | "firm" | "seek";
  rate: number;
};

/**
 * Creates a unique 32-character hex identity hint for a media file based on its size, duration, and modified time.
 */
export async function createMediaHint(sizeBytes: number, durationSecs: number, modifiedMs: number): Promise<string> {
  const data = new Uint8Array(24);
  const view = new DataView(data.buffer);
  
  view.setFloat64(0, sizeBytes, true);
  view.setFloat64(8, durationSecs, true);
  view.setFloat64(16, modifiedMs, true);

  return fnv1aHashSync(data) + fnv1aHashSync(new Uint8Array([...data].reverse()));
}

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
 * FNV-1a 64-bit hash — JS BigInt implementation.
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
 * Per-chunk checksum: FNV-1a of (index_le_bytes ++ data).
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
