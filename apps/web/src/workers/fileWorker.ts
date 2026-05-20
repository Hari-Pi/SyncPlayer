/**
 * fileWorker.ts — Off-main-thread file chunker + FNV-1a hasher.
 *
 * The main thread posts a { type: "start", file, mediaId, chunkSize } message.
 * This worker reads the file in chunks, computes per-chunk FNV-1a checksums,
 * and posts each chunk back so the main thread can forward it over the P2P data channel.
 * Running off the main thread keeps the UI fully responsive during large transfers.
 */

// FNV-1a 64-bit — pure JS, no imports needed in the worker context
function fnv1aHash(data: Uint8Array): string {
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

function chunkChecksum(index: number, data: Uint8Array): string {
  const FNV_OFFSET = 14695981039346656037n;
  const FNV_PRIME = 1099511628211n;
  const MASK = 0xFFFFFFFFFFFFFFFFn;
  let hash = FNV_OFFSET;
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

type WorkerInMessage =
  | { type: "start"; file: File; mediaId: string; chunkSize: number }
  | { type: "cancel" };

export type WorkerOutMessage =
  | { type: "ready" }
  | { type: "chunk"; mediaId: string; index: number; total: number; data: number[]; checksum: string }
  | { type: "end"; mediaId: string; checksum: string }
  | { type: "error"; message: string }
  | { type: "progress"; index: number; total: number };

let cancelled = false;

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }

  if (msg.type !== "start") return;

  cancelled = false;
  const { file, mediaId, chunkSize } = msg;

  try {
    (self as unknown as Worker).postMessage({ type: "ready" } satisfies WorkerOutMessage);

    const total = Math.ceil(file.size / chunkSize);
    // We stream-hash the whole file for the final checksum using the same FNV algorithm
    // rather than accumulating all bytes (saves memory for large files).
    const FNV_OFFSET = 14695981039346656037n;
    const FNV_PRIME = 1099511628211n;
    const MASK = 0xFFFFFFFFFFFFFFFFn;
    let fileHash = FNV_OFFSET;

    for (let index = 0; index < total; index++) {
      if (cancelled) return;

      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const slice = file.slice(start, end);
      const buffer = await slice.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Update running whole-file hash
      for (const byte of bytes) {
        fileHash = (fileHash ^ BigInt(byte)) & MASK;
        fileHash = (fileHash * FNV_PRIME) & MASK;
      }

      const checksum = chunkChecksum(index, bytes);

      (self as unknown as Worker).postMessage({
        type: "chunk",
        mediaId,
        index,
        total,
        data: Array.from(bytes),
        checksum
      } satisfies WorkerOutMessage);

      // Progress report every 16 chunks (~1 MB at 64 KB chunk size)
      if (index % 16 === 0 || index === total - 1) {
        (self as unknown as Worker).postMessage({
          type: "progress",
          index,
          total
        } satisfies WorkerOutMessage);
      }
    }

    const fileChecksum = fileHash.toString(16).padStart(16, "0");

    (self as unknown as Worker).postMessage({
      type: "end",
      mediaId,
      checksum: fileChecksum
    } satisfies WorkerOutMessage);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : "Unknown file worker error"
    } satisfies WorkerOutMessage);
  }
};
