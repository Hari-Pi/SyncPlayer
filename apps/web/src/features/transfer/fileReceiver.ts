import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { chunkChecksum, combineChecksums, indicesToRanges } from "@/lib/media/checksum";
import { inferMediaKind, type LoadedMedia, type MediaFormat, type MediaKind } from "@/lib/media/mediaTypes";
import { CHUNK_SIZE, type FileMeta } from "@/lib/webrtc/messages";
import { formatBytes } from "@/lib/time/format";
import type { FileStreamHandlers, usePeerRoom } from "@/features/room/usePeerRoom";
import type { ActivityLevel } from "@/features/activity-log/activityLog";

// Without OPFS the whole file lives in RAM on the viewer; refuse above this size.
const MEMORY_FALLBACK_MAX_BYTES = 1024 * 1024 * 1024;
// How many times a viewer asks the host to re-send missing/corrupt chunks before giving up.
const MAX_CHUNK_RETRIES = 3;
// After file.end, give chunks still in flight on the other channels this long before declaring any missing.
const END_GRACE_MS = 3000;

/**
 * Guest-side state for one incoming file transfer's OPFS write session.
 * Lives in a ref (activeFileWriteRef) rather than a closure-local variable so
 * a repeat "file.meta" for the same mediaId — e.g. the host re-streaming to a
 * peer that just reconnected — can detect and resume it instead of tearing
 * down and re-downloading everything from scratch.
 */
export type ActiveFileWrite = {
  mediaId: string;
  fileName: string;
  mimeType: string;
  totalChunks: number;
  kind: MediaKind;
  format: MediaFormat;
  storageMode: "pending" | "opfs" | "memory";
  opfsFileName: string;
  opfsFileHandle: FileSystemFileHandle | null;
  writableStream: ChunkSink | null;
  memoryChunks: Map<number, ArrayBuffer>;
  /** Settles when every chunk handed over so far has been stored (or failed). */
  writeQueue: Promise<void>;
  /** Settles once the storage backend (worker, stream or memory) has been chosen. */
  sinkReady: Promise<void>;
  receivedIndices: Set<number>;
  chunkChecksums: Map<number, string>;
  pendingHostChecksum: string | null;
  endReceived: boolean;
  finalized: boolean;
  aborted: boolean;
  /** How many times we have asked the host to re-send missing/corrupt chunks. */
  retries: number;
  /** performance.now() of the most recent chunk to arrive (for the post-end quiet-period check). */
  lastChunkAt: number;
  /** Chunks that arrived but are still queued for writing (received != saved for big files). */
  pendingWrites: number;
};

/** Where received chunks go: verified, then written at their slot. */
export type ChunkSink = {
  /** Resolves false if the chunk failed verification (it is then not written). */
  store(index: number, data: ArrayBuffer, checksum: string): Promise<boolean>;
  close(): Promise<void>;
};

/** Default: a worker verifies and writes via a sync access handle; many chunks in flight at once. */
async function openWorkerSink(name: string): Promise<ChunkSink> {
  const worker = new Worker(new URL("../../workers/opfsWriter.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (ok: boolean) => void; reject: (err: Error) => void }>();
  let nextId = 0;
  const failAll = (err: Error) => {
    pending.forEach((p) => p.reject(err));
    pending.clear();
  };
  worker.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; error?: string }>) => {
    const request = pending.get(e.data.id);
    if (!request) return;
    pending.delete(e.data.id);
    if (e.data.error) request.reject(new Error(e.data.error));
    else request.resolve(!!e.data.ok);
  };
  worker.onerror = (e) => failAll(new Error(e.message || "file writer worker crashed"));
  const request = (message: Record<string, unknown>, transfer: Transferable[] = []) =>
    new Promise<boolean>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id }, transfer);
    });

  try {
    await request({ type: "open", name });
  } catch (err) {
    worker.terminate();
    throw err;
  }
  return {
    store: (index, data, checksum) => request({ type: "store", index, position: index * CHUNK_SIZE, data, checksum }, [data]),
    close: async () => {
      try {
        await request({ type: "close" });
      } finally {
        worker.terminate();
      }
    }
  };
}

/** Fallback: main-thread createWritable stream. Verifies here; writes are serialized. */
function streamSink(stream: FileSystemWritableFileStream): ChunkSink {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    store: (index, data, checksum) => {
      if (chunkChecksum(index, new Uint8Array(data)) !== checksum) return Promise.resolve(false);
      const written = tail.then(() => stream.write({ type: "write", position: index * CHUNK_SIZE, data }));
      tail = written.catch(() => undefined);
      return written.then(() => true);
    },
    close: () => tail.then(() => stream.close())
  };
}

