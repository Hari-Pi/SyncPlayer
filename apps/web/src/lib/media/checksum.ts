/**
 * Shared FNV-1a 64-bit hashing used for file-transfer integrity checks.
 * Used by both the sender (fileWorker, off the main thread) and the
 * receiver (App.tsx, verifying what actually arrived).
 */

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK = 0xffffffffffffffffn;

export function fnv1aHash(data: Uint8Array): string {
  let hash = FNV_OFFSET;
  for (const byte of data) {
    hash = (hash ^ BigInt(byte)) & MASK;
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Per-chunk checksum: hashes the chunk index alongside its bytes so a chunk
 * delivered into the wrong slot (or duplicated from a different index) still
 * gets caught. */
export function chunkChecksum(index: number, data: Uint8Array): string {
  const indexBytes = new Uint8Array(new Uint32Array([index]).buffer);
  const combined = new Uint8Array(indexBytes.length + data.length);
  combined.set(indexBytes, 0);
  combined.set(data, indexBytes.length);
  return fnv1aHash(combined);
}

/**
 * Cheap "did the receiver end up with the exact same set of chunks the
 * sender produced" check. Combines already-computed per-chunk checksums
 * (short hex strings) rather than re-hashing the whole file's raw bytes, so
 * it's practically free even for large transfers, and it catches duplicate,
 * missing, or corrupted chunks — the failure modes that actually matter here
 * (WebRTC's DTLS/SCTP transport already guards against raw bit corruption in
 * transit; this is meant to catch application-level bugs).
 */
export function combineChecksums(checksumsByIndex: Map<number, string>, totalChunks: number): string {
  const parts: string[] = new Array(totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    parts[i] = checksumsByIndex.get(i) ?? "missing";
  }
  return fnv1aHash(new TextEncoder().encode(parts.join(",")));
}

/** Encode a set of chunk indices as sorted, non-overlapping inclusive ranges. */
export function indicesToRanges(indices: Iterable<number>): Array<[number, number]> {
  const sorted = Array.from(indices).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];

  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && index === last[1] + 1) {
      last[1] = index;
    } else {
      ranges.push([index, index]);
    }
  }

  return ranges;
}

export function rangesInclude(ranges: Array<[number, number]>, index: number): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index <= end) return true;
  }
  return false;
}
