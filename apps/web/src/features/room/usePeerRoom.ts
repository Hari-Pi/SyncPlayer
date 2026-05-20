import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Peer, DataConnection, type PeerJSOption } from "peerjs";
import type { PlaybackSnapshot, WireMessage, FileMeta } from "@/lib/webrtc/messages";
import { smoothLatencySync } from "@/lib/wasm/syncCore";

type RoomRole = "solo" | "host" | "guest";
type LinkStatus = "idle" | "pairing" | "connected" | "disconnected" | "failed";

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
};

// ─── Default PeerJS server (overridable via localStorage) ────────────────────
function getPeerServerConfig() {
  try {
    const stored = localStorage.getItem("syncplayer:peerserver");
    if (stored) return JSON.parse(stored) as PeerJSOption;
  } catch { /* ignore */ }
  return null; // null → PeerJS uses 0.peerjs.com by default
}

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun.services.mozilla.com" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp"
      ],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

// 64 KB chunks — optimal for WebRTC DataChannel throughput
const CHUNK_SIZE = 64 * 1024;
// Pause sending when the channel buffer exceeds 4 MB
const FLOW_HIGH_WATERMARK = 4 * 1024 * 1024;
// Resume when it drains below 256 KB
const FLOW_LOW_WATERMARK = 256 * 1024;

/** Wait until conn's bufferedAmount drops below the low watermark. */
function waitForDrain(conn: DataConnection): Promise<void> {
  return new Promise((resolve) => {
    const channel = (conn as unknown as { _dc?: RTCDataChannel })._dc;
    if (!channel || channel.bufferedAmount < FLOW_LOW_WATERMARK) {
      resolve();
      return;
    }
    const interval = setInterval(() => {
      if (!channel || channel.bufferedAmount < FLOW_LOW_WATERMARK) {
        clearInterval(interval);
        resolve();
      }
    }, 50);
  });
}

export function usePeerRoom({ onPlaybackState, onEvent, onFileStream }: PeerRoomOptions) {
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

  const peerId = useMemo(() => `SP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, []);

  // Stable callback refs — prevent stale closures in DataChannel listeners
  const onPlaybackStateRef = useRef(onPlaybackState);
  const onEventRef = useRef(onEvent);
  const onFileStreamRef = useRef(onFileStream);
  useEffect(() => { onPlaybackStateRef.current = onPlaybackState; }, [onPlaybackState]);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);
  useEffect(() => { onFileStreamRef.current = onFileStream; }, [onFileStream]);

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  const pingRef = useRef<{ id: string; at: number } | null>(null);
  // Rolling RTT window for EWMA smoothing (last 8 samples)
  const rttSamplesRef = useRef<number[]>([]);
  // Active FileStreamHandlers keyed by mediaId (guest side)
  const fileStreamHandlersRef = useRef<Map<string, FileStreamHandlers>>(new Map());

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
          const bytes = new Uint8Array(data);
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
      const isMseFriendly =
        typeof MediaSource !== "undefined" &&
        MediaSource.isTypeSupported(mimeType) &&
        !file.name.toLowerCase().endsWith(".mkv") &&
        !file.name.toLowerCase().endsWith(".avi") &&
        !file.name.toLowerCase().endsWith(".wmv");

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

      const chunkQueue: Array<{ index: number; total: number; data: number[]; checksum: string }> = [];
      let workerDone = false;
      let workerError: string | null = null;

      await new Promise<void>((resolve, reject) => {
        worker.onmessage = async (event: MessageEvent) => {
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
              data: msg.data as number[],
              checksum: msg.checksum as string
            });

            // Drain the queue — send chunk to each connection with flow control
            while (chunkQueue.length > 0) {
              const chunk = chunkQueue.shift()!;
              for (const conn of conns) {
                if (!conn.open) continue;
                // Flow control: wait if the channel is overwhelmed
                const channel = (conn as unknown as { _dc?: RTCDataChannel })._dc;
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
          }

          if (msg.type === "progress") {
            const pct = Math.round(((msg.index as number) / (msg.total as number)) * 100);
            if (pct % 10 === 0) {
              onEventRef.current("info", "FILE", `Sending "${file.name}": ${pct}% (${msg.index as number}/${msg.total as number} chunks)`);
            }
          }

          if (msg.type === "end") {
            const checksum = msg.checksum as string;
            conns.forEach((conn) => {
              if (conn.open) sendToOne(conn, "file.end", { mediaId, checksum });
            });
            onEventRef.current("ok", "FILE", `File "${file.name}" fully sent. Checksum: ${checksum}`);
            workerDone = true;
            worker.terminate();
            resolve();
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

    const serverConfig = getPeerServerConfig();
    const peer = serverConfig
      ? new Peer(peerId, { ...serverConfig, config: rtcConfig })
      : new Peer(peerId, { config: rtcConfig });

    peerRef.current = peer;

    peer.on("open", (id) => {
      onEventRef.current("ok", "PEERJS", `Connected to signaling broker. Room ID: ${id}`);
    });

    peer.on("connection", (conn) => {
      onEventRef.current("info", "WEBRTC", `Incoming connection from peer: ${conn.peer}`);

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
        onEventRef.current("error", "WEBRTC", `WebRTC error with ${conn.peer}: ${err.message}`);
      });
    });

    peer.on("error", (err) => {
      onEventRef.current("error", "PEERJS", `Host broker error: ${err.message}`);
      setStatus("failed");
    });

    return peerId;
  }, [closeRoom, handleMessage, peerId]);

  const acceptGuestAnswer = useCallback(async (_answerSignal: string) => {
    onEventRef.current("info", "ROOM", "Manual signaling is deprecated. Connections now occur automatically.");
  }, []);

  const joinWithOffer = useCallback(
    async (hostId: string) => {
      closeRoom();
      setRole("guest");
      setStatus("pairing");
      setLocalOffer(hostId);
      setLocalAnswer("");

      const guestId = `SP-GUEST-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
      onEventRef.current("info", "PEERJS", `Initializing guest node. Guest ID: ${guestId}`);
      onEventRef.current("info", "WEBRTC", `Connecting to room: ${hostId}`);

      const serverConfig = getPeerServerConfig();
      const peer = serverConfig
        ? new Peer(guestId, { ...serverConfig, config: rtcConfig })
        : new Peer(guestId, { config: rtcConfig });

      peerRef.current = peer;

      peer.on("open", (id) => {
        onEventRef.current("ok", "PEERJS", `Connected to signaling broker. Guest ID: ${id}`);
        onEventRef.current("info", "WEBRTC", `Negotiating handshake with host: ${hostId}`);
        const conn = peer.connect(hostId);

        conn.on("open", () => {
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

        conn.on("close", () => {
          connectionsRef.current = [];
          setConnectedPeers([]);
          setStatus("disconnected");
          setRemotePeer("Awaiting peer");
          onEventRef.current("warn", "WEBRTC", `Host (${hostId}) disconnected.`);
        });

        conn.on("error", (err) => {
          onEventRef.current("error", "WEBRTC", `Data channel error: ${err.message}`);
          setStatus("failed");
        });
      });

      peer.on("error", (err) => {
        onEventRef.current("error", "PEERJS", `Guest broker error: ${err.message}`);
        setStatus("failed");
      });

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
    sendFile
  };
}
