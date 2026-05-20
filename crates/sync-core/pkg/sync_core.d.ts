/* tslint:disable */
/* eslint-disable */

export function correction_mode(local_position_secs: number, host_position_secs: number, latency_ms: number): string;

export function drift_ms(local_position_secs: number, host_position_secs: number, latency_ms: number): number;

export function media_identity_hint(size_bytes: number, duration_secs: number, modified_ms: number): string;

export function suggested_rate(local_position_secs: number, host_position_secs: number, latency_ms: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly correction_mode: (a: number, b: number, c: number) => [number, number];
    readonly drift_ms: (a: number, b: number, c: number) => number;
    readonly media_identity_hint: (a: number, b: number, c: number) => [number, number];
    readonly suggested_rate: (a: number, b: number, c: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
