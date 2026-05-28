/* tslint:disable */
/* eslint-disable */

/**
 * Per-chunk checksum: FNV-1a of (chunk_index_bytes ++ chunk_data).
 * Lets the receiver verify each chunk independently before appending to MSE/blob.
 */
export function chunk_checksum(index: number, data: Uint8Array): string;

export function correction_mode(local_position_secs: number, host_position_secs: number, latency_ms: number): string;

export function drift_ms(local_position_secs: number, host_position_secs: number, latency_ms: number): number;

/**
 * FNV-1a 64-bit hash of a byte slice. Fast, non-cryptographic, zero-alloc.
 * Used to verify file chunk integrity and final file checksum over P2P.
 */
export function fnv1a_hash(data: Uint8Array): string;

/**
 * Exponentially weighted moving average of RTT latency samples.
 * Alpha = 0.25 (new sample weight). Smooths jitter from bursty network conditions.
 * Pass a JS Float64Array (as &[f64]) of recent RTT samples (newest last).
 */
export function interpolate_latency(samples: Float64Array): number;

export function media_identity_hint(size_bytes: number, duration_secs: number, modified_ms: number): string;

/**
 * Snap a playback position to the nearest frame boundary for the given frame rate.
 * Prevents sub-frame drift oscillation when the host and guest clocks fight over
 * fractions of a millisecond.
 */
export function quantise_position(position_secs: number, fps: number): number;

export function suggested_rate(local_position_secs: number, host_position_secs: number, latency_ms: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly chunk_checksum: (a: number, b: number, c: number) => [number, number];
    readonly correction_mode: (a: number, b: number, c: number) => [number, number];
    readonly drift_ms: (a: number, b: number, c: number) => number;
    readonly fnv1a_hash: (a: number, b: number) => [number, number];
    readonly interpolate_latency: (a: number, b: number) => number;
    readonly media_identity_hint: (a: number, b: number, c: number) => [number, number];
    readonly quantise_position: (a: number, b: number) => number;
    readonly suggested_rate: (a: number, b: number, c: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
