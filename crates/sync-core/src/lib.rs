use wasm_bindgen::prelude::*;

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

