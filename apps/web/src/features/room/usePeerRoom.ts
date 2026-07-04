import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Peer, DataConnection, type PeerJSOption } from "peerjs";
import type { PlaybackSnapshot, WireMessage, FileMeta, RemoteMediaMount, PlaybackConfig } from "@/lib/webrtc/messages";
import { CHUNK_SIZE } from "@/lib/webrtc/messages";
import { smoothLatencySync } from "@/lib/wasm/syncCore";

type RoomRole = "solo" | "host" | "guest";
type LinkStatus = "idle" | "pairing" | "connected" | "disconnected" | "failed";
type ExtendedRTCConfiguration = RTCConfiguration & { sdpSemantics?: "unified-plan" };
type StoredPeerOptions = PeerJSOption & { config?: ExtendedRTCConfiguration };

export type FileStreamHandlers = {
  onChunk: (index: number, total: number, data: Uint8Array, checksum: string) => void;
  onEnd: (checksum: string) => void;
  onProgress?: (chunksReceived: number, total: number) => void;
};

export type FileSendProgress = {
  mediaId: string;
  fileName: string;
  chunksSent: number;
  total: number;
  totalBytes: number;
};

export type FileReceiveProgress = {
  mediaId: string;
  fileName: string;
  chunksReceived: number;
  total: number;
  totalBytes: number;
};

type PeerRoomOptions = {
  onPlaybackState: (snapshot: PlaybackSnapshot, latencyMs: number) => void;
  onEvent: (level: "info" | "ok" | "warn" | "error", label: string, detail: string) => void;
  onFileStream?: (meta: FileMeta) => FileStreamHandlers;
  onMediaMount?: (media: RemoteMediaMount) => void;
  onConfigRequest?: (conn: DataConnection) => void;
  onConfigState?: (config: PlaybackConfig) => void;
  onConfigChanged?: () => void;
};

function readStoredPeerOptions() {
  try {
    const stored = localStorage.getItem("syncplayer:peerserver");
    if (stored) return JSON.parse(stored) as StoredPeerOptions;
  } catch { /* ignore */ }
  return null;
}

// ─── Default PeerJS server (overridable via localStorage) ────────────────────
function getPeerServerConfig() {
  const stored = readStoredPeerOptions();
  if (!stored) return null; // null → PeerJS uses 0.peerjs.com by default

  const { config: _config, ...peerOptions } = stored;
  return peerOptions;
}

function getCustomRtcConfig() {
  try {
    const stored = localStorage.getItem("syncplayer:rtcconfig");
    if (stored) return JSON.parse(stored) as ExtendedRTCConfiguration;
  } catch { /* ignore */ }

  return readStoredPeerOptions()?.config ?? null;
}

function createRtcConfig(relayOnly = false): ExtendedRTCConfiguration {
  const customConfig = getCustomRtcConfig();
  const customIceServers = customConfig?.iceServers ?? [];
  const iceServers = customIceServers.length > 0 ? customIceServers : rtcConfig.iceServers;

  return {
    ...rtcConfig,
    ...customConfig,
    iceServers,
    iceTransportPolicy: relayOnly ? "relay" : customConfig?.iceTransportPolicy ?? rtcConfig.iceTransportPolicy
  };
}

function createPeer(peerId: string, relayOnly = false) {
  const serverConfig = getPeerServerConfig();
  return new Peer(peerId, {
    ...serverConfig,
    config: createRtcConfig(relayOnly),
    debug: 2
  });
}

function describeConnectionError(error: { type?: string; message?: string }) {
  if (error.type === "negotiation-failed") {
    return `${error.message ?? "Negotiation failed"} ICE could not find a working route. Keep the host tab open, use HTTPS for LAN/mobile, and retry after VPN/firewall changes.`;
  }

  if (error.type === "peer-unavailable") {
    return `${error.message ?? "Peer unavailable"} The host room is not registered on the signaling broker yet or was closed.`;
  }

  return error.message ?? "Unknown WebRTC error.";
}

function waitForPeerOpen(peer: Peer, timeoutMs = 10000) {
  return new Promise<string>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Timed out waiting for PeerJS signaling broker."));
    }, timeoutMs);

    peer.once("open", (id) => {
      window.clearTimeout(timeout);
      resolve(id);
    });

    peer.once("error", (error) => {
      window.clearTimeout(timeout);
      reject(error);
    });
  });
}

