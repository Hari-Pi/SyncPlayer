import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Peer, DataConnection, type PeerJSOption } from "peerjs";
import type { PlaybackSnapshot, WireMessage, FileMeta, RemoteMediaMount, PlaybackConfig, GuestPlaybackAction } from "@/lib/webrtc/messages";
import { CHUNK_SIZE } from "@/lib/webrtc/messages";
import { smoothLatencySync } from "@/lib/wasm/syncCore";
import { combineChecksums, rangesInclude } from "@/lib/media/checksum";
import { getQueuedChunkCount } from "@/lib/webrtc/peerjsCompat";

type RoomRole = "solo" | "host" | "guest";
// "awaiting-approval": the WebRTC channel is open but the host hasn't decided
// yet (only reachable when the host has "allow all connections" off).
// "declined": the host explicitly rejected the join request — terminal,
// does not trigger the guest's auto-reconnect logic.
type LinkStatus = "idle" | "pairing" | "awaiting-approval" | "connected" | "disconnected" | "failed" | "declined";
type ExtendedRTCConfiguration = RTCConfiguration & { sdpSemantics?: "unified-plan" };
type StoredPeerOptions = PeerJSOption & { config?: ExtendedRTCConfiguration };

export type FileStreamHandlers = {
  onChunk: (index: number, total: number, data: Uint8Array, checksum: string) => void;
  onEnd: (checksum: string) => void;
  onProgress?: (chunksReceived: number, total: number) => void;
  /** If this file.meta is a resume of a partially-received transfer, how many chunks we already have. */
  alreadyReceivedCount?: number;
  /** The host aborted this transfer (e.g. an internal error) — stop waiting and clean up. */
  onAbort?: (reason?: string) => void;
};

export type FileSendProgress = {
  mediaId: string;
  fileName: string;
  chunksSent: number;
  total: number;
  totalBytes: number;
  /**
   * True when other, already-synced viewers exist besides whoever this
   * specific transfer targets — i.e. this is topping up a late joiner while
   * everyone else already has the file, so it shouldn't block or pause
   * anything for the host. False for the initial transfer, even if it
   * happens to target only one (the first-ever) viewer.
   */
  background: boolean;
};

/** Per-viewer receive progress, keyed by peer ID, for the host-side "who has how much" view. */
export type PeerFileProgress = {
  chunksReceived: number;
  total: number;
};

export type FileReceiveProgress = {
  mediaId: string;
  fileName: string;
  chunksReceived: number;
  total: number;
  totalBytes: number;
};

/** Host-side: a connection awaiting an explicit accept/decline decision. */
export type PendingJoinRequest = {
  peerId: string;
  label: string;
  requestedAt: number;
};

