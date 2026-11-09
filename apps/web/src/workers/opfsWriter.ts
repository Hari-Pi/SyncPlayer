/**
 * opfsWriter.ts — fallback file writer for browsers (notably Safari/iOS) whose main thread
 * lacks FileSystemFileHandle.createWritable. Workers can use createSyncAccessHandle instead.
 */
type In =
  | { type: "open"; name: string }
  | { type: "write"; position: number; data: ArrayBuffer }
  | { type: "close" };

type SyncHandle = {
  write(data: BufferSource, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
};

let handle: SyncHandle | null = null;
const reply = (msg: { type: "opened" | "written" | "closed" } | { type: "error"; error: string }) =>
  (self as unknown as Worker).postMessage(msg);

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data;
  try {
    if (msg.type === "open") {
      const root = await navigator.storage.getDirectory();
      const file = (await root.getFileHandle(msg.name, { create: true })) as FileSystemFileHandle & {
        createSyncAccessHandle(): Promise<SyncHandle>;
      };
      handle = await file.createSyncAccessHandle();
      reply({ type: "opened" });
    } else if (msg.type === "write") {
      handle!.write(msg.data, { at: msg.position });
      reply({ type: "written" });
    } else if (msg.type === "close") {
      handle?.flush();
      handle?.close();
      handle = null;
      reply({ type: "closed" });
    }
  } catch (err) {
    reply({ type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