function getCandidateType(candidate: string) {
  return / typ (host|srflx|prflx|relay)(?: |$)/.exec(candidate)?.[1] ?? "unknown";
}

function setupConnectionDiagnostics(
  conn: DataConnection,
  peerLabel: string,
  onEvent: (level: "info" | "ok" | "warn" | "error", label: string, detail: string) => void
) {
  const pc = conn.peerConnection;
  if (!pc) {
    onEvent("warn", "ICE", `${peerLabel}: peer connection diagnostics unavailable.`);
    return;
  }

  const candidateTypes = new Set<string>();

  pc.addEventListener("icecandidate", (event) => {
    if (!event.candidate) {
      const types = candidateTypes.size > 0 ? [...candidateTypes].join(", ") : "none";
      onEvent("info", "ICE", `${peerLabel}: candidate gathering complete. Candidate types: ${types}.`);
      return;
    }

    const type = getCandidateType(event.candidate.candidate);
    if (candidateTypes.has(type)) return;

    candidateTypes.add(type);
    onEvent(
      type === "relay" ? "ok" : "info",
      "ICE",
      `${peerLabel}: discovered ${type} candidate${type === "relay" ? " through TURN" : ""}.`
    );
  });

  pc.addEventListener("icecandidateerror", (event) => {
    const error = event as Event & { url?: string; errorCode?: number; errorText?: string };
    onEvent(
      "warn",
      "ICE",
      `${peerLabel}: ICE server error${error.url ? ` via ${error.url}` : ""}${error.errorCode ? ` (${error.errorCode})` : ""}${error.errorText ? `: ${error.errorText}` : "."}`
    );
  });

  pc.addEventListener("icegatheringstatechange", () => {
    onEvent("info", "ICE", `${peerLabel}: gathering state ${pc.iceGatheringState}.`);
  });

  pc.addEventListener("connectionstatechange", () => {
    const level = pc.connectionState === "failed" ? "error" : pc.connectionState === "connected" ? "ok" : "info";
    onEvent(level, "ICE", `${peerLabel}: peer connection state ${pc.connectionState}.`);
  });

  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "disconnected") {
      onEvent("warn", "ICE", `${peerLabel}: ICE disconnected. Attempting ICE restart...`);
      pc.restartIce();
    }
  });
}

const rtcConfig: ExtendedRTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    {
      urls: [
        "turn:eu-0.turn.peerjs.com:3478",
        "turn:us-0.turn.peerjs.com:3478",
        "turn:relay.backups.cz:3478"
      ],
      username: "peerjs",
      credential: "peerjsp"
    }
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: "all"
};

// Pause sending when the channel buffer exceeds 4 MB
const FLOW_HIGH_WATERMARK = 4 * 1024 * 1024;
// Resume when it drains below 256 KB
const FLOW_LOW_WATERMARK = 256 * 1024;

// ─── Adaptive per-peer playback.state broadcast cadence ──────────────────────
// A slow/lossy peer will report repeated buffering via "sync.health". Rather
// than slowing every peer down uniformly, each peer gets its own broadcast
// interval that steps up on repeated stalls and steps back down once the peer
// reports healthy for a while.
const BROADCAST_STEPS_MS = [250, 500, 750, 1000];
const STALL_ESCALATE_THRESHOLD = 3;
const HEALTHY_DEESCALATE_THRESHOLD = 8;

type PeerHealthState = {
  intervalMs: number;
  lastSentAt: number;
  stallStreak: number;
  healthyStreak: number;
};

function getDataChannel(conn: DataConnection) {
  return conn.dataChannel ?? (conn as unknown as { _dc?: RTCDataChannel })._dc ?? null;
}

