import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Peer, DataConnection, type PeerJSOption } from "peerjs";
import type { PlaybackSnapshot, WireMessage, FileMeta, RemoteMediaMount } from "@/lib/webrtc/messages";
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
};

export type FileReceiveProgress = {
  mediaId: string;
  fileName: string;
  chunksReceived: number;
  total: number;
};

type PeerRoomOptions = {
  onPlaybackState: (snapshot: PlaybackSnapshot, latencyMs: number) => void;
  onEvent: (level: "info" | "ok" | "warn" | "error", label: string, detail: string) => void;
  onFileStream?: (meta: FileMeta) => FileStreamHandlers;
  onMediaMount?: (media: RemoteMediaMount) => void;
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
    iceTransportPolicy: relayOnly ? "relay" : customConfig?.iceTransportPolicy ?? rtcConfig.iceTransportPolicy,
    sdpSemantics: "unified-plan"
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
}

const rtcConfig: ExtendedRTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:eu-0.turn.peerjs.com:3478",
      username: "peerjs",
      credential: "peerjsp"
    }
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: "all"
};

// 64 KB chunks — optimal for WebRTC DataChannel throughput
const CHUNK_SIZE = 64 * 1024;
// Pause sending when the channel buffer exceeds 4 MB
const FLOW_HIGH_WATERMARK = 4 * 1024 * 1024;
// Resume when it drains below 256 KB
const FLOW_LOW_WATERMARK = 256 * 1024;

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

