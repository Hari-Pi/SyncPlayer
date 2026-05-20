export type ActivityLevel = "info" | "ok" | "warn" | "error";

export type ActivityEntry = {
  id: string;
  at: string;
  level: ActivityLevel;
  label: string;
  detail: string;
};

export function createActivity(level: ActivityLevel, label: string, detail: string): ActivityEntry {
  return {
    id: crypto.randomUUID(),
    at: new Date().toLocaleTimeString(undefined, { hour12: false }),
    level,
    label,
    detail
  };
}

