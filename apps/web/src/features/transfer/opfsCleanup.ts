/**
 * Scans the OPFS root directory and deletes any orphaned temporary files
 * starting with "syncplayer-transfer-". This runs on app startup to ensure
 * abandoned file transfers don't consume the user's local storage permanently.
 * Files another open tab holds a lock on (see holdFileLock) are left alone.
 */
const LOCK_PREFIX = "syncplayer-file:";

/**
 * Marks a transfer file as in use by this tab until the tab closes (the lock is released
 * automatically then). Other tabs' startup cleanup skips locked files, so opening a second
 * SyncPlayer tab can't delete the video this one just received.
 */
export function holdFileLock(fileName: string): void {
  if (typeof navigator === "undefined" || !navigator.locks) return;
  void navigator.locks.request(LOCK_PREFIX + fileName, () => new Promise<void>(() => { /* held for the tab's lifetime */ }));
}

export async function cleanupOrphanedOpfsFiles(): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.storage) {
    return 0;
  }

  try {
    const root = await navigator.storage.getDirectory();
    let deletedCount = 0;

    // @ts-expect-error - TS doesn't fully support async iterators on OPFS DirectoryHandles yet
    for await (const [name, handle] of root.entries()) {
      if (name.startsWith("syncplayer-transfer-")) {
        try {
          // Without Web Locks we can't tell whether another tab is using the file: keep it.
          if (!navigator.locks) continue;
          const removed = await navigator.locks.request(LOCK_PREFIX + name, { ifAvailable: true }, async (lock) => {
            if (!lock) return false; // in use by another tab
            await root.removeEntry(name, { recursive: handle.kind === "directory" });
            return true;
          });
          if (removed) deletedCount++;
        } catch (e) {
          console.error(`Failed to delete orphaned OPFS file: ${name}`, e);
        }
      }
    }
    
    return deletedCount;
  } catch (error) {
    console.error("Failed to access OPFS during cleanup.", error);
    return 0;
  }
}
