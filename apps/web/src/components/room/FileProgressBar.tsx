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
  const percent = total > 0 ? Math.round((chunksDone / total) * 100) : 0;

  return (
    <div className="stream-progress-wrap" style={style}>
      <div className="stream-progress-label">
        <span>{label}: <strong>{fileName}</strong></span>
        <span>{percent}% of {formatBytes(totalBytes)}</span>
      </div>
      <div className="stream-progress-bar">
        <div className="stream-progress-bar__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