export type FileReceiverDeps = {
  log: (level: ActivityLevel, label: string, detail: string) => void;
  cleanupOpfsFile: () => void;
  roomRef: MutableRefObject<ReturnType<typeof usePeerRoom> | null>;
  activeFileWriteRef: MutableRefObject<ActiveFileWrite | null>;
  opfsFileHandleRef: MutableRefObject<FileSystemFileHandle | null>;
  opfsFileNameRef: MutableRefObject<string | null>;
  guestFileRef: MutableRefObject<File | null>;
  staleBlobUrlRef: MutableRefObject<string | null>;
  setGuestStreamMeta: Dispatch<SetStateAction<FileMeta | null>>;
  /** What the receiver is doing after the last chunk arrived (null while still receiving or once done). */
  setReceiveStage: Dispatch<SetStateAction<string | null>>;
  setGuestStreamUrl: Dispatch<SetStateAction<string | null>>;
  setMedia: Dispatch<SetStateAction<LoadedMedia | null>>;
};

/**
 * Guest-side receiver for a host's file stream. Returns the `onFileStream` callback for
 * usePeerRoom: given a file.meta it sets up (or resumes) an OPFS write session and returns
 * the chunk/end/abort handlers. Chunks are verified, written at their byte offset, and
 * missing/corrupt ones are re-requested from the host.
 */
