/**
 * fileWorker.ts — Off-main-thread file chunker + FNV-1a hasher.
 *
 * The main thread posts a { type: "start", file, mediaId, chunkSize } message.
 * This worker reads the file in chunks, computes per-chunk FNV-1a checksums,
 * and posts each chunk back so the main thread can forward it over the P2P data channel.
 */

import { chunkChecksum } from "@/lib/media/checksum";

type WorkerInMessage =
  | { type: "start"; file: File; mediaId: string; chunkSize: number; startChunkIndex: number; endChunkIndex: number; totalChunks: number }
  | { type: "cancel" };

export type WorkerOutMessage =
  | { type: "ready" }
  | { type: "chunk"; mediaId: string; index: number; total: number; data: Uint8Array; checksum: string }
  | { type: "worker_done"; mediaId: string; workerStartChunk: number }
  | { type: "error"; mediaId: string; error: string };

let canceled = false;

self.onmessage = async (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;

  if (msg.type === "cancel") {
    canceled = true;
    return;
  }

  if (msg.type === "start") {
    canceled = false;
    const { file, mediaId, chunkSize, startChunkIndex, endChunkIndex, totalChunks } = msg;

    try {
      for (let i = startChunkIndex; i < endChunkIndex; i++) {
        if (canceled) break;

        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const slice = file.slice(start, end);
        const buffer = await slice.arrayBuffer();
        const data = new Uint8Array(buffer);

        const cSum = chunkChecksum(i, data);

        // Send chunk back to main thread
        // We use transferables to avoid copying the buffer again
        (self as any).postMessage(
          {
            type: "chunk",
            mediaId,
            index: i,
            total: totalChunks,
            data,
            checksum: cSum
          } satisfies WorkerOutMessage,
          [data.buffer]
        );
      }

      if (!canceled) {
        (self as any).postMessage({
          type: "worker_done",
          mediaId,
          workerStartChunk: startChunkIndex
        } satisfies WorkerOutMessage);
      }
    } catch (err: any) {
      (self as any).postMessage({
        type: "error",
        mediaId,
        error: err?.message || String(err)
      } satisfies WorkerOutMessage);
    }
  }
};

// Signal main thread we are loaded
(self as any).postMessage({ type: "ready" } satisfies WorkerOutMessage);
