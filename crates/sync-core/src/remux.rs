use std::io::{Read, Seek, SeekFrom};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    pub type JsFileReader;

    #[wasm_bindgen(method)]
    pub fn read_sync(this: &JsFileReader, offset: f64, len: f64) -> js_sys::Uint8Array;
    
    #[wasm_bindgen(method)]
    pub fn size(this: &JsFileReader) -> f64;
}

pub struct SyncFileReader {
    reader: JsFileReader,
    pos: u64,
}

impl SyncFileReader {
    pub fn new(reader: JsFileReader) -> Self {
        Self { reader, pos: 0 }
    }
}

impl Read for SyncFileReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let max_len = (self.reader.size() as u64 - self.pos) as usize;
        let len = buf.len().min(max_len);
        if len == 0 {
            return Ok(0);
        }
        let arr = self.reader.read_sync(self.pos as f64, len as f64);
        let bytes = arr.to_vec();
        buf[..len].copy_from_slice(&bytes[..len]);
        self.pos += len as u64;
        Ok(len)
    }
}

impl Seek for SyncFileReader {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let new_pos = match pos {
            SeekFrom::Start(p) => p,
            SeekFrom::End(p) => (self.reader.size() as i64 + p) as u64,
            SeekFrom::Current(p) => (self.pos as i64 + p) as u64,
        };
        self.pos = new_pos;
        Ok(self.pos)
    }
}

#[wasm_bindgen]
pub struct RemuxSession {
    reader: mp4::Mp4Reader<SyncFileReader>,
}

#[wasm_bindgen]
impl RemuxSession {
    #[wasm_bindgen(constructor)]
    pub fn new(js_reader: JsFileReader) -> Result<RemuxSession, JsValue> {
        let size = js_reader.size() as u64;
        let reader = SyncFileReader::new(js_reader);
        
        let mp4_reader = mp4::Mp4Reader::read_header(reader, size)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse MP4: {}", e)))?;
            
        Ok(RemuxSession {
            reader: mp4_reader,
        })
    }

    pub fn get_tracks(&self) -> String {
        format!("Tracks: {}", self.reader.tracks().len())
    }
}
