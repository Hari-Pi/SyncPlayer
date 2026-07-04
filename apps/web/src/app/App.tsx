import {
  AlertTriangle,
  AudioLines,
  CircleDot,
  Clipboard,
  FileVideo,
  Gauge,
  Github,
  Hash,
  Link2,
  Lock,
  LogIn,
  Pause,
  QrCode,
  Radar,
  RadioTower,
  ScanLine,
  Send,
  Shield,
  Signal,
  Upload,
  Video,
  X
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Artplayer from "artplayer";
import QRCode from "qrcode";
import { createActivity, type ActivityEntry, type ActivityLevel } from "@/features/activity-log/activityLog";
import { usePeerRoom } from "@/features/room/usePeerRoom";
import { ActivityLogPanel } from "@/components/room/ActivityLogPanel";
import { FileProgressBar } from "@/components/room/FileProgressBar";
import { createMediaHint, type DriftReading } from "@/lib/wasm/syncCore";
import { formatBytes, formatClock, formatDuration } from "@/lib/time/format";
import { inferMediaFormat, inferMediaKind, mediaFormatLabel, type LoadedMedia, type MediaKind, type MediaFormat } from "@/lib/media/mediaTypes";
import { combineChecksums, indicesToRanges } from "@/lib/media/checksum";
import { createLocalTabChannel } from "@/lib/sync/localTabSync";
import { cx } from "@/lib/ui/cx";
import type { PlaybackSnapshot, FileMeta, RemoteMediaMount, PlaybackConfig, GuestPlaybackAction } from "@/lib/webrtc/messages";
import { CHUNK_SIZE } from "@/lib/webrtc/messages";
import type { DataConnection } from "peerjs";
import type { FileStreamHandlers } from "@/features/room/usePeerRoom";

const emptyDrift: DriftReading = {
  driftMs: 0,
  mode: "hold",
  rate: 1
};

// Drift magnitude thresholds (milliseconds). Drive the meter's mode/tone and
// the actual correction applied to guests: soft/firm nudge playbackRate, seek
// for large drift.
const DRIFT_HOLD_MS = 40;
const DRIFT_SOFT_MS = 150;
const DRIFT_FIRM_MS = 500;
const SOFT_RATE = 0.05;
const FIRM_RATE = 0.1;

// A guest that's behind the host and needs to speed up to catch back
// up will burn through its buffer faster — if the buffer ahead is already
// thin, that's exactly what causes a stall, which then triggers another
// correction (the "endless catching" problem). Below this many seconds of
// buffer ahead, we hold instead of speeding up and let the buffer refill.
const MIN_SAFE_BUFFER_SECS = 1.5;

// After a hard seek, give the player time to actually rebuffer before
// allowing another seek. Otherwise a slow connection sees seek → stall →
// new correction arrives → seek again, without ever settling.
const SEEK_COOLDOWN_MS = 1500;

// Smooth drift over a short rolling window so a single noisy sample
// (e.g. a late/jittery message) doesn't trigger an aggressive correction.
const DRIFT_SMOOTHING_SAMPLES = 3;

// Viewers can pause/seek and reverse-sync that to the host; the two share one
// budget per rolling window so a viewer can't spam controls and annoy the
// rest of the room. Resume is exempt (see handlePlaybackAction). The host
// enforces this too (see usePeerRoom), this client-side copy just avoids
// sending doomed actions.
const GUEST_ACTION_LIMIT = 3;
const GUEST_ACTION_WINDOW_MS = 60_000;

/** Seconds of buffered media ahead of the element's current playback position. */
function getBufferedAheadSecs(element: HTMLMediaElement): number {
  const { buffered, currentTime } = element;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
      return buffered.end(i) - currentTime;
    }
  }
  return 0;
}

// Compute a DriftReading from the signed offset between local currentTime and
// the remote target position (both in seconds). Returns the correction
// multiplier relative to the host rate — applied to guests each tick.
function readDrift(driftSecs: number, hostRate: number, bufferedAheadSecs: number): DriftReading {
  const driftMs = driftSecs * 1000;
  const abs = Math.abs(driftMs);

  if (abs < DRIFT_HOLD_MS) {
    return { driftMs, mode: "hold", rate: hostRate };
  }

  // Negative drift means we're behind the target and would need to speed up.
  const needsSpeedUp = driftMs < 0;
  if (needsSpeedUp && bufferedAheadSecs < MIN_SAFE_BUFFER_SECS && abs < DRIFT_FIRM_MS) {
    return { driftMs, mode: "hold", rate: hostRate };
  }

  if (abs < DRIFT_SOFT_MS) {
    return { driftMs, mode: "soft", rate: hostRate * (driftMs > 0 ? 1 - SOFT_RATE : 1 + SOFT_RATE) };
  }
  if (abs < DRIFT_FIRM_MS) {
    return { driftMs, mode: "firm", rate: hostRate * (driftMs > 0 ? 1 - FIRM_RATE : 1 + FIRM_RATE) };
  }
  return { driftMs, mode: "seek", rate: hostRate };
}