/** Wait until conn's bufferedAmount drops below the low watermark. */
function waitForDrain(conn: DataConnection): Promise<void> {
  return new Promise((resolve) => {
    const channel = getDataChannel(conn);
    const peerBufferSize = (conn as unknown as { bufferSize?: number }).bufferSize ?? 0;
    if (!channel || (channel.bufferedAmount < FLOW_LOW_WATERMARK && peerBufferSize === 0)) {
      resolve();
      return;
    }

    channel.bufferedAmountLowThreshold = FLOW_LOW_WATERMARK;
    const interval = setInterval(() => {
      const buffered = channel.bufferedAmount;
      const queued = (conn as unknown as { bufferSize?: number }).bufferSize ?? 0;
      if (buffered < FLOW_LOW_WATERMARK && queued === 0) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

/** Generate a 4-digit numeric room code (1000–9999). */
function genRoomCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

export function usePeerRoom({ onPlaybackState, onEvent, onFileStream, onMediaMount, onConfigRequest, onConfigState, onConfigChanged }: PeerRoomOptions) {
  const [role, setRole] = useState<RoomRole>("solo");
  const [status, setStatus] = useState<LinkStatus>("idle");
  const [localOffer, setLocalOffer] = useState("");
  const [remotePeer, setRemotePeer] = useState("Awaiting peer");
  const [latencyMs, setLatencyMs] = useState(0);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [fileSendProgress, setFileSendProgress] = useState<FileSendProgress | null>(null);
  const [fileReceiveProgress, setFileReceiveProgress] = useState<FileReceiveProgress | null>(null);

  const peerId = useMemo(() => `SP-${genRoomCode()}`, []);


  // Stable callback refs — prevent stale closures in DataChannel listeners
  const onPlaybackStateRef = useRef(onPlaybackState);
  const onEventRef = useRef(onEvent);
  const onFileStreamRef = useRef(onFileStream);
  const onMediaMountRef = useRef(onMediaMount);
  const onConfigRequestRef = useRef(onConfigRequest);
  const onConfigStateRef = useRef(onConfigState);
  const onConfigChangedRef = useRef(onConfigChanged);
  useEffect(() => {
    onPlaybackStateRef.current = onPlaybackState;
    onEventRef.current = onEvent;
    onFileStreamRef.current = onFileStream;
    onMediaMountRef.current = onMediaMount;
    onConfigRequestRef.current = onConfigRequest;
    onConfigStateRef.current = onConfigState;
    onConfigChangedRef.current = onConfigChanged;
  }, [onPlaybackState, onEvent, onFileStream, onMediaMount, onConfigRequest, onConfigState, onConfigChanged]);

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  const pingRef = useRef<{ id: string; at: number } | null>(null);
  const joinAttemptRef = useRef(0);
  // Rolling RTT window for EWMA smoothing (last 8 samples)
  const rttSamplesRef = useRef<number[]>([]);
  // Active FileStreamHandlers keyed by mediaId (guest side)
  const fileStreamHandlersRef = useRef<Map<string, FileStreamHandlers>>(new Map());
  // Host-side: per-guest-peer adaptive broadcast cadence state, keyed by conn.peer.
  const peerHealthRef = useRef<Map<string, PeerHealthState>>(new Map());

  const closeRoom = useCallback(() => {
    onEventRef.current("info", "ROOM", "Initiating room closure. Terminating all peer connections.");
    connectionsRef.current.forEach((conn) => {
      onEventRef.current("info", "WEBRTC", `Closing connection to peer: ${conn.peer}`);
      conn.close();
    });
    connectionsRef.current = [];

    if (peerRef.current) {
      onEventRef.current("info", "PEERJS", "Destroying PeerJS instance and signaling socket.");
      peerRef.current.destroy();
      peerRef.current = null;
    }

    setStatus("idle");
    setRole("solo");
    setRemotePeer("Awaiting peer");
    setConnectedPeers([]);
    setLocalOffer("");
    setFileSendProgress(null);
    setFileReceiveProgress(null);
    fileStreamHandlersRef.current.clear();
    peerHealthRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      if (peerRef.current) {
        peerRef.current.destroy();
      }
    };
  }, []);

  const sendToOne = useCallback((conn: DataConnection, type: WireMessage["type"], payload: WireMessage["payload"]) => {
    if (!conn.open) return;
    conn.send({ id: crypto.randomUUID(), type, sentAt: performance.now(), payload });
  }, []);

  const send = useCallback((type: WireMessage["type"], payload: WireMessage["payload"]) => {
    const conns = connectionsRef.current;
    if (conns.length === 0) return;

    const seenPeers = new Set<string>();
    
    conns.forEach((conn) => {
      if (conn.open && !seenPeers.has(conn.peer)) {
        seenPeers.add(conn.peer);
        sendToOne(conn, type, payload);
      }
    });
  }, [sendToOne]);



  // Broadcasts playback state, but gates each peer independently against its
  // own adaptive interval (see peerHealthRef) instead of sending to everyone
  // on a fixed cadence. A peer with no reported health yet uses the fastest
  // (250ms) interval.
  const sendPlaybackState = useCallback(
    (snapshot: PlaybackSnapshot) => {
      const conns = connectionsRef.current;
      if (conns.length === 0) return;

      const now = performance.now();
      const seenPeers = new Set<string>();

      conns.forEach((conn) => {
        if (!conn.open || seenPeers.has(conn.peer)) return;
        seenPeers.add(conn.peer);

        const state = peerHealthRef.current.get(conn.peer);
        const intervalMs = state?.intervalMs ?? BROADCAST_STEPS_MS[0];

        if (now - (state?.lastSentAt ?? 0) < intervalMs) return;

        sendToOne(conn, "playback.state", snapshot);

        peerHealthRef.current.set(conn.peer, {
          intervalMs,
          lastSentAt: now,
          stallStreak: state?.stallStreak ?? 0,
          healthyStreak: state?.healthyStreak ?? 0
        });
      });
    },
    [sendToOne]
  );

  const sendMediaMount = useCallback(
    (media: RemoteMediaMount) => { send("media.mount", media); },
    [send]
  );

  const sendConfigRequest = useCallback(
    () => { send("config.request", {}); },
    [send]
  );

  const sendConfigState = useCallback(
    (conn: DataConnection, config: PlaybackConfig) => { sendToOne(conn, "config.state", config); },
    [sendToOne]
  );

  const broadcastConfigChanged = useCallback(
    () => { send("config.changed", {}); },
    [send]
  );

  const latencyMsRef = useRef(latencyMs);
  useEffect(() => { latencyMsRef.current = latencyMs; }, [latencyMs]);

  const handleMessage = useCallback(
    (conn: DataConnection, eventData: unknown) => {
      const message = eventData as WireMessage;

      if (message.type === "room.hello") {
        setRemotePeer((prev) =>
          prev === "Awaiting peer" ? message.payload.label : prev.includes(message.payload.label) ? prev : `${prev}, ${message.payload.label}`
        );
        onEventRef.current("ok", "PEER LINK", `${message.payload.label} (${conn.peer}) handshake complete.`);
        return;
      }

      if (message.type === "playback.state") {
        onPlaybackStateRef.current(message.payload, latencyMsRef.current);
        return;
      }

      if (message.type === "media.mount") {
        onMediaMountRef.current?.(message.payload);
        onEventRef.current("ok", "MEDIA", `Host mounted URL media: ${message.payload.title}.`);
        return;
      }

      if (message.type === "clock.ping") {
        conn.send({
          id: crypto.randomUUID(),
          type: "clock.pong",
          sentAt: performance.now(),
          payload: { pingId: message.payload.pingId, originAt: message.payload.originAt }
        });
        return;
      }

      if (message.type === "clock.pong" && pingRef.current?.id === message.payload.pingId) {
        const roundTrip = performance.now() - pingRef.current.at;
        const rtt = Math.round(roundTrip / 2);
        rttSamplesRef.current = [...rttSamplesRef.current.slice(-7), rtt];
        const smoothed = Math.round(smoothLatencySync(rttSamplesRef.current));
        setLatencyMs(smoothed);
        pingRef.current = null;
        return;
      }

      if (message.type === "file.meta") {
        const meta = message.payload;
        onEventRef.current(
          "info",
          "FILE",
          `Incoming file stream: ${meta.fileName} (${(meta.fileSize / 1024 / 1024).toFixed(1)} MB, ${meta.totalChunks} chunks, ${meta.isBlob ? "blob" : "MSE"} mode)`
        );
        const handlers = onFileStreamRef.current?.(meta);
        if (handlers) {
          fileStreamHandlersRef.current.set(meta.mediaId, handlers);
        }
        setFileReceiveProgress({ mediaId: meta.mediaId, fileName: meta.fileName, chunksReceived: 0, total: meta.totalChunks, totalBytes: meta.fileSize });
        return;
      }

      if (message.type === "file.chunk") {
        const { mediaId, index, total, data, checksum } = message.payload;
        const handlers = fileStreamHandlersRef.current.get(mediaId);
        if (handlers) {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
          handlers.onChunk(index, total, bytes, checksum);
          
          setFileReceiveProgress((prev) => {
            if (prev?.mediaId !== mediaId) return prev;
            const newReceived = prev.chunksReceived + 1;
            // Echo progress back to host using the new cumulative value
            sendToOne(conn, "file.progress", { mediaId, chunksReceived: newReceived, total });
            return { ...prev, chunksReceived: newReceived };
          });
        }
        return;
      }

      if (message.type === "file.end") {
        const { mediaId, checksum } = message.payload;
        const handlers = fileStreamHandlersRef.current.get(mediaId);
        if (handlers) {
          handlers.onEnd(checksum);
          setTimeout(() => fileStreamHandlersRef.current.delete(mediaId), 10000);
          onEventRef.current("ok", "FILE", `File stream complete.`);
        }
        setFileReceiveProgress(null);
        return;
      }

      if (message.type === "file.progress") {
        const { chunksReceived, total } = message.payload;
        setFileSendProgress((prev) => prev ? { ...prev, chunksSent: chunksReceived, total } : prev);
        return;
      }

      if (message.type === "config.request") {
        onConfigRequestRef.current?.(conn);
        return;
      }

      if (message.type === "config.state") {
        onConfigStateRef.current?.(message.payload);
        return;
      }

      if (message.type === "config.changed") {
        onConfigChangedRef.current?.();
        return;
      }

      if (message.type === "sync.health") {
        // Host-side only: adapt this peer's broadcast cadence based on whether
        // it's reporting buffering. Escalate after repeated stalls, and step
        // back down once the peer has been healthy for a while so a peer whose
        // network recovers isn't stuck on a slow cadence forever.
        const peerKey = conn.peer;
        const state: PeerHealthState = peerHealthRef.current.get(peerKey) ?? {
          intervalMs: BROADCAST_STEPS_MS[0],
          lastSentAt: 0,
          stallStreak: 0,
          healthyStreak: 0
        };

        if (message.payload.stalled) {
          state.stallStreak += 1;
          state.healthyStreak = 0;

          if (state.stallStreak >= STALL_ESCALATE_THRESHOLD) {
            const idx = BROADCAST_STEPS_MS.indexOf(state.intervalMs);
            const nextMs = BROADCAST_STEPS_MS[Math.min(idx + 1, BROADCAST_STEPS_MS.length - 1)];
            if (nextMs !== state.intervalMs) {
              state.intervalMs = nextMs;
              onEventRef.current("warn", "SYNC", `${peerKey}: repeated buffering reported, backing off broadcast cadence to ${nextMs}ms.`);
            }
            state.stallStreak = 0;
          }
        } else {
          state.healthyStreak += 1;
          state.stallStreak = 0;

          if (state.healthyStreak >= HEALTHY_DEESCALATE_THRESHOLD) {
            const idx = BROADCAST_STEPS_MS.indexOf(state.intervalMs);
            const prevMs = BROADCAST_STEPS_MS[Math.max(idx - 1, 0)];
            if (prevMs !== state.intervalMs) {
              state.intervalMs = prevMs;
              onEventRef.current("info", "SYNC", `${peerKey}: connection stable, tightening broadcast cadence to ${prevMs}ms.`);
            }
            state.healthyStreak = 0;
          }
        }

        peerHealthRef.current.set(peerKey, state);
        return;
      }
    },
    [sendToOne]
  );

  /** Guest-side: report local buffering health to the host so it can adapt cadence. */
  const reportSyncHealth = useCallback(
    (stalled: boolean, bufferedAheadSecs: number) => {
      send("sync.health", { stalled, bufferedAheadSecs });
    },
    [send]
  );

  /**
   * Stream a File to a specific connection (or all connections).
   * Uses a Web Worker to read + hash chunks off the main thread.
   * Applies per-connection flow control via bufferedAmount watermarks.
   */
  const sendFile = useCallback(
    async (file: File, mediaId: string, targetPeerIds?: string[]) => {
      const conns = targetPeerIds 
        ? connectionsRef.current.filter(c => targetPeerIds.includes(c.peer)) 
        : connectionsRef.current;
      if (conns.length === 0) return;

      const mimeType = file.type || "video/mp4";
      const { inferMediaFormat } = await import("@/lib/media/mediaTypes");
      const format = inferMediaFormat(mimeType);

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const meta: FileMeta = {
        mediaId,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        format,
        isBlob: true,
        totalChunks
      };

      setFileSendProgress({ mediaId, fileName: file.name, chunksSent: 0, total: totalChunks, totalBytes: file.size });
      onEventRef.current(
        "info",
        "FILE",
        `Starting blob transfer of "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) to ${conns.length} peer connection(s)`
      );

      // Group connections by peer ID for multiplexing
      const peerConns = new Map<string, DataConnection[]>();
      conns.forEach((c) => {
        if (!peerConns.has(c.peer)) peerConns.set(c.peer, []);
        peerConns.get(c.peer)!.push(c);
      });

      // Broadcast file.meta to ONE connection per peer
      peerConns.forEach((connections) => {
        const firstOpen = connections.find(c => c.open);
        if (firstOpen) sendToOne(firstOpen, "file.meta", meta);
      });

      const chunkQueue: Array<{ index: number; total: number; data: Uint8Array; checksum: string }> = [];
      let drainActive = false;
      let endSent = false;
      
      let workersActive = 0;
      let workersDone = 0;
      let workerError: string | null = null;

      await new Promise<void>((resolve, reject) => {
        const rejectTransfer = (error: unknown) => reject(error);
        const peerConnIndex = new Map<string, number>();

        const drainQueue = async () => {
          if (drainActive) return;
          drainActive = true;

          try {
            while (chunkQueue.length > 0) {
              const chunk = chunkQueue.shift()!;
              
              // Send to each peer via round-robin over their available multiplexed connections
              for (const [peerId, connections] of peerConns.entries()) {
                const openConns = connections.filter(c => c.open);
                if (openConns.length === 0) continue;

                let cIdx = peerConnIndex.get(peerId) || 0;
                let conn = openConns[cIdx % openConns.length];
                peerConnIndex.set(peerId, cIdx + 1);

                const channel = getDataChannel(conn);
                if (channel && channel.bufferedAmount > FLOW_HIGH_WATERMARK) {
                  await waitForDrain(conn);
                }
                sendToOne(conn, "file.chunk", {
                  mediaId,
                  index: chunk.index,
                  total: chunk.total,
                  data: chunk.data,
                  checksum: chunk.checksum
                });
              }
              setFileSendProgress((prev) =>
                prev ? { ...prev, chunksSent: prev.chunksSent + 1 } : prev
              );
            }

            if (workersDone === workersActive && !endSent && chunkQueue.length === 0) {
              endSent = true;
              for (const [peerId, connections] of peerConns.entries()) {
                const firstOpen = connections.find(c => c.open);
                if (!firstOpen) continue;
                await waitForDrain(firstOpen);
                sendToOne(firstOpen, "file.end", { mediaId, checksum: "" });
                await waitForDrain(firstOpen);
              }
              onEventRef.current("ok", "FILE", `File "${file.name}" fully sent.`);
              resolve();
            }
          } catch (error) {
            rejectTransfer(error);
          } finally {
            drainActive = false;
            if (chunkQueue.length > 0 || (workersDone === workersActive && !endSent)) {
              void drainQueue();
            }
          }
        };

        const NUM_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 8);
        workersActive = NUM_WORKERS;
        const chunksPerWorker = Math.ceil(totalChunks / NUM_WORKERS);

        for (let w = 0; w < NUM_WORKERS; w++) {
          const startChunkIndex = w * chunksPerWorker;
          const endChunkIndex = Math.min(startChunkIndex + chunksPerWorker, totalChunks);

          if (startChunkIndex >= totalChunks) {
             workersActive--;
             continue;
          }

          const worker = new Worker(
            new URL("../../workers/fileWorker.ts", import.meta.url),
            { type: "module" }
          );

          worker.onmessage = (event: MessageEvent) => {
            const msg = event.data as { type: string; [k: string]: unknown };
            if (msg.type === "ready") return;
            if (msg.type === "error") {
              workerError = msg.error as string;
              reject(new Error(workerError));
              return;
            }
            if (msg.type === "chunk") {
              chunkQueue.push({
                index: msg.index as number,
                total: msg.total as number,
                data: msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data as ArrayLike<number>),
                checksum: msg.checksum as string
              });
              chunkQueue.sort((a, b) => a.index - b.index);
              void drainQueue();
            }
            if (msg.type === "worker_done") {
              workersDone++;
              worker.terminate();
              void drainQueue();
            }
          };

          worker.onerror = (err) => reject(new Error(err.message));

          worker.postMessage({ 
            type: "start", 
            file, 
            mediaId, 
            chunkSize: CHUNK_SIZE,
            startChunkIndex,
            endChunkIndex,
            totalChunks
          });
        }
      }).catch((err: unknown) => {
        onEventRef.current("error", "FILE", `File transfer failed: ${err instanceof Error ? err.message : "unknown error"}`);
      });

      if (!workerError && workersDone === workersActive) {
        setFileSendProgress(null);
      }
    },
    [sendToOne]
  );

  const createHostOffer = useCallback(async () => {
    closeRoom();
    setRole("host");
    setStatus("pairing");
    setLocalOffer(peerId);

    onEventRef.current("info", "PEERJS", `Initializing room owner node. Host Peer ID: ${peerId}`);

    const peer = createPeer(peerId);
    peerRef.current = peer;

    peer.on("open", (id) => {
      onEventRef.current("ok", "PEERJS", `Connected to signaling broker. Room ID: ${id}`);
    });

    peer.on("connection", (conn) => {
      onEventRef.current("info", "WEBRTC", `Incoming connection from peer: ${conn.peer}`);
      setupConnectionDiagnostics(conn, `Viewer ${conn.peer}`, onEventRef.current);

      conn.on("open", () => {
        connectionsRef.current.push(conn);
        setConnectedPeers((prev) => prev.includes(conn.peer) ? prev : [...prev, conn.peer]);
        setStatus("connected");
        onEventRef.current("ok", "WEBRTC", `Connection established with ${conn.peer}. ICE success.`);

        conn.send({
          id: crypto.randomUUID(),
          type: "room.hello",
          sentAt: performance.now(),
          payload: { peerId, label: `Host (${peerId.slice(3, 7)})` }
        });
      });

      conn.on("data", (data) => { handleMessage(conn, data); });

      conn.on("iceStateChanged", (state) => {
        const level = state === "failed" ? "error" : state === "disconnected" ? "warn" : "info";
        onEventRef.current(level, "ICE", `Viewer ${conn.peer} ICE state: ${state}.`);
      });

      conn.on("close", () => {
        connectionsRef.current = connectionsRef.current.filter((c) => c !== conn);
        setConnectedPeers((prev) => prev.filter((id) => id !== conn.peer));
        onEventRef.current("warn", "WEBRTC", `Viewer ${conn.peer} disconnected.`);
        if (!connectionsRef.current.some((c) => c.peer === conn.peer)) {
          // Last channel for this peer closed — drop its adaptive cadence state
          // so a future rejoin starts fresh at the fastest interval.
          peerHealthRef.current.delete(conn.peer);
        }
        if (connectionsRef.current.length === 0) {
          setStatus("disconnected");
          setRemotePeer("Awaiting peer");
        }
      });

      conn.on("error", (err) => {
        onEventRef.current("error", "WEBRTC", `WebRTC error with ${conn.peer}: ${describeConnectionError(err)}`);
      });
    });

    peer.on("error", (err) => {
      onEventRef.current("error", "PEERJS", `Host broker error: ${describeConnectionError(err)}`);
      setStatus("failed");
    });

    try {
      await waitForPeerOpen(peer);
    } catch (err) {
      setStatus("failed");
      onEventRef.current("error", "PEERJS", `Could not start host room: ${err instanceof Error ? describeConnectionError(err) : "unknown error"}`);
      return "";
    }

    return peerId;
  }, [closeRoom, handleMessage, peerId]);

  const joinWithOffer = useCallback(
    async (rawId: string) => {
      // Normalise: bare 4-digit code → full Peer ID (SP-XXXX)
      const hostId = /^\d{4}$/.test(rawId.trim()) ? `SP-${rawId.trim()}` : rawId.trim();
      const attemptId = joinAttemptRef.current + 1;
      closeRoom();
      joinAttemptRef.current = attemptId;
      setRole("guest");
      setStatus("pairing");
      setLocalOffer(hostId);

      const ignoredCloseConnections = new WeakSet<DataConnection>();

      const startGuestPeer = (relayOnly: boolean) => {
        if (joinAttemptRef.current !== attemptId) return;

        if (peerRef.current) {
          peerRef.current.destroy();
          peerRef.current = null;
        }
        connectionsRef.current = [];
        setConnectedPeers([]);

        const guestId = `SP-GUEST-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
        onEventRef.current(
          "info",
          "PEERJS",
          `Initializing guest node. Guest ID: ${guestId}${relayOnly ? " (TURN relay-only retry)" : ""}`
        );
        onEventRef.current("info", "WEBRTC", `Connecting to room: ${hostId}`);

        const peer = createPeer(guestId, relayOnly);
        peerRef.current = peer;

        peer.on("open", (id) => {
          if (joinAttemptRef.current !== attemptId) return;

          onEventRef.current("ok", "PEERJS", `Connected to signaling broker. Guest ID: ${id}`);
          onEventRef.current(
            "info",
            "WEBRTC",
            `Negotiating handshake with host: ${hostId}${relayOnly ? " via TURN relay-only ICE" : ""}`
          );
          const NUM_CHANNELS = 4;
          for (let i = 0; i < NUM_CHANNELS; i++) {
            const conn = peer.connect(hostId, { reliable: true });
            setupConnectionDiagnostics(conn, `Host ${hostId} [${i}]`, onEventRef.current);

            conn.on("open", () => {
              if (joinAttemptRef.current !== attemptId) return;

              connectionsRef.current.push(conn);
              if (i === 0) {
                setConnectedPeers([hostId]);
                setStatus("connected");
                onEventRef.current("ok", "WEBRTC", `Joined room. Multiplexed data channels open with host.`);
              }

              conn.send({
                id: crypto.randomUUID(),
                type: "room.hello",
                sentAt: performance.now(),
                payload: { peerId: guestId, label: `Viewer (${guestId.slice(9)})` }
              });
            });

            conn.on("data", (data) => { handleMessage(conn, data); });

            conn.on("iceStateChanged", (state) => {
              const level = state === "failed" ? "error" : state === "disconnected" ? "warn" : "info";
              onEventRef.current(level, "ICE", `Host ${hostId} [CH${i}] ICE state: ${state}.`);
            });

            conn.on("close", () => {
              if (joinAttemptRef.current !== attemptId || ignoredCloseConnections.has(conn)) return;

              connectionsRef.current = connectionsRef.current.filter((c) => c !== conn);
              if (connectionsRef.current.length === 0) {
                setConnectedPeers([]);
                setStatus("disconnected");
                setRemotePeer("Awaiting peer");
                onEventRef.current("warn", "WEBRTC", `Host (${hostId}) disconnected.`);
              }
            });

            conn.on("error", (err) => {
              onEventRef.current("error", "WEBRTC", `Data channel ${i} error: ${describeConnectionError(err)}`);

              if (err.type === "negotiation-failed" && !relayOnly && i === 0) {
                ignoredCloseConnections.add(conn);
                onEventRef.current("warn", "WEBRTC", "Direct ICE negotiation failed. Retrying once with TURN relay-only mode.");
                conn.close();
                window.setTimeout(() => {
                  startGuestPeer(true);
                }, 500);
                return;
              }
              
              if (connectionsRef.current.length === 0) {
                setStatus("failed");
              }
            });
          }
        });

        peer.on("error", (err) => {
          if (joinAttemptRef.current !== attemptId) return;

          onEventRef.current("error", "PEERJS", `Guest broker error: ${describeConnectionError(err)}`);
          setStatus("failed");
        });
      };

      startGuestPeer(false);

      return "";
    },
    [closeRoom, handleMessage]
  );

  const pingPeer = useCallback(() => {
    if (connectionsRef.current.length === 0) return;
    const pingId = crypto.randomUUID();
    const originAt = performance.now();
    pingRef.current = { id: pingId, at: originAt };
    send("clock.ping", { pingId, originAt });
  }, [send]);

  return {
    role,
    status,
    roomCode: peerId.replace(/^SP-/, ""),
    remotePeer,
    localOffer,
    latencyMs,
    connectedPeers,
    fileSendProgress,
    fileReceiveProgress,
    createHostOffer,
    joinWithOffer,
    closeRoom,
    pingPeer,
    sendPlaybackState,
    sendMediaMount,
    sendConfigRequest,
    sendConfigState,
    broadcastConfigChanged,
    reportSyncHealth,
    sendFile
  };
}
