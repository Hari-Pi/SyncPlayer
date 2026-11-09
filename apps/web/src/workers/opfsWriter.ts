/**
 * opfsWriter.ts — receives file chunks off the main thread: verifies each chunk's checksum and
 * writes it at its byte offset through a synchronous OPFS access handle (only available in
 * workers; much faster than the main-thread createWritable stream, which also has to copy the
 * whole file into place on close).
 *
 * Every request carries an id and gets exactly one reply: { id, ok } or { id, error }.
 * Messages are handled in order, so a "close" reply means every earlier chunk is on disk.
 */
import { chunkChecksum } from "@/lib/media/checksum";

type In =
  | { id: number; type: "open"; name: string }
  | { id: number; type: "store"; index: number; position: number; data: ArrayBuffer; checksum: string }
  | { id: number; type: "close" };

type SyncHandle = {
  write(data: BufferSource, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
};

let handle: SyncHandle | null = null;
const reply = (msg: { id: number; ok?: boolean; error?: string }) => (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data;
  try {
    if (msg.type === "open") {
      const root = await navigator.storage.getDirectory();
      const file = (await root.getFileHandle(msg.name, { create: true })) as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<SyncHandle>;
      };
      handle = await file.createSyncAccessHandle();
      reply({ id: msg.id, ok: true });
    } else if (msg.type === "store") {
      const bytes = new Uint8Array(msg.data);
      // A chunk that fails verification is not written; the caller re-requests it.
      if (chunkChecksum(msg.index, bytes) !== msg.checksum) {
        reply({ id: msg.id, ok: false });
        return;
      }
      handle!.write(bytes, { at: msg.position });
      reply({ id: msg.id, ok: true });
    } else if (msg.type === "close") {
      handle?.flush();
      handle?.close();
      handle = null;
      reply({ id: msg.id, ok: true });
    }
  } catch (err) {
    reply({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