export function createFileReceiver(deps: FileReceiverDeps) {
  const {
    log, cleanupOpfsFile, roomRef, activeFileWriteRef, opfsFileHandleRef, opfsFileNameRef,
    guestFileRef, staleBlobUrlRef, setGuestStreamMeta, setReceiveStage, setGuestStreamUrl, setMedia
  } = deps;

  return (meta: FileMeta): FileStreamHandlers => {
    const existing = activeFileWriteRef.current;
    const isSameMedia = !!existing && existing.mediaId === meta.mediaId && !existing.aborted;

    // We already have the whole file and it's mounted (e.g. a redundant
    // late-join re-send, or reconnecting shortly after finishing). Don't
    // wipe a completed download and restart from zero — just tell the host
    // we have everything and leave our existing state alone.
    if (isSameMedia && existing!.finalized) {
      const write = existing!;
      log("info", "FILE", `Already have "${meta.fileName}" complete — telling the host to skip re-sending it.`);
      roomRef.current?.sendFileResume(meta.mediaId, [[0, write.totalChunks - 1]]);
      return {
        alreadyReceivedCount: write.totalChunks,
        onChunk: () => { /* host shouldn't send anything, but ignore harmlessly if it does */ },
        onEnd: () => { /* already finalized */ },
        onAbort: () => { /* nothing in flight to abort */ }
      };
    }

    const isResume = isSameMedia && !existing!.finalized;

    let write: ActiveFileWrite;

    if (isResume) {
      write = existing!;
      setGuestStreamMeta(meta);
      setReceiveStage(null);
      log(
        "info",
        "FILE",
        `Resuming "${meta.fileName}" — already have ${write.receivedIndices.size}/${meta.totalChunks} chunks, requesting the rest.`
      );
    } else {
      cleanupOpfsFile();
      setGuestStreamUrl((previousUrl) => {
        if (previousUrl) {
          staleBlobUrlRef.current = previousUrl;
        }
        return null;
      });
      setGuestStreamMeta(meta);
      setReceiveStage(null);
      log("info", "FILE", `Receiving "${meta.fileName}" (${(meta.fileSize / 1024 / 1024).toFixed(1)} MB) from host...`);

      const opfsFileName = `syncplayer-transfer-${meta.mediaId}`;
      write = {
        mediaId: meta.mediaId,
        fileName: meta.fileName,
        mimeType: meta.mimeType,
        totalChunks: meta.totalChunks,
        kind: inferMediaKind(meta.mimeType || meta.fileName),
        format: meta.format,
        storageMode: "pending",
        opfsFileName,
        opfsFileHandle: null,
        writableStream: null,
        memoryChunks: new Map(),
        writeQueue: Promise.resolve(),
        sinkReady: Promise.resolve(),
        receivedIndices: new Set(),
        chunkChecksums: new Map(),
        pendingHostChecksum: null,
        endReceived: false,
        finalized: false,
        aborted: false,
        retries: 0,
        lastChunkAt: 0,
        pendingWrites: 0
      };
      activeFileWriteRef.current = write;

      write.writeQueue = write.writeQueue.then(async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle(opfsFileName, { create: true });
          write.opfsFileHandle = handle;
          // Debug switch to exercise the main-thread fallback in browsers where the worker works.
          const forceStream = localStorage.getItem("syncplayer:forcestreamwriter") === "true";
          try {
            if (forceStream) throw new Error("main-thread writer forced");
            write.writableStream = await openWorkerSink(opfsFileName);
          } catch (workerErr) {
            if (typeof handle.createWritable !== "function") throw workerErr;
            write.writableStream = streamSink(await handle.createWritable());
            log("info", "FILE", `Using the main-thread file writer (${workerErr instanceof Error ? workerErr.message : String(workerErr)}).`);
          }
          write.storageMode = "opfs";
        } catch (err) {
          write.storageMode = "memory";
          if (meta.fileSize > MEMORY_FALLBACK_MAX_BYTES) {
            // Holding this much in RAM would likely crash the tab; fail cleanly instead.
            write.aborted = true;
            setGuestStreamMeta(null);
            const reason = `no persistent storage and the file (${formatBytes(meta.fileSize)}) is too large to hold in memory`;
            log("error", "FILE", `Cannot receive "${meta.fileName}": ${reason}. Try a different browser (Chrome/Edge/Safari 17+) or a non-private window.`);
            roomRef.current?.sendFileAborted(meta.mediaId, reason);
            return;
          }
          log(
            "warn",
            "FILE",
            `Persistent file storage unavailable (${err instanceof Error ? err.message : String(err)}). Using in-memory receive mode; keep this tab open until playback ends.`
          );
        }
      });
      write.sinkReady = write.writeQueue;
    }

    // Tell the host what we already have (empty ranges for a fresh transfer,
    // in which case this just lets the host proceed without waiting out its
    // full resume-ack timeout).
    roomRef.current?.sendFileResume(meta.mediaId, indicesToRanges(write.receivedIndices));

    let lastStageAt = 0;
    const savingStage = () =>
      `Saving to disk… ${write.receivedIndices.size.toLocaleString()} / ${write.totalChunks.toLocaleString()} chunks`;

    const finalizeFile = () => {
      if (write.finalized || write.aborted) return;
      write.finalized = true;

      write.writeQueue = write.writeQueue.then(async () => {
        try {
          // Closing the OPFS stream commits the whole file; for big files this is the slow step.
          setReceiveStage("Assembling the file…");
          const combined = combineChecksums(write.chunkChecksums, write.totalChunks);
          if (write.pendingHostChecksum && combined !== write.pendingHostChecksum) {
            log(
              "warn",
              "FILE",
              `Integrity check mismatch for "${write.fileName}" — the received chunk set doesn't match what the host sent. Playback may have gaps.`
            );
          } else {
            log("ok", "FILE", `Integrity check passed for "${write.fileName}".`);
          }

          let file: File;
          let urlSizeBytes: number;
          if (write.storageMode === "opfs" && write.writableStream && write.opfsFileHandle) {
            await write.writableStream.close();
            file = await write.opfsFileHandle.getFile();
            opfsFileHandleRef.current = write.opfsFileHandle;
            opfsFileNameRef.current = write.opfsFileName;
            urlSizeBytes = file.size;
          } else {
            const orderedChunks: ArrayBuffer[] = [];
            for (let index = 0; index < write.totalChunks; index++) {
              const chunk = write.memoryChunks.get(index);
              if (chunk) {
                orderedChunks.push(chunk);
              }
            }
            const blob = new Blob(orderedChunks, { type: write.mimeType || "application/octet-stream" });
            file = new File([blob], write.fileName, { type: write.mimeType || blob.type });
            opfsFileHandleRef.current = null;
            opfsFileNameRef.current = null;
            urlSizeBytes = blob.size;
          }

          guestFileRef.current = file;
          const url = URL.createObjectURL(file);
          setReceiveStage("Opening in the player…");

          setGuestStreamUrl(url);
          setMedia({
            id: write.mediaId,
            title: write.fileName,
            sourceUrl: url,
            kind: write.kind,
            format: write.format,
            origin: "local-file",
            sizeBytes: urlSizeBytes
          });
          log("ok", "FILE", `"${write.fileName}" completely downloaded via ${write.storageMode === "opfs" ? "persistent storage" : "memory fallback"} and mounted for playback.`);
        } catch (err) {
          log("error", "FILE", `Failed to finalize file transfer: ${err instanceof Error ? err.message : String(err)}`);
          setReceiveStage(null);
          setGuestStreamMeta(null);
        }
      });
    };

    const storeChunk = async (index: number, buffer: ArrayBuffer, checksum: string) => {
      if (write.aborted || write.finalized) {
        write.pendingWrites -= 1;
        return;
      }
      let ok: boolean;
      try {
        if (write.storageMode === "opfs" && write.writableStream) {
          ok = await write.writableStream.store(index, buffer, checksum);
        } else {
          ok = chunkChecksum(index, new Uint8Array(buffer)) === checksum;
          if (ok) write.memoryChunks.set(index, buffer);
        }
      } catch (err) {
        write.pendingWrites -= 1;
        if (write.aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        log("error", "FILE", `Failed to write chunk ${index}: ${reason}. The download was stopped; rejoin the room to try again.`);
        write.aborted = true;
        setGuestStreamMeta(null);
        roomRef.current?.sendFileAborted(write.mediaId, `disk write failed: ${reason}`);
        return;
      }
      write.pendingWrites -= 1;

      // A bad chunk is dropped (not marked received) so the retry path re-requests it.
      if (!ok) {
        log("warn", "FILE", `Chunk ${index} of "${write.fileName}" failed verification and was discarded.`);
        return;
      }
      if (write.aborted || write.finalized) return;

      write.receivedIndices.add(index);
      write.chunkChecksums.set(index, checksum);

      if (write.endReceived && write.receivedIndices.size >= write.totalChunks) {
        finalizeFile();
      } else if (write.endReceived && performance.now() - lastStageAt > 250) {
        lastStageAt = performance.now();
        setReceiveStage(savingStage());
      }
    };

    return {
      alreadyReceivedCount: write.receivedIndices.size,
      onChunk: (index, _total, data, checksum) => {
        if (write.aborted || write.finalized || write.receivedIndices.has(index)) return;
        write.lastChunkAt = performance.now();
        write.pendingWrites += 1;

        // Own copy of the bytes (PeerJS may hand us a view into a larger buffer) so it can be
        // transferred to the writer worker. Stores run concurrently; the sink handles ordering.
        const buffer = data.slice().buffer;
        const stored = write.sinkReady.then(() => storeChunk(index, buffer, checksum));
        write.writeQueue = Promise.all([write.writeQueue, stored]).then(() => undefined);
      },
      onEnd: (checksum) => {
        if (write.aborted) return;
        write.pendingHostChecksum = checksum || null;
        if (write.receivedIndices.size >= write.totalChunks) {
          finalizeFile();
        } else {
          write.endReceived = true;
          // Everything may already have arrived and just be queued for writing (big files).
          setReceiveStage(
            write.receivedIndices.size + write.pendingWrites >= write.totalChunks ? savingStage() : "Waiting for the last chunks…"
          );
          // Chunks can still be in flight on other channels; check again shortly and
          // ask the host to re-send anything still missing or that failed verification.
          const checkMissing = () => {
            if (write.finalized || write.aborted) return;
            // Still receiving? Wait for a quiet period rather than treating in-flight chunks as lost.
            const quietFor = performance.now() - write.lastChunkAt;
            if (quietFor < END_GRACE_MS) {
              window.setTimeout(checkMissing, END_GRACE_MS - quietFor + 50);
              return;
            }
            write.writeQueue = write.writeQueue.then(() => {
              if (write.finalized || write.aborted || write.receivedIndices.size >= write.totalChunks) return;
              const missing = write.totalChunks - write.receivedIndices.size;
              if (write.retries >= MAX_CHUNK_RETRIES) {
                write.aborted = true;
                setGuestStreamMeta(null);
                log("error", "FILE", `"${write.fileName}" is still missing ${missing} chunk(s) after ${MAX_CHUNK_RETRIES} retries. Rejoin the room to start over.`);
                roomRef.current?.sendFileAborted(write.mediaId, "chunks missing after retries");
                return;
              }
              write.retries += 1;
              log("warn", "FILE", `"${write.fileName}" is missing ${missing} chunk(s). Asking the host to re-send (retry ${write.retries}/${MAX_CHUNK_RETRIES}).`);
              roomRef.current?.sendFileRetry(write.mediaId);
            });
          };
          window.setTimeout(checkMissing, END_GRACE_MS);
        }
      },
      onAbort: (reason) => {
        if (write.aborted || write.finalized) return;
        write.aborted = true;
        setGuestStreamMeta(null);
        log(
          "error",
          "FILE",
          `Transfer of "${write.fileName}" aborted by host${reason ? `: ${reason}` : "."} You'll need to wait for the host to retry.`
        );
      }
    };
  };
}
