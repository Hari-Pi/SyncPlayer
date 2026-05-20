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

