import { useEffect, useRef } from "react";
import { X } from "lucide-react";

export function QrModal({ url, onClose }: { url: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !url) return;

    const canvas = canvasRef.current;
    // Loaded on demand: the QR library is only needed once this modal opens.
    void import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toCanvas(canvas, url, { width: 260, margin: 2, color: { dark: "#37f3ff", light: "#03070b" } })
      )
      .catch(() => {
        // silently fail
      });
  }, [url]);

  return (
    <div className="qr-overlay" onClick={onClose}>
      <div className="qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-modal__header">
          <span className="qr-modal__title">Scan to Join</span>
          <button type="button" className="qr-modal__close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <canvas ref={canvasRef} className="qr-canvas" />
        <p className="qr-modal__hint">Open the invite link on your mobile device to join the room.</p>
      </div>
    </div>
  );
}