function Panel({
  title,
  icon,
  action,
  children,
  className
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("panel", className)}>
      <div className="panel__header">
        <span className="panel__title">
          {icon}
          {title}
        </span>
        {action}
        <span className="panel__rail" />
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "ok" | "warn" }) {
  return (
    <div className={cx("metric", `metric--${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function copyText(value: string) {
  if (!value) {
    return;
  }

  void navigator.clipboard?.writeText(value);
}

/**
 * Guest-side state for one incoming file transfer's OPFS write session.
 * Lives in a ref (activeFileWriteRef) rather than a closure-local variable so
 * a repeat "file.meta" for the same mediaId — e.g. the host re-streaming to a
 * peer that just reconnected — can detect and resume it instead of tearing
 * down and re-downloading everything from scratch.
 */
type ActiveFileWrite = {
  mediaId: string;
  fileName: string;
  totalChunks: number;
  kind: MediaKind;
  format: MediaFormat;
  opfsFileName: string;
  opfsFileHandle: FileSystemFileHandle | null;
  writableStream: FileSystemWritableFileStream | null;
  writeQueue: Promise<void>;
  receivedIndices: Set<number>;
  chunkChecksums: Map<number, string>;
  pendingHostChecksum: string | null;
  endReceived: boolean;
  finalized: boolean;
  aborted: boolean;
};

type ShareMedia = Pick<LoadedMedia, "id" | "title" | "sourceUrl" | "kind" | "format" | "origin">;
type ShareRtcConfig = Pick<RTCConfiguration, "iceServers" | "iceTransportPolicy">;
type SharePayload =
  | {
      type: "invite";
      offer: string;
      media: ShareMedia | null;
      rtcConfig?: ShareRtcConfig | null;
    }
  | {
      type: "response";
      answer: string;
    };

function encodeSharePayload(payload: SharePayload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeSharePayload(value: string): SharePayload {
  const normalized = value.replace(/^.*#sync=/, "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return JSON.parse(new TextDecoder().decode(bytes)) as SharePayload;
}

function createShareUrl(payload: SharePayload) {
  return `${window.location.origin}${window.location.pathname}#sync=${encodeSharePayload(payload)}`;
}

function readSharePayloadFromUrl() {
  if (!window.location.hash.startsWith("#sync=")) {
    return null;
  }

  return decodeSharePayload(window.location.hash);
}

function isLocalhost() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

/** Display just the 4-digit code from a full SP-XXXX peer ID. */
function formatRoomId(id: string) {
  return id.startsWith("SP-") ? id.slice(3) : id;
}

function readStoredRtcConfig(): ShareRtcConfig | null {
  try {
    const stored = localStorage.getItem("syncplayer:rtcconfig");
    return stored ? JSON.parse(stored) as ShareRtcConfig : null;
  } catch {
    return null;
  }
}

function writeStoredRtcConfig(config: ShareRtcConfig | null) {
  if (!config) {
    localStorage.removeItem("syncplayer:rtcconfig");
    return;
  }

  localStorage.setItem("syncplayer:rtcconfig", JSON.stringify(config));
}

function createRemoteMedia(url: string): LoadedMedia {
  const parsedUrl = new URL(url);
  const format = inferMediaFormat(url);

  return {
    id: `url:${url}`,
    title: parsedUrl.pathname.split("/").pop() || "Remote stream",
    sourceUrl: url,
    kind: inferMediaKind(url),
    format,
    origin: "remote-url"
  };
}

function QrModal({ url, onClose }: { url: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current || !url) return;

    QRCode.toCanvas(canvasRef.current, url, {
      width: 260,
      margin: 2,
      color: {
        dark: "#37f3ff",
        light: "#03070b"
      }
    }).catch(() => {
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

export function App() {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const artplayerContainerRef = useRef<HTMLDivElement | null>(null);
  const artRef = useRef<Artplayer | null>(null);
  // Engine instances for config sync (subtitle/quality). Persisted so host can
  // read current config and guests can apply remote config changes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dashRef = useRef<any>(null);
  const remoteApplyRef = useRef(false);
  const lastBroadcastRef = useRef(0);
  // Rolling window of recent drift samples (secs) for smoothing corrections.
  const driftHistoryRef = useRef<number[]>([]);
  // Timestamp (performance.now()) of the last hard seek correction we applied.
  const lastSeekAtRef = useRef(0);
  // True while the local media element is stalled waiting for data.
  const isStalledRef = useRef(false);
  // Guest-side: rolling timestamps of accepted control actions (pause/resume/seek
  // share one budget), used for the client-side rate-limit gate.
  const guestActionHistoryRef = useRef<number[]>([]);
  const [clock, setClock] = useState(formatClock());
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  // Keep a ref to the live media so async callbacks always see the current value,
  // not a stale closure from when the callback was last created.
  const mediaStateRef = useRef<LoadedMedia | null>(null);
  useEffect(() => { mediaStateRef.current = media; }, [media]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [openedThroughRoomLink, setOpenedThroughRoomLink] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const staleBlobUrlRef = useRef<string | null>(null);
  const guestFileRef = useRef<File | null>(null);
  const opfsFileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const opfsFileNameRef = useRef<string | null>(null);
  // Guest-side: the currently in-flight (or just-completed) OPFS write session.
  // Kept in a ref (not local closure state) so a second file.meta for the same
  // mediaId — e.g. after a reconnect — can detect and resume it instead of
  // starting over from byte zero.
  const activeFileWriteRef = useRef<ActiveFileWrite | null>(null);
  const handledShareLinkRef = useRef(false);
  const localTabChannelRef = useRef<ReturnType<typeof createLocalTabChannel>>(null);
  const hostFileRef = useRef<File | null>(null);
  const [guestStreamUrl, setGuestStreamUrl] = useState<string | null>(null);
  const [guestStreamMeta, setGuestStreamMeta] = useState<FileMeta | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([
    createActivity("info", "BOOT", "Command deck initialized.")
  ]);
  const [drift, setDrift] = useState<DriftReading>(emptyDrift);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>({
    mediaId: null,
    position: 0,
    duration: 0,
    paused: true,
    playbackRate: 1
  });

  const log = useCallback((level: ActivityLevel, label: string, detail: string) => {
    setActivity((entries) => [createActivity(level, label, detail), ...entries].slice(0, 6));
  }, []);

  const roomRef = useRef<ReturnType<typeof usePeerRoom> | null>(null);

  const bindMediaElement = useCallback((node: HTMLMediaElement | null) => {
    mediaRef.current = node;
  }, []);

  const handleRemotePlayback = useCallback(
    async (remoteSnapshot: PlaybackSnapshot, latencyMs: number) => {
      const element = mediaRef.current;
      const currentMedia = mediaStateRef.current;

      if (!element || !currentMedia) {
        log("warn", "SYNC", `No media element or media mounted yet. Skipping remote state.`);
        return;
      }

      if (remoteSnapshot.mediaId !== null && remoteSnapshot.mediaId !== currentMedia.id) {
        log(
          "warn",
          "SYNC",
          `Media ID mismatch — host: "${remoteSnapshot.mediaId}", local: "${currentMedia.id}". Load the same media as the host.`
        );
        return;
      }

      const targetPosition = remoteSnapshot.paused 
        ? remoteSnapshot.position 
        : remoteSnapshot.position + latencyMs / 1000;

      remoteApplyRef.current = true;

      // Guests measure real drift and apply correction.
      if (roomRef.current?.role === "guest") {
        const rawDriftSecs = element.currentTime - targetPosition;

        // Smooth over the last few samples so a single noisy reading doesn't
        // flip the correction mode back and forth.
        const history = [...driftHistoryRef.current.slice(-(DRIFT_SMOOTHING_SAMPLES - 1)), rawDriftSecs];
        driftHistoryRef.current = history;
        const driftSecs = history.reduce((sum, value) => sum + value, 0) / history.length;

        const bufferedAheadSecs = getBufferedAheadSecs(element);
        const reading = readDrift(driftSecs, remoteSnapshot.playbackRate, bufferedAheadSecs);
        setDrift(reading);

        // Graduated drift correction: soft/firm nudge playbackRate, seek for large drift.
        if (reading.mode === "seek") {
          const now = performance.now();
          const recovering = isStalledRef.current || now - lastSeekAtRef.current < SEEK_COOLDOWN_MS;

          if (recovering) {
            // Already mid-stall or mid-recovery from a previous seek — seeking
            // again now would just restart the buffering instead of letting it
            // finish. Hold rate and let the current correction settle.
            element.playbackRate = remoteSnapshot.playbackRate;
          } else {
            element.currentTime = targetPosition;
            element.playbackRate = remoteSnapshot.playbackRate;
            lastSeekAtRef.current = now;
            driftHistoryRef.current = [];
          }
        } else {
          element.playbackRate = reading.rate;
        }
      } else {
        setDrift(emptyDrift);
        element.playbackRate = remoteSnapshot.playbackRate;
      }

      if (remoteSnapshot.paused) {
        element.pause();
      } else {
        await element.play().catch(() => {
          log("warn", "PLAYBACK", "Browser blocked remote autoplay. Press play once to arm media.");
        });
      }

      window.setTimeout(() => {
        remoteApplyRef.current = false;
      }, 250);
    },
    [log] // stable: reads live media via mediaStateRef, not the closed-over state
  );

  // Delete the previous OPFS transfer file so abandoned files don't accumulate.
  const cleanupOpfsFile = useCallback(() => {
    const fileName = opfsFileNameRef.current;
    opfsFileNameRef.current = null;
    opfsFileHandleRef.current = null;
    guestFileRef.current = null;
    hlsRef.current = null;
    dashRef.current = null;
    if (activeFileWriteRef.current) {
      // Mark the old session dead so any writes still queued for it become no-ops.
      activeFileWriteRef.current.aborted = true;
      activeFileWriteRef.current = null;
    }
    if (!fileName) return;
    navigator.storage.getDirectory().then((root) => {
      root.removeEntry(fileName).catch(() => { /* file may not exist */ });
    }).catch(() => { /* OPFS unavailable */ });
  }, []);

  // ── Guest file stream receiver ─────────────────────────────────────────────
  // Supports resuming: if this is a repeat file.meta for a mediaId we already
  // have a live (unfinished, unaborted) write session for — e.g. the host
  // re-streaming to us after a reconnect — we reuse that session instead of
  // starting over, and tell the host which chunks to skip re-sending.
  const handleFileStream = useCallback((meta: FileMeta): FileStreamHandlers => {
    const existing = activeFileWriteRef.current;
    const isResume = !!existing && existing.mediaId === meta.mediaId && !existing.finalized && !existing.aborted;

    let write: ActiveFileWrite;

    if (isResume) {
      write = existing!;
      setGuestStreamMeta(meta);
      log(
        "info",
        "FILE",
        `Resuming "${meta.fileName}" — already have ${write.receivedIndices.size}/${meta.totalChunks} chunks, requesting the rest.`
      );
    } else {
      cleanupOpfsFile();
      setGuestStreamUrl((previousUrl) => {
        if (previousUrl) {
          staleBlobUrlRef.current = previousUrl;
        }
        return null;
      });
      setGuestStreamMeta(meta);
      log("info", "FILE", `Receiving "${meta.fileName}" (${(meta.fileSize / 1024 / 1024).toFixed(1)} MB) to local disk...`);

      const opfsFileName = `syncplayer-transfer-${meta.mediaId}`;
      write = {
        mediaId: meta.mediaId,
        fileName: meta.fileName,
        totalChunks: meta.totalChunks,
        kind: inferMediaKind(meta.mimeType || meta.fileName),
        format: meta.format,
        opfsFileName,
        opfsFileHandle: null,
        writableStream: null,
        writeQueue: Promise.resolve(),
        receivedIndices: new Set(),
        chunkChecksums: new Map(),
        pendingHostChecksum: null,
        endReceived: false,
        finalized: false,
        aborted: false
      };
      activeFileWriteRef.current = write;

      write.writeQueue = write.writeQueue.then(async () => {
        try {
          const root = await navigator.storage.getDirectory();
          const handle = await root.getFileHandle(opfsFileName, { create: true });
          write.opfsFileHandle = handle;
          write.writableStream = await handle.createWritable();
        } catch (err) {
          log("error", "FILE", `Failed to initialize OPFS storage: ${err instanceof Error ? err.message : String(err)}`);
          write.aborted = true;
        }
      });
    }

    // Tell the host what we already have (empty ranges for a fresh transfer,
    // in which case this just lets the host proceed without waiting out its
    // full resume-ack timeout).
    roomRef.current?.sendFileResume(meta.mediaId, indicesToRanges(write.receivedIndices));

    const finalizeFile = () => {
      if (write.finalized || write.aborted) return;
      write.finalized = true;

      write.writeQueue = write.writeQueue.then(async () => {
        if (!write.writableStream || !write.opfsFileHandle) return;
        try {
          const combined = combineChecksums(write.chunkChecksums, write.totalChunks);
          if (write.pendingHostChecksum && combined !== write.pendingHostChecksum) {
            log(
              "warn",
              "FILE",
              `Integrity check mismatch for "${write.fileName}" — the received chunk set doesn't match what the host sent. Playback may have gaps.`
            );
          } else {
            log("ok", "FILE", `Integrity check passed for "${write.fileName}".`);
          }

          await write.writableStream.close();
          const file = await write.opfsFileHandle.getFile();
          guestFileRef.current = file;
          opfsFileHandleRef.current = write.opfsFileHandle;
          opfsFileNameRef.current = write.opfsFileName;
          const url = URL.createObjectURL(file);

          setGuestStreamUrl(url);
          setMedia({
            id: write.mediaId,
            title: write.fileName,
            sourceUrl: url,
            kind: write.kind,
            format: write.format,
            origin: "local-file",
            sizeBytes: file.size
          });
          setGuestStreamMeta(null);
          log("ok", "FILE", `"${write.fileName}" completely downloaded and mounted for playback.`);
        } catch (err) {
          log("error", "FILE", `Failed to finalize file transfer: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    };

    return {
      alreadyReceivedCount: write.receivedIndices.size,
      onChunk: (index, _total, data, checksum) => {
        if (write.aborted || write.finalized || write.receivedIndices.has(index)) return;

        write.writeQueue = write.writeQueue.then(async () => {
          if (!write.writableStream || write.aborted || write.finalized) return;
          try {
            await write.writableStream.write({
              type: "write",
              position: index * CHUNK_SIZE,
              data: data.buffer as ArrayBuffer
            });
          } catch (err) {
            log("error", "FILE", `Failed to write chunk ${index}: ${err instanceof Error ? err.message : String(err)}`);
            write.aborted = true;
            return;
          }

          write.receivedIndices.add(index);
          write.chunkChecksums.set(index, checksum);

          if (write.endReceived && write.receivedIndices.size >= write.totalChunks) {
            finalizeFile();
          }
        });
      },
      onEnd: (checksum) => {
        if (write.aborted) return;
        write.pendingHostChecksum = checksum || null;
        if (write.receivedIndices.size >= write.totalChunks) {
          finalizeFile();
        } else {
          write.endReceived = true;
        }
      }
    };
  }, [cleanupOpfsFile, log]);

  const mountRemoteMedia = useCallback(
    (url: string, source: "manual" | "invite") => {
      let nextMedia: LoadedMedia;

      try {
        nextMedia = createRemoteMedia(url);
      } catch {
        log("error", "MEDIA", "That media URL is not valid.");
        return null;
      }

      setRemoteUrl(url);
      setMedia(nextMedia);
      setDrift(emptyDrift);
      driftHistoryRef.current = [];
      lastSeekAtRef.current = 0;
      isStalledRef.current = false;
      hostFileRef.current = null;
      log("ok", "MEDIA", source === "invite" ? "Media URL loaded from invite link." : `${mediaFormatLabel(nextMedia.format)} URL mounted.`);
      return nextMedia;
    },
    [log]
  );

  const handleRemoteMediaMount = useCallback((nextMedia: RemoteMediaMount) => {
    cleanupOpfsFile();
    setGuestStreamUrl((previousUrl) => {
      if (previousUrl) staleBlobUrlRef.current = previousUrl;
      return null;
    });
    setGuestStreamMeta(null);
    hostFileRef.current = null;
    setRemoteUrl(nextMedia.sourceUrl);
    setMedia(nextMedia);
    setDrift(emptyDrift);
    driftHistoryRef.current = [];
    lastSeekAtRef.current = 0;
    isStalledRef.current = false;
    log("ok", "MEDIA", `${nextMedia.title} mounted from host.`);
  }, [cleanupOpfsFile, log]);

  // ── Config sync (subtitle + quality, pull model) ───────────────────────────
  // Host responds to guest config requests by reading current engine state.
  const handleConfigRequest = useCallback((conn: DataConnection) => {
    const hls = hlsRef.current;
    const dash = dashRef.current;
    let config: PlaybackConfig;

    if (hls) {
      config = {
        subtitleTrack: hls.subtitleTrack ?? -1,
        qualityLevel: hls.currentLevel ?? -1
      };
    } else if (dash) {
      config = {
        subtitleTrack: dash.getCurrentTextTrackIndex?.() ?? -1,
        qualityLevel: -1
      };
    } else {
      config = { subtitleTrack: -1, qualityLevel: -1 };
    }

    roomRef.current?.sendConfigState(conn, config);
  }, []);

  // Guest applies config received from host.
  const handleConfigState = useCallback((config: PlaybackConfig) => {
    remoteApplyRef.current = true;
    const hls = hlsRef.current;
    const dash = dashRef.current;

    if (hls) {
      if (config.subtitleTrack >= -1) hls.subtitleTrack = config.subtitleTrack;
      if (config.qualityLevel >= -1) hls.currentLevel = config.qualityLevel;
    } else if (dash) {
      if (config.subtitleTrack >= -1) dash.setTextTrack?.(config.subtitleTrack);
    }

    window.setTimeout(() => { remoteApplyRef.current = false; }, 250);
  }, []);

  // Guest requests fresh config when host signals a change.
  const handleConfigChanged = useCallback(() => {
    roomRef.current?.sendConfigRequest();
  }, []);

  // Host-side: a viewer's pause/resume/seek passed the host's rate-limit check.
  // Adopt it on the host's own player — the normal 250ms publish loop then
  // picks up the new state and broadcasts it to the whole room as usual.
  const handleGuestAction = useCallback(
    (action: GuestPlaybackAction, snapshot: PlaybackSnapshot, peerId: string) => {
      const element = mediaRef.current;
      if (!element) return;

      remoteApplyRef.current = true;

      if (action === "pause") {
        element.pause();
      } else if (action === "resume") {
        void element.play().catch(() => {
          log("warn", "PLAYBACK", "Browser blocked autoplay while applying a viewer's resume action.");
        });
      } else if (action === "seek") {
        element.currentTime = snapshot.position;
      }

      log("info", "SYNC", `Viewer ${peerId} triggered ${action}. Host adopted it and will broadcast to the room.`);

      window.setTimeout(() => {
        remoteApplyRef.current = false;
      }, 250);
    },
    [log]
  );

  const room = usePeerRoom({
    onPlaybackState: handleRemotePlayback,
    onEvent: log,
    onFileStream: handleFileStream,
    onMediaMount: handleRemoteMediaMount,
    onConfigRequest: handleConfigRequest,
    onConfigState: handleConfigState,
    onConfigChanged: handleConfigChanged,
    onGuestAction: handleGuestAction
  });

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const isSecureOrigin = window.isSecureContext || isLocalhost();
  const roomActionLabel =
    room.status === "connected" && room.roomCode
      ? `Room ${room.roomCode}`
      : room.role === "host" && inviteLink
        ? "Room Hosted"
        : room.status === "pairing"
          ? "Hosting Room"
          : "Start Room";

  const handleJoinByCode = useCallback(async () => {
    const code = joinCode.replace(/\D/g, "").slice(0, 4);
    if (code.length !== 4) {
      log("warn", "JOIN", "Enter a 4-digit room code.");
      return;
    }
    log("info", "JOIN", `Connecting to room ${code}...`);
    await room.joinWithOffer(code);
  }, [joinCode, room, log]);

  const createInviteLink = useCallback(async () => {
    const offer = await room.createHostOffer();

    if (!offer) {
      return;
    }

    const shareableMedia: ShareMedia | null =
      media?.origin === "remote-url"
        ? {
          id: media.id,
          title: media.title,
          sourceUrl: media.sourceUrl,
          kind: media.kind,
          format: media.format,
          origin: media.origin
        }
        : null;

    const nextInviteLink = createShareUrl({
      type: "invite",
      offer,
      media: shareableMedia,
      rtcConfig: readStoredRtcConfig()
    });

    setInviteLink(nextInviteLink);
    copyText(nextInviteLink);

    if (media?.origin === "local-file") {
      log("ok", "SHARE", "Invite link copied. The file will stream to viewers automatically when they connect.");
    } else if (shareableMedia) {
      log("ok", "SHARE", "Invite link copied. The media URL will load for the viewer.");
    } else {
      log("ok", "SHARE", "Invite link copied. Add media whenever you are ready.");
    }
  }, [log, media, room]);

  useEffect(() => {
    if (!isSecureOrigin) {
      log("warn", "SECURE ORIGIN", "Mobile browsers may block WebRTC on LAN HTTP. Use localhost, HTTPS, or a trusted tunnel.");
    }
  }, [isSecureOrigin, log]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(formatClock()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      room.pingPeer();
    }, 3500);

    return () => window.clearInterval(timer);
  }, [room]);

  // Guest: report local buffering health once a second so the host can adapt
  // this peer's broadcast cadence (see usePeerRoom's adaptive interval logic).
  useEffect(() => {
    if (room.role !== "guest") {
      return;
    }

    const timer = window.setInterval(() => {
      const element = mediaRef.current;
      const bufferedAheadSecs = element ? getBufferedAheadSecs(element) : 0;
      room.reportSyncHealth(isStalledRef.current, bufferedAheadSecs);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [room.role, room]);

  // Host meter: show measured peer latency (one-way, EWMA-smoothed) in the
  // ring since the host has no upstream position to drift against. Guests
  // populate drift in handleRemotePlayback instead.
  useEffect(() => {
    if (room.role === "host" && room.status === "connected") {
      setDrift({ driftMs: room.latencyMs, mode: "hold", rate: 1 });
    }
  }, [room.role, room.status, room.latencyMs]);

  // Pause the host's own playback the moment a file upload to viewers starts
  // (rising edge only, so this doesn't re-fire on every progress tick). The
  // player surface gets locked/covered by a progress view for the duration —
  // see isUploadLocked — so there's nothing to resume until it finishes.
  const wasUploadingRef = useRef(false);
  useEffect(() => {
    const isUploading = room.role === "host" && !!room.fileSendProgress;
    if (isUploading && !wasUploadingRef.current) {
      mediaRef.current?.pause();
    }
    wasUploadingRef.current = isUploading;
  }, [room.role, room.fileSendProgress]);

  // Guest: request config from host on connect
  useEffect(() => {
    if (room.role === "guest" && room.status === "connected") {
      room.sendConfigRequest();
    }
  }, [room.role, room.status, room]);

  useEffect(() => {
    const channel = createLocalTabChannel((message) => {
      if (message.type === "hello") {
        log("ok", "LOCAL TAB", "Another SyncPlayer tab is available for same-device testing.");
        return;
      }

      if (message.type === "playback") {
        void handleRemotePlayback(message.payload, 0);
      }
    });

    if (!channel) {
      log("warn", "LOCAL TAB", "BroadcastChannel is unavailable in this browser.");
      return;
    }

    localTabChannelRef.current = channel;
    channel.post({ type: "hello" });
    const timer = window.setInterval(() => channel.post({ type: "hello" }), 3000);

    return () => {
      window.clearInterval(timer);
      channel.close();
      localTabChannelRef.current = null;
    };
  }, [handleRemotePlayback, log]);

  useEffect(() => {
    if (handledShareLinkRef.current) {
      return;
    }

    const payload = readSharePayloadFromUrl();

    if (!payload) {
      return;
    }

    handledShareLinkRef.current = true;

    if (payload.type === "invite") {
      setOpenedThroughRoomLink(true);
      if (payload.rtcConfig) {
        writeStoredRtcConfig(payload.rtcConfig);
        log("ok", "ICE", "TURN relay config loaded from invite link.");
      }

      if (payload.media?.origin === "remote-url") {
        mountRemoteMedia(payload.media.sourceUrl, "invite");
      }

      void room
        .joinWithOffer(payload.offer)
        .then((answer) => {
          if (!answer) {
            return;
          }

          const nextResponseLink = createShareUrl({
            type: "response",
            answer
          });

          copyText(nextResponseLink);
          log("ok", "SHARE", "Response link copied. Send it back to the room owner.");
        })
        .catch(() => log("error", "SHARE", "Could not join from this invite link."));
      return;
    }

    log("info", "SHARE", "Response link detected. Paste it into the open host tab to finish connecting.");
  }, [log, mountRemoteMedia, room]);

  const publishSnapshot = useCallback((isManual = false) => {
    const element = mediaRef.current;

    if (!element || !media || remoteApplyRef.current) {
      return;
    }

    const now = performance.now();
    const nextSnapshot = {
      mediaId: media.id,
      position: element.currentTime,
      duration: element.duration || 0,
      paused: element.paused,
      playbackRate: element.playbackRate
    };

    setSnapshot(nextSnapshot);

    if (now - lastBroadcastRef.current > 250 || isManual) {
      if (room.role === "host") {
        room.sendPlaybackState(nextSnapshot);
      }
      localTabChannelRef.current?.post({
        type: "playback",
        payload: nextSnapshot
      });
      lastBroadcastRef.current = now;
    }
  }, [media, room]);

  useEffect(() => {
    const timer = window.setInterval(() => publishSnapshot(false), 250);
    return () => window.clearInterval(timer);
  }, [publishSnapshot]);

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);

  useEffect(() => {
    if (room.role !== "guest") return;
    if (room.status !== "disconnected" && room.status !== "failed") {
      reconnectCountRef.current = 0;
      return;
    }
    if (!room.localOffer) return;

    const delay = Math.min(2000 * Math.pow(2, reconnectCountRef.current), 16000);
    reconnectCountRef.current += 1;

    log("warn", "GUEST", `Connection lost. Auto-reconnecting in ${delay / 1000}s (attempt ${reconnectCountRef.current})...`);

    reconnectTimerRef.current = setTimeout(() => {
      void room.joinWithOffer(room.localOffer);
    }, delay);

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.role, room.status, room.localOffer]);

  const copyActivityLogs = useCallback(() => {
    const formattedLogs = activity
      .slice()
      .reverse()
      .map((entry) => `[${entry.at}] [${entry.level.toUpperCase()}] ${entry.label}: ${entry.detail}`)
      .join("\n");
    copyText(formattedLogs);
    log("ok", "SHARE", "Activity logs copied to clipboard.");
  }, [activity, log]);

  // Shared handler for pause/resume/seek. Host and solo remain the simple
  // "just broadcast" case. Guests can now have their action reverse-sync to
  // the host too. Pause and seek share a rate-limit budget so a viewer can't
  // spam controls — beyond the budget, the action still happens locally
  // (nothing stops that) but isn't forwarded, so the host's next broadcast
  // quietly overrides it back, same as the old guest behavior. Resume is
  // exempt: it's not counted and never blocked, since a guest who paused
  // needs to be able to un-pause even after using up their budget.
  const handlePlaybackAction = useCallback(
    (action: GuestPlaybackAction) => {
      const element = mediaRef.current;
      if (!element || remoteApplyRef.current) {
        return;
      }

      if (room.role === "host" || room.role === "solo") {
        publishSnapshot(true);
        return;
      }

      if (room.role !== "guest") {
        return;
      }

      if (action !== "resume") {
        const now = performance.now();
        const recent = guestActionHistoryRef.current.filter((t) => now - t < GUEST_ACTION_WINDOW_MS);

        if (recent.length >= GUEST_ACTION_LIMIT) {
          guestActionHistoryRef.current = recent;
          const oldest = Math.min(...recent);
          const waitSecs = Math.ceil((GUEST_ACTION_WINDOW_MS - (now - oldest)) / 1000);
          log("warn", "SYNC", `Control rate limit reached. Wait ${waitSecs}s before another ${action} syncs to the room.`);
          return;
        }

        recent.push(now);
        guestActionHistoryRef.current = recent;
      }

      const snapshot: PlaybackSnapshot = {
        mediaId: mediaStateRef.current?.id ?? null,
        position: element.currentTime,
        duration: element.duration || 0,
        paused: element.paused,
        playbackRate: element.playbackRate
      };

      setSnapshot(snapshot);
      roomRef.current?.sendGuestAction(action, snapshot);
      log("ok", "SYNC", `Sent ${action} to host — syncing the room.`);
    },
    [room.role, publishSnapshot, log]
  );

  const handlePause = useCallback(() => handlePlaybackAction("pause"), [handlePlaybackAction]);
  const handleResume = useCallback(() => handlePlaybackAction("resume"), [handlePlaybackAction]);
  const handleSeeked = useCallback(() => handlePlaybackAction("seek"), [handlePlaybackAction]);

  const handleLoadedMetadata = useCallback(async () => {
    const element = mediaRef.current;

    if (!element || !media) {
      return;
    }

    const duration = element.duration || 0;
    setMedia({ ...media, durationSecs: duration });
    setSnapshot((current) => ({ ...current, duration }));
  }, [media]);

  const handleLocalFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];

      if (!file) {
        return;
      }
      event.currentTarget.value = "";

      cleanupOpfsFile();
      hostFileRef.current = file;
      const sourceUrl = URL.createObjectURL(file);
      const id = await createMediaHint(file.size, 0, file.lastModified);

      setMedia({
        id,
        title: file.name,
        sourceUrl,
        kind: inferMediaKind(file.type || file.name),
        format: inferMediaFormat(file.type || file.name),
        origin: "local-file",
        sizeBytes: file.size,
        modifiedMs: file.lastModified
      });
      setDrift(emptyDrift);
      driftHistoryRef.current = [];
      lastSeekAtRef.current = 0;
      isStalledRef.current = false;
      log("ok", "MEDIA", `${file.name} mounted as local source.`);

      // If already hosting a connected room, stream immediately to all peers
      if (room.role === "host" && room.connectedPeers.length > 0) {
        log("info", "FILE", `Streaming "${file.name}" to ${room.connectedPeers.length} connected peer(s)...`);
        void room.sendFile(file, id);
      }
    },
    [log, room]
  );

  // Late-join re-stream: when a new peer connects while host already has a local file
  const prevConnectedPeersRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevConnectedPeersRef.current;
    const curr = room.connectedPeers;
    const newPeers = curr.filter((p) => !prev.includes(p));
    prevConnectedPeersRef.current = curr;

    const currentMedia = mediaStateRef.current;
    if (newPeers.length > 0 && room.role === "host" && hostFileRef.current && currentMedia?.origin === "local-file") {
      log("info", "FILE", `New peer(s) connected: ${newPeers.join(", ")}. Streaming local file to them...`);
      void room.sendFile(hostFileRef.current, currentMedia.id, newPeers);
      return;
    }

    if (newPeers.length > 0 && room.role === "host" && currentMedia?.origin === "remote-url") {
      room.sendMediaMount({
        id: currentMedia.id,
        title: currentMedia.title,
        sourceUrl: currentMedia.sourceUrl,
        kind: currentMedia.kind,
        format: currentMedia.format,
        origin: "remote-url"
      });
      log("ok", "MEDIA", `URL media sent to new viewer(s): ${newPeers.join(", ")}.`);
    }
  }, [room.connectedPeers, room.role, room, log]);

  const handleRemoteUrl = useCallback(async () => {
    const url = remoteUrl.trim();

    if (!url) {
      return;
    }

    const nextMedia = mountRemoteMedia(url, "manual");
    if (nextMedia && room.role === "host" && room.connectedPeers.length > 0) {
      room.sendMediaMount({
        id: nextMedia.id,
        title: nextMedia.title,
        sourceUrl: nextMedia.sourceUrl,
        kind: nextMedia.kind,
        format: nextMedia.format,
        origin: "remote-url"
      });
      log("ok", "MEDIA", `URL media update sent to ${room.connectedPeers.length} viewer(s).`);
    }
  }, [log, mountRemoteMedia, remoteUrl, room]);

  const handleBrandHome = useCallback(() => {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    window.history.replaceState(null, "", baseUrl);
    setOpenedThroughRoomLink(false);
    log("info", "NAV", "Share URL removed from address bar.");
  }, [log]);

  const publishSnapshotRef = useRef(publishSnapshot);
  const handlePauseRef = useRef(handlePause);
  const handleResumeRef = useRef(handleResume);
  const handleSeekedRef = useRef(handleSeeked);
  const handleLoadedMetadataRef = useRef(handleLoadedMetadata);

  useEffect(() => {
    publishSnapshotRef.current = publishSnapshot;
  }, [publishSnapshot]);

  useEffect(() => {
    handlePauseRef.current = handlePause;
  }, [handlePause]);

  useEffect(() => {
    handleResumeRef.current = handleResume;
  }, [handleResume]);

  useEffect(() => {
    handleSeekedRef.current = handleSeeked;
  }, [handleSeeked]);

  useEffect(() => {
    handleLoadedMetadataRef.current = handleLoadedMetadata;
  }, [handleLoadedMetadata]);

  // Audio media loader
  useEffect(() => {
    const element = mediaRef.current;
    if (!element || !media || media.kind !== "audio") {
      return;
    }

    let disposed = false;
    let engineCleanup: (() => void) | undefined;

    element.pause();
    element.removeAttribute("src");
    element.load();

    const attachMedia = async () => {
      if (media.format === "hls") {
        if (element.canPlayType("application/vnd.apple.mpegurl")) {
          element.src = media.sourceUrl;
          element.load();
          log("ok", "HLS", "Using native HLS playback for audio.");
          return;
        }

        const { default: Hls } = await import("hls.js");

        if (disposed) {
          return;
        }

        if (!Hls.isSupported()) {
          log("error", "HLS", "This browser cannot play HLS audio streams.");
          return;
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          log("ok", "HLS", "HLS Audio manifest parsed and attached.");
          if (roomRef.current?.role === "host") {
            hls.on(Hls.Events.LEVEL_SWITCHED, () => {
              roomRef.current?.broadcastConfigChanged();
            });
            hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => {
              roomRef.current?.broadcastConfigChanged();
            });
          }
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          log(data.fatal ? "error" : "warn", "HLS", `${data.type}: ${data.details}`);
        });
        hls.loadSource(media.sourceUrl);
        hls.attachMedia(element);
        engineCleanup = () => {
          hls.destroy();
          hlsRef.current = null;
        };
        return;
      }

      if (media.format === "dash") {
        const dashjs = await import("dashjs");

        if (disposed) {
          return;
        }

        if (!dashjs.supportsMediaSource()) {
          log("error", "DASH", "This browser cannot play MPEG-DASH audio streams.");
          return;
        }

        const player = dashjs.MediaPlayer().create();
        dashRef.current = player;
        player.initialize(element, media.sourceUrl, false);
        log("ok", "DASH", "MPEG-DASH audio manifest attached.");
        if (roomRef.current?.role === "host") {
          player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, () => {
            roomRef.current?.broadcastConfigChanged();
          });
          player.on(dashjs.MediaPlayer.events.TRACK_CHANGE_RENDERED, (e: { mediaType: string }) => {
            if (e.mediaType === "text") {
              roomRef.current?.broadcastConfigChanged();
            }
          });
        }
        engineCleanup = () => {
          player.reset();
          dashRef.current = null;
        };
        return;
      }

      element.src = media.sourceUrl;
      element.load();
    };

    void attachMedia().catch((error: unknown) => {
      log("error", "MEDIA", error instanceof Error ? error.message : "Media engine failed to attach audio.");
    });

    return () => {
      disposed = true;
      engineCleanup?.();
      element.removeAttribute("src");
      element.load();
    };
  }, [log, media?.format, media?.id, media?.sourceUrl, media?.kind]);

  // Video media loader via ArtPlayer
  useEffect(() => {
    const container = artplayerContainerRef.current;
    if (!container || !media || media.kind !== "video") {
      return;
    }

    // Revoke any stale blob URL now that the old ArtPlayer instance is destroyed
    if (staleBlobUrlRef.current) {
      URL.revokeObjectURL(staleBlobUrlRef.current);
      staleBlobUrlRef.current = null;
    }

    if (artRef.current) {
      artRef.current.destroy(true);
      artRef.current = null;
    }

    // ArtPlayer throws if `type` is explicitly `undefined`; only include it for
    // custom-loaded stream formats (hls → m3u8, dash → mpd).
    const streamType =
      media.format === "hls" ? "m3u8" : media.format === "dash" ? "mpd" : null;

    const art = new Artplayer({
      container,
      url: media.sourceUrl,
      ...(streamType ? { type: streamType } : {}),
      theme: "#37f3ff",
      volume: 0.7,
      muted: false,
      autoplay: false,
      playbackRate: true,
      aspectRatio: true,
      setting: true,
      hotkey: true,
      pip: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      playsInline: true,
      airplay: true,
      mutex: false,
      autoPlayback: false,
      lock: false,
      customType: {
        m3u8: function (video, url, artInstance) {
          import("hls.js").then(({ default: Hls }) => {
            if (!Hls.isSupported()) {
              if (video.canPlayType("application/vnd.apple.mpegurl")) {
                video.src = url;
              } else {
                log("error", "HLS", "HLS is not supported in this browser.");
              }
              return;
            }
            const hls = new Hls({
              enableWorker: true,
              lowLatencyMode: true
            });
            hlsRef.current = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              log("ok", "HLS", "HLS stream manifest attached to ArtPlayer.");
              // Host: detect quality/subtitle changes and notify guests
              if (roomRef.current?.role === "host") {
                hls.on(Hls.Events.LEVEL_SWITCHED, () => {
                  roomRef.current?.broadcastConfigChanged();
                });
                hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, () => {
                  roomRef.current?.broadcastConfigChanged();
                });
              }
            });
            hls.on(Hls.Events.ERROR, (_, data) => {
              log(data.fatal ? "error" : "warn", "HLS", `${data.type}: ${data.details}`);
            });
            artInstance.on("destroy", () => {
              hls.destroy();
              hlsRef.current = null;
            });
          });
        },
        mpd: function (video, url, artInstance) {
          import("dashjs").then((dashjs) => {
            if (!dashjs.supportsMediaSource()) {
              log("error", "DASH", "MPEG-DASH is not supported in this browser.");
              return;
            }
            const player = dashjs.MediaPlayer().create();
            dashRef.current = player;
            player.initialize(video, url, false);
            log("ok", "DASH", "MPEG-DASH stream attached to ArtPlayer.");
            // Host: detect quality/subtitle changes and notify guests
            if (roomRef.current?.role === "host") {
              player.on(dashjs.MediaPlayer.events.QUALITY_CHANGE_RENDERED, () => {
                roomRef.current?.broadcastConfigChanged();
              });
              player.on(dashjs.MediaPlayer.events.TRACK_CHANGE_RENDERED, (e: { mediaType: string }) => {
                if (e.mediaType === "text") {
                  roomRef.current?.broadcastConfigChanged();
                }
              });
            }
            artInstance.on("destroy", () => {
              player.reset();
              dashRef.current = null;
            });
          });
        }
      }
    });

    artRef.current = art;

    art.on("error", (error: unknown, detail?: unknown) => {
      const ctx: Record<string, unknown> = { src: media.sourceUrl, format: media.format };
      if (error instanceof Event && error.target) {
        const video = error.target as HTMLVideoElement;
        ctx.videoError = video.error ? { code: video.error.code, message: video.error.message } : null;
        ctx.readyState = video.readyState;
        ctx.networkState = video.networkState;
        log("error", "PLAYER", `Video error event: readyState=${video.readyState} networkState=${video.networkState} error=${video.error ? JSON.stringify({ code: video.error.code, msg: video.error.message }) : "none"}`);
      } else if (error instanceof Error) {
        ctx.stack = error.stack?.slice(0, 300);
        log("error", "PLAYER", `Video exception: ${error.message}`);
      } else {
        ctx.detail = String(detail ?? error);
        log("error", "PLAYER", `Video load failed: ${String(error)} (detail: ${String(detail)})`);
      }
      log("warn", "PLAYER-DEBUG", `Source: ${media.sourceUrl} | Format: ${media.format} | Kind: ${media.kind} | Info: ${JSON.stringify(ctx)}`);

      // Recover dead blob URLs by regenerating from the persisted OPFS file handle.
      // The handle stays alive in a ref, so getFile() returns a fresh lazy File.
      if (media.sourceUrl.startsWith("blob:") && opfsFileHandleRef.current) {
        log("warn", "PLAYER", "Blob URL appears dead, regenerating from OPFS file handle...");
        opfsFileHandleRef.current.getFile().then((file) => {
          const newUrl = URL.createObjectURL(file);
          guestFileRef.current = file;
          staleBlobUrlRef.current = media.sourceUrl;
          setMedia(prev => prev ? { ...prev, sourceUrl: newUrl } : null);
        }).catch(() => {
          log("error", "PLAYER", "Failed to regenerate blob URL from OPFS handle.");
        });
      }
    });

    art.on("fullscreen", (state) => {
      if (state) {
        if (screen.orientation && "lock" in screen.orientation) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (screen.orientation as any).lock("landscape").catch(() => { });
        }
      } else {
        if (screen.orientation && "unlock" in screen.orientation) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (screen.orientation as any).unlock();
        }
      }
    });

    art.on("ready", () => {
      const video = art.video;
      mediaRef.current = video;

      const onPlay = () => handleResumeRef.current();
      const onPause = () => handlePauseRef.current();
      const onSeeked = () => handleSeekedRef.current();
      const onRateChange = () => publishSnapshotRef.current(true);
      const onLoadedMetadata = () => handleLoadedMetadataRef.current();
      const onWaiting = () => { isStalledRef.current = true; };
      const onPlaying = () => { isStalledRef.current = false; };

      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("ratechange", onRateChange);
      video.addEventListener("loadedmetadata", onLoadedMetadata);
      video.addEventListener("waiting", onWaiting);
      video.addEventListener("playing", onPlaying);

      if (video.duration) {
        onLoadedMetadata();
      }

      art.on("destroy", () => {
        video.removeEventListener("play", onPlay);
        video.removeEventListener("pause", onPause);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("ratechange", onRateChange);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("waiting", onWaiting);
        video.removeEventListener("playing", onPlaying);
      });
    });

    return () => {
      if (artRef.current) {
        artRef.current.destroy(true);
        artRef.current = null;
      }
      mediaRef.current = null;
    };
  }, [log, media?.format, media?.id, media?.sourceUrl, media?.kind]);

  const statusTone = room.status === "connected" ? "ok" : room.status === "failed" ? "warn" : "normal";
  const mediaIcon = media?.kind === "audio" ? <AudioLines size={17} /> : <FileVideo size={17} />;

  // While the host is actively streaming a local file to viewers, lock the
  // player surface and show upload progress instead — keeps the host from
  // getting a head start on playback (or drifting into a big correction)
  // while viewers are still receiving the file.
  const isUploadLocked = room.role === "host" && !!room.fileSendProgress;

  const driftTone = useMemo(() => {
    if (drift.mode === "hold" || drift.mode === "soft") {
      return "ok";
    }

    return "warn";
  }, [drift.mode]);

  // Display drift in seconds once it crosses 1s to keep digit counts short;
  // otherwise show whole milliseconds.
  const { meterValue, meterUnit } = useMemo(() => {
    const abs = Math.abs(drift.driftMs);
    if (abs >= 1000) {
      return { meterValue: (drift.driftMs / 1000).toFixed(2), meterUnit: "S" };
    }
    return { meterValue: String(Math.round(abs)), meterUnit: "MS" };
  }, [drift.driftMs]);

  return (
    <main className="deck">
      <div className="scanlines" />

      <header className="topbar">
        <button type="button" className="brand brand--button" onClick={handleBrandHome} aria-label="Go to SyncPlayer home">
          <span className="brand__mark">
            <Radar size={24} />
          </span>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <strong>SyncPlayer</strong>
              {openedThroughRoomLink && (
                <span className="brand__badge">ROOM LINK CONNECTED</span>
              )}
            </div>
            <span>Command Deck</span>
          </div>
        </button>

        <div className="topbar__status">
          <span>
            <Shield size={15} />
            "JS CORE READY"
          </span>
          <span>
            <Signal size={15} />
            {room.status.toUpperCase()}
          </span>
          {!isSecureOrigin ? <span>LAN HTTP LIMITED</span> : null}
          <span>{clock}</span>
        </div>
      </header>

      {!isSecureOrigin ? (
        <div className="warning-band">
          Mobile Firefox may block WebRTC on this LAN HTTP address. The page can load, but peer sync may fail until the
          app is opened from a secure origin.
        </div>
      ) : null}

      {room.status === "connected" ? (
        <div className="status-band status-band--success">
          <div className="status-band__content">
            <div className="status-band__icon status-band__icon--pulse">
              <RadioTower size={18} />
            </div>
            <div className="status-band__text-group">
              <span className="status-band__title">Live Session Synchronized</span>
              <span className="status-band__desc">
                {room.role === "guest"
                  ? `Connected to Host (${room.connectedPeers[0] || "Unknown"}). Your playback is locked to the host's timeline. Delay is ${room.latencyMs}ms.`
                  : `Hosting Active Room. Connected to ${room.connectedPeers.length} viewer(s): ${room.connectedPeers.join(", ")}. Broadcast stream running. Peer latency is ${room.latencyMs}ms.`}
              </span>
            </div>
          </div>
          <div className="status-band__actions">
            {room.role === "host" && (
              <button type="button" className="status-band__btn" onClick={() => publishSnapshot(true)}>
                Force Sync State
              </button>
            )}
            <button type="button" className="status-band__btn" onClick={room.closeRoom}>
              Disconnect
            </button>
          </div>
        </div>
      ) : room.role === "guest" && room.status === "pairing" ? (
        <div className="status-band status-band--warn">
          <div className="status-band__content">
            <div className="status-band__icon status-band__icon--pulse">
              <Radar size={18} />
            </div>
            <div className="status-band__text-group">
              <span className="status-band__title">Connecting to Room Host...</span>
              <span className="status-band__desc">
                Establishing automated WebRTC link to Host room <strong>{formatRoomId(room.localOffer)}</strong>. Please wait while signaling completes...
              </span>
            </div>
          </div>
          <div className="status-band__actions">
            <button type="button" className="status-band__btn" onClick={room.closeRoom}>
              Cancel Join
            </button>
          </div>
        </div>
      ) : room.role === "guest" && room.status === "failed" ? (
        <div className="status-band status-band--error">
          <div className="status-band__content">
            <div className="status-band__icon">
              <AlertTriangle size={18} />
            </div>
            <div className="status-band__text-group">
              <span className="status-band__title">Connection Failed</span>
              <span className="status-band__desc">
                Could not connect to Host room <strong>{formatRoomId(room.localOffer)}</strong>. Check the Activity Log below for details.
              </span>
            </div>
          </div>
          <div className="status-band__actions">
            <button type="button" className="status-band__btn primary-action" onClick={() => void room.joinWithOffer(room.localOffer)}>
              Retry Connection
            </button>
            <button type="button" className="status-band__btn" onClick={room.closeRoom}>
              Cancel Join
            </button>
          </div>
        </div>
      ) : room.role === "host" && inviteLink ? (
        <div className="status-band status-band--info">
          <div className="status-band__content">
            <div className="status-band__icon status-band__icon--pulse">
              <Radar size={18} />
            </div>
            <div className="status-band__text-group">
              <span className="status-band__title">Room Hosted — Waiting for Viewers</span>
              <span className="status-band__desc">
                Room is online. Share the invite link with viewers to synchronize your media playback automatically.
              </span>
            </div>
          </div>
          <div className="status-band__actions">
            <button type="button" className="status-band__btn" onClick={room.closeRoom}>
              Cancel Room
            </button>
          </div>
        </div>
      ) : null}

      <section className="deck__grid">
        <aside className="left-rail">
          <Panel title="Session" icon={<RadioTower size={15} />}>
            <div className="metrics-grid">
              <Metric label="ROLE" value={room.role.toUpperCase()} tone={room.role === "solo" ? "normal" : "ok"} />
              <Metric label="LINK" value={room.status.toUpperCase()} tone={statusTone} />
            </div>
          </Panel>

          <Panel title="Sync Core" icon={<Gauge size={15} />}>
            <div className="sync-meter">
              <div className="sync-meter__ring">
                <div className="sync-meter__value">
                  <span className={cx("sync-meter__num", meterValue.length > 3 && "sync-meter__num--sm")}>{meterValue}</span>
                  <small>{meterUnit}</small>
                </div>
              </div>
              <div>
                <span className={cx("status-pill", `status-pill--${driftTone}`)}>{drift.mode.toUpperCase()}</span>
                <p>Correction rate {drift.rate.toFixed(2)}x</p>
              </div>
            </div>
          </Panel>

          <Panel title="Media Identity" icon={mediaIcon}>
            <div className="identity-block">
              <strong>{media?.title || "No media mounted"}</strong>
              <span>{media?.id || "Awaiting local file or direct URL"}</span>
            </div>
            <div className="metrics-grid">
              <Metric label="ORIGIN" value={media?.origin?.replace("-", " ").toUpperCase() || "EMPTY"} />
              <Metric label="TYPE" value={media?.kind?.toUpperCase() || "UNKNOWN"} />
              <Metric label="FORMAT" value={media ? mediaFormatLabel(media.format) : "UNKNOWN"} />
              <Metric label="SIZE" value={formatBytes(media?.sizeBytes || 0)} />
              <Metric label="DURATION" value={formatDuration(media?.durationSecs || snapshot.duration)} />
            </div>
            {room.role !== "guest" && (
              <button type="button" onClick={() => publishSnapshot(true)} style={{ marginTop: "0.6rem", width: "100%" }}>
                <CircleDot size={14} />
                Send Current Playback State
              </button>
            )}
          </Panel>
        </aside>

        <section className="main-stage">
          <div className="control-strip">
            <label className={cx("file-button", isUploadLocked && "file-button--disabled")}>
              <Upload size={16} />
              Select File
              <input accept="audio/*,video/*" type="file" onChange={handleLocalFile} disabled={isUploadLocked} />
            </label>
            <div className="url-loader">
              <Link2 size={16} />
              <input
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleRemoteUrl();
                  }
                }}
                placeholder="Paste MP4, MP3, M3U8, MPD, WebM..."
                aria-label="Remote media URL, including MP4, WebM, M3U8, MPD, MP3, WAV, or OGG"
                disabled={isUploadLocked}
              />
              <button type="button" onClick={handleRemoteUrl} disabled={isUploadLocked}>
                <Send size={15} />
                Load URL
              </button>
            </div>
          </div>

          <Panel title="Playback Surface" icon={<Video size={15} />} className="player-panel">
            {/* Guest receive progress bar */}
            {guestStreamMeta && room.fileReceiveProgress && (
              <FileProgressBar
                label={guestStreamMeta.isBlob ? "Receiving file" : "Streaming"}
                fileName={guestStreamMeta.fileName}
                chunksDone={room.fileReceiveProgress.chunksReceived}
                total={room.fileReceiveProgress.total}
                totalBytes={room.fileReceiveProgress.totalBytes}
                style={{ marginBottom: "1rem" }}
              />
            )}
            <div className="player-shell">
              {media ? (
                media.kind === "audio" ? (
                  <div className="audio-stage">
                    <AudioLines size={76} />
                    <strong>{media.title}</strong>
                    <audio
                      ref={bindMediaElement}
                      controls
                      onLoadedMetadata={handleLoadedMetadata}
                      onPlay={handleResume}
                      onPause={handlePause}
                      onSeeked={handleSeeked}
                      onRateChange={() => publishSnapshot(true)}
                      onTimeUpdate={() => publishSnapshot(false)}
                      onWaiting={() => { isStalledRef.current = true; }}
                      onPlaying={() => { isStalledRef.current = false; }}
                    />
                  </div>
                ) : (
                  <div
                    ref={artplayerContainerRef}
                    className="artplayer-container"
                  />
                )
              ) : (
                <div className="empty-player">
                  <ScanLine size={54} />
                  <strong>{guestStreamMeta ? `Receiving "${guestStreamMeta.fileName}"...` : "Mount media to begin"}</strong>
                  <span>{guestStreamMeta ? `${guestStreamMeta.isBlob ? "Full file transfer" : "MSE progressive stream"} in progress` : "Local files stream to viewers automatically over P2P."}</span>
                </div>
              )}

              {/* Host controls are locked and the player is covered while a
                  local file streams to viewers, so nobody gets a head start
                  on watching before everyone actually has the file. */}
              {isUploadLocked && room.fileSendProgress && (
                <div className="upload-lock-overlay">
                  <Lock size={40} />
                  <strong>Uploading to viewers</strong>
                  <span>
                    Playback is locked until "{room.fileSendProgress.fileName}" finishes sending to{" "}
                    {room.connectedPeers.length} viewer{room.connectedPeers.length === 1 ? "" : "s"}.
                  </span>
                  <FileProgressBar
                    label="Sending"
                    fileName={room.fileSendProgress.fileName}
                    chunksDone={room.fileSendProgress.chunksSent}
                    total={room.fileSendProgress.total}
                    totalBytes={room.fileSendProgress.totalBytes}
                    style={{ width: "min(28rem, 100%)" }}
                  />
                </div>
              )}
            </div>
          </Panel>
        </section>

        <aside className="right-rail">
          <Panel title="Share Room" icon={<Link2 size={15} />}>
            <div className="helper-copy">
              <strong>How sharing works</strong>
              <p>
                Start a room to get your 4-digit code. Share it with viewers — or use the invite link for one-click joining.
              </p>
            </div>

            <div className="share-flow">
              {room.role === "host" && inviteLink ? (
                <button type="button" className="primary-action" onClick={() => { copyText(inviteLink); log("ok", "SHARE", "Invite link copied to clipboard."); }}>
                  <Clipboard size={15} />
                  Copy Invite Link
                </button>
              ) : (
                <button type="button" className="primary-action" onClick={createInviteLink}>
                  <Clipboard size={15} />
                  {roomActionLabel}
                </button>
              )}
              <button type="button" onClick={room.closeRoom}>
                <Pause size={15} />
                End Room
              </button>
            </div>

            {/* ── QR Code Toggle — shown when an invite link exists ── */}
            {inviteLink && (
              <div className="qr-toggle-row">
                <button type="button" className="qr-toggle" onClick={() => setShowQr(true)}>
                  <QrCode size={14} />
                  Show QR Code
                </button>
              </div>
            )}

            {/* ── Room Code — shown when hosting ── */}
            {room.role === "host" && room.roomCode && (
              <div className="room-code-display">
                <span className="section-title">
                  <Hash size={11} />
                  Room Code
                </span>
                <div className="room-code-badge">
                  <span className="room-code-digits">{room.roomCode}</span>
                </div>
                <button
                  type="button"
                  className="room-code-copy"
                  onClick={() => {
                    copyText(room.roomCode);
                    log("ok", "SHARE", `Room code ${room.roomCode} copied to clipboard.`);
                  }}
                >
                  <Clipboard size={13} />
                  Copy Code
                </button>
                <p className="room-code-hint">Viewers can type this 4-digit code to join instantly.</p>
              </div>
            )}

            {/* ── Join by Code — shown when not yet in a room ── */}
            {room.role === "solo" && (room.status === "idle" || room.status === "disconnected") && (
              <div className="join-by-code">
                <span className="section-title">
                  <LogIn size={11} />
                  Join a Room
                </span>
                <div className="code-input-row">
                  <input
                    id="room-code-input"
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleJoinByCode(); }}
                    placeholder="1234"
                    className="room-code-input"
                    aria-label="4-digit room code"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => void handleJoinByCode()}
                    disabled={joinCode.length !== 4}
                    className={joinCode.length === 4 ? "primary-action" : ""}
                  >
                    <LogIn size={14} />
                    Join
                  </button>
                </div>
              </div>
            )}

            {/* Host send progress bar */}
            {room.fileSendProgress && (
              <FileProgressBar
                label="Streaming to peers"
                fileName={room.fileSendProgress.fileName}
                chunksDone={room.fileSendProgress.chunksSent}
                total={room.fileSendProgress.total}
                totalBytes={room.fileSendProgress.totalBytes}
              />
            )}

            <div className="connected-peers">
              <span className="section-title">Connected Viewers ({room.connectedPeers.length})</span>
              {room.connectedPeers.length === 0 ? (
                <div className="empty-peers">No viewers connected yet.</div>
              ) : (
                <ul className="peer-list">
                  {room.connectedPeers.map((peer, idx) => (
                    <li key={peer} className="peer-item">
                      <span className="peer-status-dot" />
                      <span className="peer-id">{peer}</span>
                      <span className="peer-label">{peer.startsWith("SP-GUEST") ? `Viewer (${peer.slice(9)})` : `Peer ${idx + 1}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

          </Panel>
        </aside>
      </section>

      <footer className="bottom-console">
        <ActivityLogPanel activity={activity} onCopyLogs={copyActivityLogs} />

        <Panel title="About SyncPlayer" className="telemetry-panel">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem', color: 'rgba(255, 255, 255, 0.7)', padding: '0.5rem' }}>
            <p style={{ margin: 0 }}>
              SyncPlayer is an open-source, peer-to-peer synchronized media player.
            </p>
            <a href="https://github.com/animegamer4422/SyncPlayer" target="_blank" rel="noreferrer" style={{ color: 'var(--brand-primary)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Github size={15} style={{ transform: 'translateY(1px)' }} />
              <span>github.com/animegamer4422/SyncPlayer</span>
            </a>
          </div>
        </Panel>
      </footer>

      {/* ── QR Code Modal ── */}
      {showQr && inviteLink && (
        <QrModal url={inviteLink} onClose={() => setShowQr(false)} />
      )}
    </main>
  );
}