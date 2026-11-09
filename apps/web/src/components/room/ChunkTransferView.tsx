import { useEffect, useRef } from "react";
import { Download, Loader2 } from "lucide-react";
import { formatBytes } from "@/lib/time/format";

type ChunkTransferViewProps = {
  fileName: string;
  chunksReceived: number;
  total: number;
  totalBytes: number;
  /** Live set of received chunk indices; read on a timer, not via React state, so 64 KiB chunks don't re-render the app. */
  getReceived: () => ReadonlySet<number> | undefined;
  /** Set once all chunks are in and the file is being saved/assembled/opened; replaces the counters. */
  stage?: string | null;
};

const REDRAW_MS = 250;
const GAP = 1;

/** Fills the player area while a file is being received: one cell per chunk, lit as it lands. */
export function ChunkTransferView({ fileName, chunksReceived, total, totalBytes, getReceived, stage }: ChunkTransferViewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || total <= 0) return;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width: cssW, height: cssH } = canvas.getBoundingClientRect();
      if (cssW === 0 || cssH === 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Pick a square cell size so every chunk fits in the box.
      const cell = Math.max(1, Math.floor(Math.sqrt((cssW * cssH) / total)));
      let cols = Math.max(1, Math.floor(cssW / cell));
      let size = cell;
      while (Math.ceil(total / cols) * size > cssH && size > 1) {
        size -= 1;
        cols = Math.max(1, Math.floor(cssW / size));
      }
      const gap = size >= 4 ? GAP : 0;
      const rows = Math.ceil(total / cols);
      const offsetX = Math.floor((cssW - cols * size) / 2);
      const offsetY = Math.floor((cssH - rows * size) / 2);

      const styles = getComputedStyle(canvas);
      const on = styles.getPropertyValue("--accent").trim() || "#37f3ff";
      const off = styles.getPropertyValue("--line-soft").trim() || "rgba(63,245,255,0.18)";
      const received = getReceived();

      ctx.clearRect(0, 0, cssW, cssH);
      for (let i = 0; i < total; i++) {
        ctx.fillStyle = received?.has(i) ? on : off;
        ctx.fillRect(offsetX + (i % cols) * size, offsetY + Math.floor(i / cols) * size, size - gap, size - gap);
      }
    };

    draw();
    const timer = window.setInterval(draw, REDRAW_MS);
    return () => window.clearInterval(timer);
  }, [total, getReceived]);

  const done = Math.min(Math.max(chunksReceived, 0), total);
  const left = total - done;
  const percent = total > 0 ? (done / total) * 100 : 0;
  const bytesDone = total > 0 ? Math.round((done / total) * totalBytes) : 0;

  return (
    <div className="chunk-transfer" role="status" aria-live="polite">
      <div className="chunk-transfer__head">
        {stage ? <Loader2 size={18} className="chunk-transfer__spin" /> : <Download size={18} />}
        <strong>{stage ? "Received, processing" : "Receiving"} "{fileName}"</strong>
      </div>
      <canvas ref={canvasRef} className="chunk-transfer__map" aria-label={`${done} of ${total} chunks received`} />
      {stage ? (
        <div className="chunk-transfer__stage">
          <div className="chunk-transfer__stage-bar" aria-hidden="true" />
          <div className="chunk-transfer__stats">
            <span><b>{stage}</b></span>
            <span>{total.toLocaleString()} chunks · {formatBytes(totalBytes)} received</span>
          </div>
        </div>
      ) : (
        <div className="chunk-transfer__stats">
          <span><b>{done.toLocaleString()}</b> / {total.toLocaleString()} chunks</span>
          <span><b>{left.toLocaleString()}</b> left</span>
          <span>{percent < 10 ? percent.toFixed(1) : Math.round(percent)}% · {formatBytes(bytesDone)} / {formatBytes(totalBytes)}</span>
        </div>
      )}
    </div>
  );
}