type PeerRoomOptions = {
  onPlaybackState: (snapshot: PlaybackSnapshot, latencyMs: number) => void;
  onEvent: (level: "info" | "ok" | "warn" | "error", label: string, detail: string) => void;
  onFileStream?: (meta: FileMeta) => FileStreamHandlers;
  onMediaMount?: (media: RemoteMediaMount) => void;
  onConfigRequest?: (conn: DataConnection) => void;
  onConfigState?: (config: PlaybackConfig) => void;
  onConfigChanged?: () => void;
  /** Host-side: a viewer performed a rate-limited pause/resume/seek and it passed the host's own limit check. */
  onGuestAction?: (action: GuestPlaybackAction, snapshot: PlaybackSnapshot, peerId: string) => void;
  /**
   * Host-side: when true, incoming connections are accepted immediately
   * (today's behavior). When false (the default), a connecting peer sits in
   * a pending queue until the host explicitly accepts or declines it — so
   * guessing or brute-forcing the room code no longer gets anyone in on its
   * own.
   */
  allowAllConnections: boolean;
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

// PeerJS's own internal logger levels: 0=none, 1=errors, 2=+warnings, 3=+verbose trace.
// Level 2 surfaces its warn/error console output (useful when a user reports
// a WebRTC issue we can't otherwise see) without the noisy level-3 trace.
// This is separate from — and in addition to — our own onEvent activity log.
const PEERJS_LOG_LEVEL = 2;

function createPeer(peerId: string, relayOnly = false) {
  const serverConfig = getPeerServerConfig();
  return new Peer(peerId, {
    ...serverConfig,
    config: createRtcConfig(relayOnly),
    debug: PEERJS_LOG_LEVEL
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

// ─── Guest control rate limiting ──────────────────────────────────────────────
// Viewers can pause/seek and have it reverse-sync to the host; pause and seek
// share one budget so a viewer can't spam controls to annoy the room. Resume
// is exempt (see below) so pausing never leaves a guest stuck. Enforced
// host-side (authoritative) in addition to whatever client-side gate the
// sender applies, since the sender's own check can't be trusted on its own.
const GUEST_ACTION_LIMIT = 3;
const GUEST_ACTION_WINDOW_MS = 60_000;

// ─── File transfer tuning ──────────────────────────────────────────────────────
// How long a fresh file.meta send waits for a peer's "file.resume" reply
// before assuming it has nothing to resume and streaming from the start.
// Guests always reply promptly (even with empty ranges), so this is really
// just a worst-case fallback, not the expected wait in practice.
const RESUME_ACK_TIMEOUT_MS = 500;
// How often (ms) a receiving peer echoes cumulative chunk progress back to
// the sender. Echoing on every 64KB chunk floods the channel; this throttles
// it to a cadence that's still responsive enough for a progress bar.
const PROGRESS_ECHO_INTERVAL_MS = 250;

// ─── Connection approval ───────────────────────────────────────────────────────
// If the host never responds to a join request, auto-decline it after this
// long so it doesn't sit open and cluttering the UI indefinitely.
const PENDING_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

/** Wait until conn's bufferedAmount drops below the low watermark. */
function waitForDrain(conn: DataConnection): Promise<void> {
  return new Promise((resolve) => {
    const channel = conn.dataChannel ?? null;
    const peerBufferSize = getQueuedChunkCount(conn);
    if (!channel || (channel.bufferedAmount < FLOW_LOW_WATERMARK && peerBufferSize === 0)) {
      resolve();
      return;
    }

    channel.bufferedAmountLowThreshold = FLOW_LOW_WATERMARK;
    const interval = setInterval(() => {
      const buffered = channel.bufferedAmount;
      const queued = getQueuedChunkCount(conn);
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

export function usePeerRoom({ onPlaybackState, onEvent, onFileStream, onMediaMount, onConfigRequest, onConfigState, onConfigChanged, onGuestAction, allowAllConnections }: PeerRoomOptions) {
  const [role, setRole] = useState<RoomRole>("solo");
  const [status, setStatus] = useState<LinkStatus>("idle");
  const [localOffer, setLocalOffer] = useState("");
  const [remotePeer, setRemotePeer] = useState("Awaiting peer");
  const [latencyMs, setLatencyMs] = useState(0);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);
  const [fileSendProgress, setFileSendProgress] = useState<FileSendProgress | null>(null);
  const [fileReceiveProgress, setFileReceiveProgress] = useState<FileReceiveProgress | null>(null);
  // Host-side: each connected viewer's own reported receive progress, keyed by peer ID.
  const [peerFileProgress, setPeerFileProgress] = useState<Record<string, PeerFileProgress>>({});
  // Host-side: connections awaiting an explicit accept/decline decision.
  const [pendingRequests, setPendingRequests] = useState<PendingJoinRequest[]>([]);

  const peerId = useMemo(() => `SP-${genRoomCode()}`, []);


  // Stable callback refs — prevent stale closures in DataChannel listeners
  const onPlaybackStateRef = useRef(onPlaybackState);
  const onEventRef = useRef(onEvent);
  const onFileStreamRef = useRef(onFileStream);
  const onMediaMountRef = useRef(onMediaMount);
  const onConfigRequestRef = useRef(onConfigRequest);
  const onConfigStateRef = useRef(onConfigState);
  const onConfigChangedRef = useRef(onConfigChanged);
  const onGuestActionRef = useRef(onGuestAction);
  const allowAllConnectionsRef = useRef(allowAllConnections);
  // role changes rarely, but handleMessage's closure is long-lived (bound to
  // DataConnection listeners at connect-time), so it needs a ref rather than
  // reading `role` directly to avoid a stale value.
  const roleRef = useRef(role);
  useEffect(() => {
    onPlaybackStateRef.current = onPlaybackState;
    onEventRef.current = onEvent;
    onFileStreamRef.current = onFileStream;
    onMediaMountRef.current = onMediaMount;
    onConfigRequestRef.current = onConfigRequest;
    onConfigStateRef.current = onConfigState;
    onConfigChangedRef.current = onConfigChanged;
    onGuestActionRef.current = onGuestAction;
    allowAllConnectionsRef.current = allowAllConnections;
  }, [onPlaybackState, onEvent, onFileStream, onMediaMount, onConfigRequest, onConfigState, onConfigChanged, onGuestAction, allowAllConnections]);
  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  const pingRef = useRef<{ id: string; at: number } | null>(null);
  const joinAttemptRef = useRef(0);
  // Rolling RTT window for EWMA smoothing (last 8 samples)
  const rttSamplesRef = useRef<number[]>([]);
  // Active FileStreamHandlers keyed by mediaId (guest side)
  const fileStreamHandlersRef = useRef<Map<string, FileStreamHandlers>>(new Map());
  // Guest-side: last time we echoed receive progress back to the sender, keyed by mediaId.
  const lastProgressEchoAtRef = useRef<Map<string, number>>(new Map());
  // Host-side: per-guest-peer adaptive broadcast cadence state, keyed by conn.peer.
  const peerHealthRef = useRef<Map<string, PeerHealthState>>(new Map());
  // Host-side: per-guest-peer rolling timestamps of accepted control actions, keyed by conn.peer.
  const guestActionHistoryRef = useRef<Map<string, number[]>>(new Map());
  // Host-side: latest "file.resume" info received per peer, keyed by conn.peer.
  // Populated whenever a resume reply arrives, consumed by sendFile's wait step.
  const resumeInfoRef = useRef<Map<string, { mediaId: string; ranges: Array<[number, number]> }>>(new Map());
  // Host-side: one-shot resolvers waiting on a specific peer's next "file.resume" reply.
  const resumeWaitersRef = useRef<Map<string, (ranges: Array<[number, number]> | null) => void>>(new Map());
  // Guards against two sendFile() calls fighting over the SAME peer's
  // connections (e.g. host swaps files while a previous transfer to that
  // peer is still draining). Scoped per-peer rather than one global counter —
  // a background transfer to a late-joining peer must NOT cancel an
  // unrelated, still-in-progress transfer to completely different peers.
  const peerTransferStateRef = useRef<Map<string, { generation: number; mediaId: string }>>(new Map());
  const sendGenerationCounterRef = useRef(0);

  // Host-side connection-approval bookkeeping (see peer.on("connection") below).
  // Channels awaiting a decision, grouped by peer ID — a guest opens several
  // multiplexed channels, all belonging to the same approve/decline decision.
  const pendingConnectionsRef = useRef<Map<string, DataConnection[]>>(new Map());
  // Once a peer's been decided, remember it so any of their channels that are
  // still mid-handshake when the decision is made get the same treatment.
  const peerDecisionRef = useRef<Map<string, "accepted" | "declined">>(new Map());
  // Auto-decline a pending request if the host never responds. Typed as
  // `number` (not ReturnType<typeof setTimeout>) since @types/node's Timeout
  // type would otherwise shadow the DOM's window.setTimeout return type here.
  const pendingTimeoutsRef = useRef<Map<string, number>>(new Map());

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
    setPeerFileProgress({});
    fileStreamHandlersRef.current.clear();
    peerHealthRef.current.clear();
    guestActionHistoryRef.current.clear();
    resumeInfoRef.current.clear();
    resumeWaitersRef.current.clear();
    peerTransferStateRef.current.clear();
    pendingConnectionsRef.current.clear();
    peerDecisionRef.current.clear();
    pendingTimeoutsRef.current.forEach((timeout) => window.clearTimeout(timeout));
    pendingTimeoutsRef.current.clear();
    setPendingRequests([]);
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

        // Guest-side: this is the host's explicit sign of acceptance (it's
        // only ever sent once a connection is actually approved — see
        // peer.on("connection") below). The host doesn't need this signal;
        // it already knows it accepted the connection itself, and blindly
        // overwriting connectedPeers here would wipe out its other viewers.
        if (roleRef.current === "guest") {
          setStatus("connected");
          setConnectedPeers([conn.peer]);
        }
        return;
      }

      if (message.type === "room.joinDeclined") {
        setStatus("declined");
        onEventRef.current("error", "ROOM", "The host declined your join request.");
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
        setFileReceiveProgress({
          mediaId: meta.mediaId,
          fileName: meta.fileName,
          chunksReceived: handlers?.alreadyReceivedCount ?? 0,
          total: meta.totalChunks,
          totalBytes: meta.fileSize
        });
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

            // Echo progress back to the sender, but throttled — echoing on
            // every 64KB chunk would roughly double message traffic on the
            // channel. Always echo the last chunk so the sender's progress
            // bar actually reaches 100% instead of stalling on a throttled value.
            const now = performance.now();
            const lastEchoAt = lastProgressEchoAtRef.current.get(mediaId) ?? 0;
            if (newReceived >= total || now - lastEchoAt >= PROGRESS_ECHO_INTERVAL_MS) {
              lastProgressEchoAtRef.current.set(mediaId, now);
              sendToOne(conn, "file.progress", { mediaId, chunksReceived: newReceived, total });
            }

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
        // Track this specific peer's own progress rather than clobbering a
        // single shared counter — with multiple viewers, whichever peer's
        // echo arrived most recently would otherwise overwrite the others'.
        const peerKey = conn.peer;

        // Guard against a stale echo from a transfer that's since been
        // superseded or has already finished for this peer — otherwise a
        // late-arriving message from an old/canceled transfer could stomp
        // this peer's progress with numbers for the wrong file.
        const active = peerTransferStateRef.current.get(peerKey);
        if (!active || active.mediaId !== message.payload.mediaId) {
          return;
        }

        const { chunksReceived, total } = message.payload;
        setPeerFileProgress((prev) => ({ ...prev, [peerKey]: { chunksReceived, total } }));
        return;
      }

      if (message.type === "file.aborted") {
        // Guest-side: the host's send pipeline died mid-transfer. Let the
        // in-progress receive handlers clean up instead of sitting at
        // "Receiving..." forever with no explanation.
        const handlers = fileStreamHandlersRef.current.get(message.payload.mediaId);
        handlers?.onAbort?.(message.payload.reason);
        fileStreamHandlersRef.current.delete(message.payload.mediaId);
        setFileReceiveProgress((prev) => (prev?.mediaId === message.payload.mediaId ? null : prev));
        onEventRef.current(
          "error",
          "FILE",
          `Host aborted the file transfer${message.payload.reason ? `: ${message.payload.reason}` : "."}`
        );
        return;
      }

      if (message.type === "file.resume") {
        // Host-side: a peer is reporting which chunks it already has for a
        // mediaId (empty ranges for a fresh transfer). Feed sendFile's wait
        // step if it's actively waiting on this peer, and cache it either way
        // in case sendFile hasn't started waiting yet.
        const peerKey = conn.peer;
        resumeInfoRef.current.set(peerKey, { mediaId: message.payload.mediaId, ranges: message.payload.receivedRanges });

        const waiter = resumeWaitersRef.current.get(peerKey);
        if (waiter) {
          resumeWaitersRef.current.delete(peerKey);
          waiter(message.payload.receivedRanges);
        }
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

      if (message.type === "playback.guestAction") {
        // Host-side authoritative rate limit: pause/seek share one budget of
        // GUEST_ACTION_LIMIT per GUEST_ACTION_WINDOW_MS per peer, enforced
        // here regardless of the sender's own client-side gate (which can be
        // bypassed). Resume is exempt — never counted, never blocked — so a
        // guest who paused can always un-pause.
        const peerKey = conn.peer;

        if (message.payload.action === "resume") {
          onGuestActionRef.current?.(message.payload.action, message.payload.snapshot, peerKey);
          return;
        }

        const now = performance.now();
        const recent = (guestActionHistoryRef.current.get(peerKey) ?? []).filter(
          (t) => now - t < GUEST_ACTION_WINDOW_MS
        );

        if (recent.length >= GUEST_ACTION_LIMIT) {
          guestActionHistoryRef.current.set(peerKey, recent);
          onEventRef.current(
            "warn",
            "SYNC",
            `${peerKey}: control rate limit reached (${GUEST_ACTION_LIMIT}/min), ignored ${message.payload.action}.`
          );
          return;
        }

        recent.push(now);
        guestActionHistoryRef.current.set(peerKey, recent);
        onGuestActionRef.current?.(message.payload.action, message.payload.snapshot, peerKey);
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

  /** Guest-side: forward a pause/resume/seek to the host so it reverse-syncs to the room. */
  const sendGuestAction = useCallback(
    (action: GuestPlaybackAction, snapshot: PlaybackSnapshot) => {
      send("playback.guestAction", { action, snapshot });
    },
    [send]
  );

  /** Guest-side: report which chunks of mediaId we already have (empty for a fresh transfer). */
  const sendFileResume = useCallback(
    (mediaId: string, receivedRanges: Array<[number, number]>) => {
      send("file.resume", { mediaId, receivedRanges });
    },
    [send]
  );

  /**
   * Stream a File to a specific connection (or all connections).
   * Uses a Web Worker to read + hash chunks off the main thread.
   * Applies per-connection flow control via bufferedAmount watermarks.
   *
   * `background` controls whether this counts as a "quiet" transfer for
   * FileSendProgress.background (see that type) — the caller decides this,
   * since only it knows whether other already-synced viewers exist. It does
   * NOT default from whether targetPeerIds was passed: a late joiner who
   * happens to be the very first viewer ever is still an "initial" transfer,
   * not a background one, even though it's targeted at just that one peer.
   */
  const sendFile = useCallback(
    async (file: File, mediaId: string, options?: { targetPeerIds?: string[]; background?: boolean }) => {
      const { targetPeerIds, background = false } = options ?? {};
      const conns = targetPeerIds
        ? connectionsRef.current.filter(c => targetPeerIds.includes(c.peer))
        : connectionsRef.current;
      if (conns.length === 0) return;

      // Cancel a previous transfer only if it's actually fighting over the
      // SAME peer's connections — scoped per-peer rather than one global
      // counter. Otherwise a background transfer to a late-joining peer
      // would wrongly cancel an unrelated, still-in-progress transfer to
      // completely different peers.
      const generation = ++sendGenerationCounterRef.current;
      const targetPeerIdSet = Array.from(new Set(conns.map((c) => c.peer)));
      targetPeerIdSet.forEach((peerId) => peerTransferStateRef.current.set(peerId, { generation, mediaId }));
      const isCurrent = () =>
        targetPeerIdSet.every((peerId) => peerTransferStateRef.current.get(peerId)?.generation === generation);

      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      // Set this before any `await` — the caller (e.g. handleLocalFile) sets
      // its own media/UI state and then fires this off in the same tick, so
      // if this update lands even one microtask later (as it would after an
      // `await import(...)`), the player can render for a frame before the
      // upload lock catches up. Doing it first keeps both state updates in
      // the same React batch.
      setFileSendProgress({
        mediaId,
        fileName: file.name,
        chunksSent: 0,
        total: totalChunks,
        totalBytes: file.size,
        background
      });
      setPeerFileProgress((prev) => {
        const next = { ...prev };
        for (const conn of conns) {
          next[conn.peer] = { chunksReceived: 0, total: totalChunks };
        }
        return next;
      });

      const mimeType = file.type || "video/mp4";
      const { inferMediaFormat } = await import("@/lib/media/mediaTypes");
      const format = inferMediaFormat(mimeType);

      const meta: FileMeta = {
        mediaId,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        format,
        isBlob: true,
        totalChunks
      };

      // Group connections by peer ID for multiplexing
      const peerConns = new Map<string, DataConnection[]>();
      conns.forEach((c) => {
        if (!peerConns.has(c.peer)) peerConns.set(c.peer, []);
        peerConns.get(c.peer)!.push(c);
      });

      // Send file.meta to ONE connection per peer, then give each peer a brief
      // window to reply with "file.resume" — which chunks (if any) it already
      // has for this exact mediaId, e.g. because it was mid-download before a
      // reconnect. Guests always reply promptly, even with empty ranges, so
      // this resolves fast for the common fresh-transfer case; the timeout is
      // just a safety net for a lost/delayed reply.
      const getResumeRanges = (peerId: string): Promise<Array<[number, number]>> => {
        const cached = resumeInfoRef.current.get(peerId);
        if (cached && cached.mediaId === mediaId) {
          resumeInfoRef.current.delete(peerId);
          return Promise.resolve(cached.ranges);
        }
        return new Promise((resolve) => {
          const timeout = window.setTimeout(() => {
            resumeWaitersRef.current.delete(peerId);
            resolve([]);
          }, RESUME_ACK_TIMEOUT_MS);
          resumeWaitersRef.current.set(peerId, (ranges) => {
            window.clearTimeout(timeout);
            resolve(ranges ?? []);
          });
        });
      };

      const peerSkipRanges = new Map<string, Array<[number, number]>>();
      await Promise.all(
        Array.from(peerConns.entries()).map(async ([peerId, connections]) => {
          const firstOpen = connections.find(c => c.open);
          if (!firstOpen) return;
          sendToOne(firstOpen, "file.meta", meta);
          const ranges = await getResumeRanges(peerId);
          if (ranges.length > 0) {
            peerSkipRanges.set(peerId, ranges);
            const alreadyHave = ranges.reduce((sum, [start, end]) => sum + (end - start + 1), 0);
            onEventRef.current("ok", "FILE", `${peerId}: resuming transfer — already has ${alreadyHave}/${totalChunks} chunks, skipping those.`);

            if (alreadyHave >= totalChunks) {
              // Every chunk gets skipped for this peer — nothing will ever be
              // sent or echoed back for them, so reflect completion now
              // instead of leaving their progress stuck at 0%.
              setPeerFileProgress((prev) => ({ ...prev, [peerId]: { chunksReceived: totalChunks, total: totalChunks } }));
            }
          }
        })
      );

      if (!isCurrent()) return; // superseded by a newer sendFile() call while we were waiting on resume replies

      onEventRef.current(
        "info",
        "FILE",
        `Starting blob transfer of "${file.name}" (${(file.size / 1024 / 1024).toFixed(1)} MB) to ${conns.length} peer connection(s)`
      );

      const chunkQueue: Array<{ index: number; total: number; data: Uint8Array; checksum: string }> = [];
      // Per-chunk checksums, kept independent of the queue above (which drains
      // as chunks are sent) so we can compute a whole-file integrity check —
      // see combineChecksums — once every chunk has been produced.
      const chunkChecksums = new Map<number, string>();
      let drainActive = false;
      let endSent = false;

      let workersActive = 0;
      let workersDone = 0;
      let workerError: string | null = null;

      // All workers created below, so a failure can terminate every one of
      // them instead of leaving survivors running in the background against
      // a transfer everyone else has already given up on.
      const workers: Worker[] = [];
      const terminateAllWorkers = () => {
        workers.forEach((w) => w.terminate());
      };

      // Best-effort: let every targeted peer know this transfer died, so a
      // guest mid-download doesn't sit at "Receiving..." forever with no
      // explanation once the sender side has actually given up.
      const notifyPeersAborted = (reason?: string) => {
        for (const [, connections] of peerConns.entries()) {
          const firstOpen = connections.find((c) => c.open);
          if (firstOpen) sendToOne(firstOpen, "file.aborted", { mediaId, reason });
        }
      };

      await new Promise<void>((resolve, reject) => {
        const rejectTransfer = (error: unknown) => reject(error);
        const peerConnIndex = new Map<string, number>();

        const drainQueue = async () => {
          if (drainActive) return;
          drainActive = true;

          try {
            while (chunkQueue.length > 0) {
              if (!isCurrent()) {
                resolve();
                return;
              }

              const chunk = chunkQueue.shift()!;

              // Send to each peer via round-robin over their available multiplexed
              // connections. Order doesn't need to match chunk index — the receiver
              // writes each chunk to its own byte offset in OPFS, so there's no
              // correctness reason to keep this queue sorted by index.
              for (const [peerId, connections] of peerConns.entries()) {
                const skipRanges = peerSkipRanges.get(peerId);
                if (skipRanges && rangesInclude(skipRanges, chunk.index)) {
                  continue;
                }

                const openConns = connections.filter(c => c.open);
                if (openConns.length === 0) continue;

                let cIdx = peerConnIndex.get(peerId) || 0;
                let conn = openConns[cIdx % openConns.length];
                peerConnIndex.set(peerId, cIdx + 1);

                const channel = conn.dataChannel ?? null;
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
              const fileChecksum = combineChecksums(chunkChecksums, totalChunks);
              for (const [, connections] of peerConns.entries()) {
                const firstOpen = connections.find(c => c.open);
                if (!firstOpen) continue;
                await waitForDrain(firstOpen);
                sendToOne(firstOpen, "file.end", { mediaId, checksum: fileChecksum });
                await waitForDrain(firstOpen);
              }
              onEventRef.current("ok", "FILE", `File "${file.name}" fully sent.`);
              resolve();
            }
          } catch (error) {
            rejectTransfer(error);
          } finally {
            drainActive = false;
            if (isCurrent() && (chunkQueue.length > 0 || (workersDone === workersActive && !endSent))) {
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
          workers.push(worker);

          worker.onmessage = (event: MessageEvent) => {
            if (!isCurrent()) {
              worker.terminate();
              return;
            }

            const msg = event.data as { type: string; [k: string]: unknown };
            if (msg.type === "ready") return;
            if (msg.type === "error") {
              workerError = msg.error as string;
              terminateAllWorkers();
              notifyPeersAborted(workerError);
              reject(new Error(workerError));
              return;
            }
            if (msg.type === "chunk") {
              const index = msg.index as number;
              const checksum = msg.checksum as string;
              chunkChecksums.set(index, checksum);
              chunkQueue.push({
                index,
                total: msg.total as number,
                data: msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data as ArrayLike<number>),
                checksum
              });
              void drainQueue();
            }
            if (msg.type === "worker_done") {
              workersDone++;
              worker.terminate();
              void drainQueue();
            }
          };

          worker.onerror = (err) => {
            terminateAllWorkers();
            notifyPeersAborted(err.message);
            reject(new Error(err.message));
          };

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
        if (isCurrent()) {
          onEventRef.current("error", "FILE", `File transfer failed: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      });

      // Clear the lock unconditionally once this transfer settles — on
      // success or failure alike. Previously this only ran on the success
      // path, so a worker failure left fileSendProgress (and therefore the
      // host's upload lock) stuck forever. If a newer transfer has already
      // superseded this one, `isCurrent()` is false and we correctly leave
      // its state alone instead of clobbering it.
      if (isCurrent()) {
        setFileSendProgress(null);
      }
    },
    [sendToOne]
  );

  /** Fully accept a connection (whether auto-approved or manually approved): wire it up and welcome it in. */
  const acceptConnection = useCallback(
    (conn: DataConnection) => {
      connectionsRef.current.push(conn);
      setConnectedPeers((prev) => (prev.includes(conn.peer) ? prev : [...prev, conn.peer]));
      setStatus("connected");
      onEventRef.current("ok", "WEBRTC", `Connection established with ${conn.peer}. ICE success.`);

      conn.on("data", (data) => { handleMessage(conn, data); });

      conn.send({
        id: crypto.randomUUID(),
        type: "room.hello",
        sentAt: performance.now(),
        payload: { peerId, label: `Host (${peerId.slice(3, 7)})` }
      });
    },
    [handleMessage, peerId]
  );

  /** Reject a connection: let the guest know why, then close it. */
  const declineConnection = useCallback((conn: DataConnection) => {
    onEventRef.current("warn", "WEBRTC", `Declined connection from ${conn.peer}.`);
    if (conn.open) {
      conn.send({
        id: crypto.randomUUID(),
        type: "room.joinDeclined",
        sentAt: performance.now(),
        payload: {}
      });
    }
    // Give the decline message a moment to actually go out over the data
    // channel before tearing the connection down.
    window.setTimeout(() => conn.close(), 250);
  }, []);

  /** Host-side: accept or decline a pending join request, applying the decision to all of that peer's queued channels. */
  const respondToJoinRequest = useCallback(
    (requestPeerId: string, accept: boolean) => {
      const timeout = pendingTimeoutsRef.current.get(requestPeerId);
      if (timeout) {
        window.clearTimeout(timeout);
        pendingTimeoutsRef.current.delete(requestPeerId);
      }

      const conns = pendingConnectionsRef.current.get(requestPeerId) ?? [];
      pendingConnectionsRef.current.delete(requestPeerId);
      peerDecisionRef.current.set(requestPeerId, accept ? "accepted" : "declined");
      setPendingRequests((prev) => prev.filter((r) => r.peerId !== requestPeerId));

      conns.forEach((conn) => {
        if (accept) {
          acceptConnection(conn);
        } else {
          declineConnection(conn);
        }
      });
    },
    [acceptConnection, declineConnection]
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
        // A peer that's already been decided (e.g. one of its later
        // multiplexed channels finishing handshake after the host already
        // acted on an earlier channel) gets the same treatment immediately.
        const decision = peerDecisionRef.current.get(conn.peer);

        if (decision === "accepted" || (!decision && allowAllConnectionsRef.current)) {
          acceptConnection(conn);
          return;
        }

        if (decision === "declined") {
          declineConnection(conn);
          return;
        }

        // No decision yet — queue this channel. If it's the first one from
        // this peer, surface a pending request for the host to act on.
        const existing = pendingConnectionsRef.current.get(conn.peer);
        if (existing) {
          existing.push(conn);
          return;
        }

        pendingConnectionsRef.current.set(conn.peer, [conn]);
        const label = conn.peer.startsWith("SP-GUEST") ? `Viewer (${conn.peer.slice(9)})` : conn.peer;
        setPendingRequests((prev) => [...prev, { peerId: conn.peer, label, requestedAt: Date.now() }]);
        onEventRef.current("info", "ROOM", `Join request from ${label} (${conn.peer}) — awaiting your approval.`);

        const timeout = window.setTimeout(() => {
          onEventRef.current("warn", "ROOM", `Join request from ${label} timed out without a response and was declined.`);
          respondToJoinRequest(conn.peer, false);
        }, PENDING_REQUEST_TIMEOUT_MS);
        pendingTimeoutsRef.current.set(conn.peer, timeout);
      });

      conn.on("iceStateChanged", (state) => {
        const level = state === "failed" ? "error" : state === "disconnected" ? "warn" : "info";
        onEventRef.current(level, "ICE", `Viewer ${conn.peer} ICE state: ${state}.`);
      });

      conn.on("close", () => {
        // If this channel never got a decision (guest gave up, or the
        // connection dropped while still pending), clean up its pending
        // bookkeeping too — it wouldn't otherwise be caught below since it
        // never made it into connectionsRef.
        const pendingForPeer = pendingConnectionsRef.current.get(conn.peer);
        if (pendingForPeer) {
          const remaining = pendingForPeer.filter((c) => c !== conn);
          if (remaining.length > 0) {
            pendingConnectionsRef.current.set(conn.peer, remaining);
          } else {
            pendingConnectionsRef.current.delete(conn.peer);
            setPendingRequests((prev) => prev.filter((r) => r.peerId !== conn.peer));
            const timeout = pendingTimeoutsRef.current.get(conn.peer);
            if (timeout) {
              window.clearTimeout(timeout);
              pendingTimeoutsRef.current.delete(conn.peer);
            }
          }
        }

        connectionsRef.current = connectionsRef.current.filter((c) => c !== conn);
        setConnectedPeers((prev) => prev.filter((id) => id !== conn.peer));
        onEventRef.current("warn", "WEBRTC", `Viewer ${conn.peer} disconnected.`);
        if (!connectionsRef.current.some((c) => c.peer === conn.peer)) {
          // Last channel for this peer closed — drop its adaptive cadence state
          // so a future rejoin starts fresh at the fastest interval.
          peerHealthRef.current.delete(conn.peer);
          guestActionHistoryRef.current.delete(conn.peer);
          resumeInfoRef.current.delete(conn.peer);
          resumeWaitersRef.current.delete(conn.peer);
          peerDecisionRef.current.delete(conn.peer);
          peerTransferStateRef.current.delete(conn.peer);
          setPeerFileProgress((prev) => {
            if (!(conn.peer in prev)) return prev;
            const next = { ...prev };
            delete next[conn.peer];
            return next;
          });
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
  }, [closeRoom, handleMessage, peerId, acceptConnection, declineConnection, respondToJoinRequest]);

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
                // The WebRTC channel is open, but the host may have "allow
                // all connections" off and be holding this pending — don't
                // claim "connected" yet. The host's room.hello (only ever
                // sent once a connection is actually accepted) is what
                // flips this to "connected", handled in handleMessage.
                setStatus("awaiting-approval");
                onEventRef.current("ok", "WEBRTC", `Data channel open with host. Awaiting host approval...`);
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
                // Don't clobber a "declined" state — the host closes the
                // connection right after declining, and this event can
                // easily fire before/around the same tick as the
                // room.joinDeclined message being processed.
                setStatus((prev) => (prev === "declined" ? prev : "disconnected"));
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
    peerFileProgress,
    pendingRequests,
    respondToJoinRequest,
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
    sendGuestAction,
    sendFileResume,
    sendFile
  };
}