export function usePeerRoom({ onPlaybackState, onEvent, onFileStream, onMediaMount }: PeerRoomOptions) {
  const [role, setRole] = useState<RoomRole>("solo");
  const [status, setStatus] = useState<LinkStatus>("idle");
  const [localOffer, setLocalOffer] = useState("");
  const [localAnswer, setLocalAnswer] = useState("");
  const [remotePeer, setRemotePeer] = useState("Awaiting peer");
  const [latencyMs, setLatencyMs] = useState(0);
  const [messagesSent, setMessagesSent] = useState(0);
  const [messagesReceived, setMessagesReceived] = useState(0);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [fileSendProgress, setFileSendProgress] = useState<FileSendProgress | null>(null);
  const [fileReceiveProgress, setFileReceiveProgress] = useState<FileReceiveProgress | null>(null);

  const peerId = useMemo(() => `SP-${genRoomCode()}`, []);


  // Stable callback refs — prevent stale closures in DataChannel listeners
  const onPlaybackStateRef = useRef(onPlaybackState);
  const onEventRef = useRef(onEvent);
  const onFileStreamRef = useRef(onFileStream);
  const onMediaMountRef = useRef(onMediaMount);
  useEffect(() => { onPlaybackStateRef.current = onPlaybackState; }, [onPlaybackState]);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onFileStreamRef.current = onFileStream; }, [onFileStream]);
  useEffect(() => { onMediaMountRef.current = onMediaMount; }, [onMediaMount]);

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  const pingRef = useRef<{ id: string; at: number } | null>(null);
  const joinAttemptRef = useRef(0);
  // Rolling RTT window for EWMA smoothing (last 8 samples)
  const rttSamplesRef = useRef<number[]>([]);
  // Active FileStreamHandlers keyed by mediaId (guest side)
  const fileStreamHandlersRef = useRef<Map<string, FileStreamHandlers>>(new Map());

  const closeRoom = useCallback(() => {
    joinAttemptRef.current += 1;
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
    setLocalAnswer("");
    setFileSendProgress(null);
    setFileReceiveProgress(null);
    fileStreamHandlersRef.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      if (peerRef.current) {
        peerRef.current.destroy();
      }
    };
  }, []);

  const send = useCallback((type: WireMessage["type"], payload: WireMessage["payload"]) => {
    const conns = connectionsRef.current;
    if (conns.length === 0) return false;

    const message = {
      id: crypto.randomUUID(),
      type,
      sentAt: performance.now(),
      payload
    };

    conns.forEach((conn) => {
      if (conn.open) conn.send(message);
    });

    setMessagesSent((count) => count + conns.length);
    return true;
  }, []);

  const sendToOne = useCallback((conn: DataConnection, type: WireMessage["type"], payload: WireMessage["payload"]) => {
    if (!conn.open) return;
    conn.send({ id: crypto.randomUUID(), type, sentAt: performance.now(), payload });
    setMessagesSent((c) => c + 1);
  }, []);

  const sendPlaybackState = useCallback(
    (snapshot: PlaybackSnapshot) => { send("playback.state", snapshot); },
    [send]
  );

  const sendMediaMount = useCallback(
    (media: RemoteMediaMount) => { send("media.mount", media); },
    [send]
  );

  const latencyMsRef = useRef(latencyMs);
  useEffect(() => { latencyMsRef.current = latencyMs; }, [latencyMs]);

  const handleMessage = useCallback(
    (conn: DataConnection, eventData: unknown) => {
      setMessagesReceived((count) => count + 1);
      const message = eventData as WireMessage;

      if (message.type === "room.hello") {
        setRemotePeer((prev) =>
          prev === "Awaiting peer" ? message.payload.label : `${prev}, ${message.payload.label}`
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
        setFileReceiveProgress({ mediaId: meta.mediaId, fileName: meta.fileName, chunksReceived: 0, total: meta.totalChunks });
        return;
      }

      if (message.type === "file.chunk") {
        const { mediaId, index, total, data, checksum } = message.payload;
        const handlers = fileStreamHandlersRef.current.get(mediaId);
        if (handlers) {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
          handlers.onChunk(index, total, bytes, checksum);
          const received = index + 1;
          setFileReceiveProgress((prev) =>
            prev?.mediaId === mediaId ? { ...prev, chunksReceived: received } : prev
          );
          // Echo progress back to host
          sendToOne(conn, "file.progress", { mediaId, chunksReceived: received, total });
        }
        return;
      }

      if (message.type === "file.end") {
        const { mediaId, checksum } = message.payload;
        const handlers = fileStreamHandlersRef.current.get(mediaId);
        if (handlers) {
          handlers.onEnd(checksum);
          fileStreamHandlersRef.current.delete(mediaId);
          onEventRef.current("ok", "FILE", `File stream complete. Checksum: ${checksum}`);
        }
        setFileReceiveProgress(null);
        return;
      }

      if (message.type === "file.progress") {
        const { chunksReceived, total } = message.payload;
        setFileSendProgress((prev) => prev ? { ...prev, chunksSent: chunksReceived, total } : prev);
        return;
      }
    },
    [sendToOne]
  );

  /**
   * Stream a File to a specific connection (or all connections).
   * Uses a Web Worker to read + hash chunks off the main thread.
   * Applies per-connection flow control via bufferedAmount watermarks.
   */
  const sendFile = useCallback(
    async (file: File, mediaId: string, targetConn?: DataConnection) => {
      const conns = targetConn ? [targetConn] : connectionsRef.current;
      if (conns.length === 0) return;

      const mimeType = file.type || "video/mp4";
      // Arbitrary local files are not guaranteed to be valid MSE segments when sliced
      // by byte range, so transfer them as a complete Blob and mount after receipt.
      const isMseFriendly = false;

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const meta: FileMeta = {
        mediaId,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        isBlob: !isMseFriendly,
        totalChunks
      };

      setFileSendProgress({ mediaId, fileName: file.name, chunksSent: 0, total: totalChunks });
      onEventRef.current(
        "info",
        "FILE",
        `Starting ${isMseFriendly ? "MSE stream" : "blob transfer"} of "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) to ${conns.length} peer(s)`
      );

      // Broadcast file.meta to all target connections
      conns.forEach((conn) => {
        if (conn.open) sendToOne(conn, "file.meta", meta);
      });

      // Spin up the Web Worker for off-thread chunking
      const worker = new Worker(
        new URL("../../workers/fileWorker.ts", import.meta.url),
        { type: "module" }
      );

      const chunkQueue: Array<{ index: number; total: number; data: Uint8Array; checksum: string }> = [];
      let workerDone = false;
      let workerError: string | null = null;
      let finalChecksum: string | null = null;
      let drainActive = false;
      let endSent = false;

      await new Promise<void>((resolve, reject) => {
        const rejectTransfer = (error: unknown) => {
          reject(error);
        };

        const drainQueue = async () => {
          if (drainActive) return;
          drainActive = true;

          try {
            while (chunkQueue.length > 0) {
              const chunk = chunkQueue.shift()!;
              for (const conn of conns) {
                if (!conn.open) continue;
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
                prev ? { ...prev, chunksSent: chunk.index + 1 } : prev
              );
            }

            if (workerDone && finalChecksum && !endSent) {
              endSent = true;
              for (const conn of conns) {
                if (!conn.open) continue;
                await waitForDrain(conn);
                sendToOne(conn, "file.end", { mediaId, checksum: finalChecksum });
                await waitForDrain(conn);
              }
              onEventRef.current("ok", "FILE", `File "${file.name}" fully sent. Checksum: ${finalChecksum}`);
              resolve();
            }
          } catch (error) {
            rejectTransfer(error);
          } finally {
            drainActive = false;
            if (chunkQueue.length > 0 || (workerDone && finalChecksum && !endSent)) {
              void drainQueue();
            }
          }
        };

        worker.onmessage = (event: MessageEvent) => {
          const msg = event.data as { type: string; [k: string]: unknown };

          if (msg.type === "ready") return;

          if (msg.type === "error") {
            workerError = msg.message as string;
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
            void drainQueue();
          }

          if (msg.type === "progress") {
            const pct = Math.round(((msg.index as number) / (msg.total as number)) * 100);
            if (pct % 10 === 0) {
              onEventRef.current("info", "FILE", `Sending "${file.name}": ${pct}% (${msg.index as number}/${msg.total as number} chunks)`);
            }
          }

          if (msg.type === "end") {
            finalChecksum = msg.checksum as string;
            workerDone = true;
            worker.terminate();
            void drainQueue();
          }
        };

        worker.onerror = (err) => {
          reject(new Error(err.message));
        };

        worker.postMessage({ type: "start", file, mediaId, chunkSize: CHUNK_SIZE });
      }).catch((err: unknown) => {
        onEventRef.current("error", "FILE", `File transfer failed: ${err instanceof Error ? err.message : "unknown error"}`);
        worker.terminate();
      });

      if (!workerError && workerDone) {
        setFileSendProgress(null);
      }
    },
    [sendToOne]
  );

  const createHostOffer = useCallback(async () => {
    closeRoom();
    setRole("host");
    setStatus("pairing");
    setLocalAnswer("");
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
        setConnectedPeers((prev) => [...prev, conn.peer]);
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

  const acceptGuestAnswer = useCallback(async (_answerSignal: string) => {
    onEventRef.current("info", "ROOM", "Manual signaling is deprecated. Connections now occur automatically.");
  }, []);

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
      setLocalAnswer("");

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
          const conn = peer.connect(hostId, { reliable: true });
          setupConnectionDiagnostics(conn, `Host ${hostId}`, onEventRef.current);

          conn.on("open", () => {
            if (joinAttemptRef.current !== attemptId) return;

            connectionsRef.current.push(conn);
            setConnectedPeers([hostId]);
            setStatus("connected");
            onEventRef.current("ok", "WEBRTC", `Joined room. Data channel open with host.`);

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
            onEventRef.current(level, "ICE", `Host ${hostId} ICE state: ${state}.`);
          });

          conn.on("close", () => {
            if (joinAttemptRef.current !== attemptId || ignoredCloseConnections.has(conn)) return;

            connectionsRef.current = [];
            setConnectedPeers([]);
            setStatus("disconnected");
            setRemotePeer("Awaiting peer");
            onEventRef.current("warn", "WEBRTC", `Host (${hostId}) disconnected.`);
          });

          conn.on("error", (err) => {
            onEventRef.current("error", "WEBRTC", `Data channel error: ${describeConnectionError(err)}`);

            if (err.type === "negotiation-failed" && !relayOnly) {
              ignoredCloseConnections.add(conn);
              onEventRef.current("warn", "WEBRTC", "Direct ICE negotiation failed. Retrying once with TURN relay-only mode.");
              conn.close();
              window.setTimeout(() => {
                startGuestPeer(true);
              }, 500);
              return;
            }

            setStatus("failed");
          });
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
    peerId,
    roomCode: peerId.replace(/^SP-/, ""),
    remotePeer,
    localOffer,
    localAnswer,
    latencyMs,
    messagesSent,
    messagesReceived,
    connectedPeers,
    fileSendProgress,
    fileReceiveProgress,
    createHostOffer,
    acceptGuestAnswer,
    joinWithOffer,
    closeRoom,
    pingPeer,
    sendPlaybackState,
    sendMediaMount,
    sendFile
  };
}
