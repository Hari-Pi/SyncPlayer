use wasm_bindgen::prelude::*;

// ─── Playback Sync ─────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub fn drift_ms(local_position_secs: f64, host_position_secs: f64, latency_ms: f64) -> f64 {
    let estimated_host = host_position_secs + (latency_ms.max(0.0) / 1000.0);
    (estimated_host - local_position_secs) * 1000.0
}

#[wasm_bindgen]
pub fn correction_mode(local_position_secs: f64, host_position_secs: f64, latency_ms: f64) -> String {
    let drift = drift_ms(local_position_secs, host_position_secs, latency_ms).abs();

    if drift < 80.0 {
        "hold".to_string()
    } else if drift < 300.0 {
        "soft".to_string()
    } else if drift < 1000.0 {
        "firm".to_string()
    } else {
        "seek".to_string()
    }
}

#[wasm_bindgen]
pub fn suggested_rate(local_position_secs: f64, host_position_secs: f64, latency_ms: f64) -> f64 {
    let drift = drift_ms(local_position_secs, host_position_secs, latency_ms);

    if drift.abs() < 80.0 {
        1.0
    } else if drift > 0.0 {
        1.04
    } else {
        0.96
    }
}

#[wasm_bindgen]
pub fn media_identity_hint(size_bytes: f64, duration_secs: f64, modified_ms: f64) -> String {
    let size = size_bytes.max(0.0) as u64;
    let duration = (duration_secs.max(0.0) * 1000.0) as u64;
    let modified = modified_ms.max(0.0) as u64;
    let mixed = size.rotate_left(13) ^ duration.rotate_left(7) ^ modified.rotate_left(3);

    format!("{mixed:016x}")
}

/// Snap a playback position to the nearest frame boundary for the given frame rate.
/// Prevents sub-frame drift oscillation when the host and guest clocks fight over
/// fractions of a millisecond.
#[wasm_bindgen]
pub fn quantise_position(position_secs: f64, fps: f64) -> f64 {
    if fps <= 0.0 {
        return position_secs;
    }
    let frame_duration = 1.0 / fps;
    (position_secs / frame_duration).round() * frame_duration
}

/// Exponentially weighted moving average of RTT latency samples.
/// Alpha = 0.25 (new sample weight). Smooths jitter from bursty network conditions.
/// Pass a JS Float64Array (as &[f64]) of recent RTT samples (newest last).
#[wasm_bindgen]
pub fn interpolate_latency(samples: &[f64]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    const ALPHA: f64 = 0.25;
    let mut ema = samples[0];
    for &sample in &samples[1..] {
        ema = ALPHA * sample + (1.0 - ALPHA) * ema;
    }
    ema
}

// ─── File Transfer Integrity ────────────────────────────────────────────────────

/// FNV-1a 64-bit hash of a byte slice. Fast, non-cryptographic, zero-alloc.
/// Used to verify file chunk integrity and final file checksum over P2P.
#[wasm_bindgen]
pub fn fnv1a_hash(data: &[u8]) -> String {
    const FNV_OFFSET: u64 = 14695981039346656037;
    const FNV_PRIME: u64 = 1099511628211;

    let mut hash = FNV_OFFSET;
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

/// Per-chunk checksum: FNV-1a of (chunk_index_bytes ++ chunk_data).
/// Lets the receiver verify each chunk independently before appending to MSE/blob.
#[wasm_bindgen]
pub fn chunk_checksum(index: u32, data: &[u8]) -> String {
    const FNV_OFFSET: u64 = 14695981039346656037;
    const FNV_PRIME: u64 = 1099511628211;

    let mut hash = FNV_OFFSET;
    // Mix in the chunk index bytes first for domain separation
    for &byte in &index.to_le_bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    for &byte in data {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}
