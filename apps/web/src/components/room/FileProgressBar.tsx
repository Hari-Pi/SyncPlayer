import { formatBytes } from "@/lib/time/format";

type FileProgressBarProps = {
  label: string;
  fileName: string;
  chunksDone: number;
  total: number;
  totalBytes: number;
  style?: React.CSSProperties;
};

export function FileProgressBar({ label, fileName, chunksDone, total, totalBytes, style }: FileProgressBarProps) {
  const clampedChunksDone = Math.min(Math.max(chunksDone, 0), total);
  const percent = total > 0 ? (clampedChunksDone / total) * 100 : 0;
  const percentLabel = percent > 0 && percent < 10 ? percent.toFixed(1) : String(Math.round(percent));
  const bytesDone = total > 0 ? Math.min(totalBytes, Math.round((clampedChunksDone / total) * totalBytes)) : 0;
  const isActive = total > 0 && clampedChunksDone < total;

  return (
    <div className={`stream-progress-wrap${isActive ? " stream-progress-wrap--active" : ""}`} style={style}>
      <div className="stream-progress-label">
        <span>{label}: <strong>{fileName}</strong></span>
        <span>{percentLabel}% · {formatBytes(bytesDone)} / {formatBytes(totalBytes)}</span>
      </div>
      <div className="stream-progress-bar">
        <div className="stream-progress-bar__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
