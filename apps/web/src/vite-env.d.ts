/// <reference types="vite/client" />

declare module "@sync-core-wasm" {
  export default function init(input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module): Promise<void>;
  export function drift_ms(localPositionSecs: number, hostPositionSecs: number, latencyMs: number): number;
  export function correction_mode(localPositionSecs: number, hostPositionSecs: number, latencyMs: number): string;
  export function suggested_rate(localPositionSecs: number, hostPositionSecs: number, latencyMs: number): number;
  export function media_identity_hint(sizeBytes: number, durationSecs: number, modifiedMs: number): string;
}

