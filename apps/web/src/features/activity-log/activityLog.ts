export type ActivityLevel = "info" | "ok" | "warn" | "error";

export type ActivityEntry = {
  id: string;
  at: string;
  level: ActivityLevel;
  label: string;
  detail: string;
};

/** Every entry ever created, oldest first. The log panel only renders a recent slice, but Copy Logs
 * and the crash screen need the whole history. */
const allEntries: ActivityEntry[] = [];
export const getAllActivity = (): readonly ActivityEntry[] => allEntries;

export function formatActivity(entries: readonly ActivityEntry[]): string {
  return entries.map((e) => `[${e.at}] [${e.level.toUpperCase()}] ${e.label}: ${e.detail}`).join("\n");
}

/** How many entries the log panel renders at once. */
export const VISIBLE_ACTIVITY_LIMIT = 200;

export function createActivity(level: ActivityLevel, label: string, detail: string): ActivityEntry {
  const entry: ActivityEntry = {
    id: crypto.randomUUID(),
    at: new Date().toLocaleTimeString(undefined, { hour12: false }),
    level,
    label,
    detail
  };
  allEntries.push(entry);
  return entry;
}

