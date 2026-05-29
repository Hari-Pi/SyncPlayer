/**
 * Scans the OPFS root directory and deletes any orphaned temporary files
 * starting with "syncplayer-transfer-". This runs on app startup to ensure
 * abandoned file transfers don't consume the user's local storage permanently.
 */
export async function cleanupOrphanedOpfsFiles(): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.storage) {
    return 0;
  }

  try {
    const root = await navigator.storage.getDirectory();
    let deletedCount = 0;

    // @ts-ignore - TS doesn't fully support async iterators on OPFS DirectoryHandles yet
    for await (const [name, handle] of root.entries()) {
      if (name.startsWith("syncplayer-transfer-")) {
        try {
          await root.removeEntry(name, { recursive: handle.kind === "directory" });
          deletedCount++;
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
