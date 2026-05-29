import { Activity, Clipboard } from "lucide-react";
import type { ActivityEntry } from "@/features/activity-log/activityLog";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function ActivityLogPanel({
  activity,
  onCopyLogs
}: {
  activity: ActivityEntry[];
  onCopyLogs: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel__header">
        <span className="panel__title">
          <Activity size={15} />
          Activity Log
        </span>
        <button type="button" className="panel__btn" onClick={onCopyLogs}>
          <Clipboard size={12} />
          Copy Logs
        </button>
        <span className="panel__rail" />
      </div>
      <div className="log-list">
        {activity.map((entry) => (
          <div className={cx("log-entry", `log-entry--${entry.level}`)} key={entry.id}>
            <span>{entry.at}</span>
            <strong>{entry.label}</strong>
            <p>{entry.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
