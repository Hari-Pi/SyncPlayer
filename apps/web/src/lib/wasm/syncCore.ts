import { fnv1aHash } from "@/lib/media/checksum";

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

  return fnv1aHash(data) + fnv1aHash(new Uint8Array([...data].reverse()));
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
