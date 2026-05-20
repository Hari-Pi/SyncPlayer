import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Peer, DataConnection } from "peerjs";
import type { PlaybackSnapshot, WireMessage } from "@/lib/webrtc/messages";

type RoomRole = "solo" | "host" | "guest";
type LinkStatus = "idle" | "pairing" | "connected" | "disconnected" | "failed";

type PeerRoomOptions = {
  onPlaybackState: (snapshot: PlaybackSnapshot, latencyMs: number) => void;
  onEvent: (level: "info" | "ok" | "warn" | "error", label: string, detail: string) => void;
};

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
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

export function usePeerRoom({ onPlaybackState, onEvent }: PeerRoomOptions) {
  const [role, setRole] = useState<RoomRole>("solo");
  const [status, setStatus] = useState<LinkStatus>("idle");
  const [localOffer, setLocalOffer] = useState("");
  const [localAnswer, setLocalAnswer] = useState("");
  const [remotePeer, setRemotePeer] = useState("Awaiting peer");
  const [latencyMs, setLatencyMs] = useState(0);
  const [messagesSent, setMessagesSent] = useState(0);
  const [messagesReceived, setMessagesReceived] = useState(0);
  const [connectedPeers, setConnectedPeers] = useState<string[]>([]);

  const peerId = useMemo(() => `SP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, []);
  
  // Store callbacks in refs so data listeners always invoke the latest version
  // without needing to close over them (avoids stale closure on media state changes).
  const onPlaybackStateRef = useRef(onPlaybackState);
  const onEventRef = useRef(onEvent);
  useEffect(() => { onPlaybackStateRef.current = onPlaybackState; }, [onPlaybackState]);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]);
  const pingRef = useRef<{ id: string; at: number } | null>(null);

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
    if (conns.length === 0) {
      return false;
    }

    const message = {
      id: crypto.randomUUID(),
      type,
      sentAt: performance.now(),
      payload
    };

    conns.forEach((conn) => {
      if (conn.open) {
        conn.send(message);
      }
    });

    setMessagesSent((count) => count + conns.length);
    return true;
  }, []);

  const sendPlaybackState = useCallback(
    (snapshot: PlaybackSnapshot) => {
      send("playback.state", snapshot);
    },
    [send]
  );

  const latencyMsRef = useRef(latencyMs);
  useEffect(() => { latencyMsRef.current = latencyMs; }, [latencyMs]);

  const handleMessage = useCallback(
    (conn: DataConnection, eventData: unknown) => {
      setMessagesReceived((count) => count + 1);
      const message = eventData as WireMessage;

      if (message.type === "room.hello") {
        setRemotePeer((prev) => prev === "Awaiting peer" ? message.payload.label : `${prev}, ${message.payload.label}`);
        onEventRef.current("ok", "PEER LINK", `${message.payload.label} (${conn.peer}) successfully negotiated handshake.`);
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
          payload: {
            pingId: message.payload.pingId,
            originAt: message.payload.originAt
          }
        });
        return;
      }

      if (message.type === "clock.pong" && pingRef.current?.id === message.payload.pingId) {
        const roundTrip = performance.now() - pingRef.current.at;
        setLatencyMs(Math.round(roundTrip / 2));
        pingRef.current = null;
      }
    },
    [] // stable: reads latest callbacks/latency via refs, no deps needed
  );

  const createHostOffer = useCallback(async () => {
    closeRoom();
    setRole("host");
    setStatus("pairing");
    setLocalAnswer("");
    setLocalOffer(peerId); // Backwards compatibility: payload offer is host's Peer ID

    onEvent("info", "PEERJS", `Initializing room owner node. Host Peer ID: ${peerId}`);
    
    const peer = new Peer(peerId, { config: rtcConfig });
    peerRef.current = peer;

    peer.on("open", (id) => {
      onEventRef.current("ok", "PEERJS", `Successfully connected to signaling broker. Room ID: ${id}`);
    });

    peer.on("connection", (conn) => {
      onEventRef.current("info", "WEBRTC", `Incoming connection handshake from peer: ${conn.peer}`);

      conn.on("open", () => {
        connectionsRef.current.push(conn);
        setConnectedPeers((prev) => [...prev, conn.peer]);
        setStatus("connected");
        onEventRef.current("ok", "WEBRTC", `Connection established with peer ${conn.peer}. ICE connection successful.`);
        
        conn.send({
          id: crypto.randomUUID(),
          type: "room.hello",
          sentAt: performance.now(),
          payload: {
            peerId,
            label: `Host (${peerId.slice(3, 7)})`
          }
        });
      });

      conn.on("data", (data) => {
        handleMessage(conn, data);
      });

      conn.on("close", () => {
        connectionsRef.current = connectionsRef.current.filter((c) => c !== conn);
        setConnectedPeers((prev) => prev.filter((id) => id !== conn.peer));
        onEventRef.current("warn", "WEBRTC", `Viewer ${conn.peer} closed their connection channel.`);
        if (connectionsRef.current.length === 0) {
          setStatus("disconnected");
          setRemotePeer("Awaiting peer");
        }
      });

      conn.on("error", (err) => {
        onEventRef.current("error", "WEBRTC", `WebRTC error with viewer ${conn.peer}: ${err.message}`);
      });
    });

    peer.on("error", (err) => {
      onEventRef.current("error", "PEERJS", `Host broker socket error: ${err.message}`);
      setStatus("failed");
    });

    return peerId;
  }, [closeRoom, handleMessage, peerId]);

  const acceptGuestAnswer = useCallback(
    async (answerSignal: string) => {
      // Manual response links are fully deprecated. No-op for backwards compatibility.
      onEventRef.current("info", "ROOM", "Manual signaling is deprecated. Connections now occur automatically.");
    },
    []
  );

  const joinWithOffer = useCallback(
    async (hostId: string) => {
      closeRoom();
      setRole("guest");
      setStatus("pairing");
      setLocalOffer(hostId);
      setLocalAnswer("");

      const guestId = `SP-GUEST-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
      onEvent("info", "PEERJS", `Initializing guest node. Guest ID: ${guestId}`);
      onEvent("info", "WEBRTC", `Attempting connection to room: ${hostId}`);

      const peer = new Peer(guestId, { config: rtcConfig });
      peerRef.current = peer;

      peer.on("open", (id) => {
        onEventRef.current("ok", "PEERJS", `Successfully connected to signaling broker. Guest ID: ${id}`);
        onEventRef.current("info", "WEBRTC", `Negotiating WebRTC handshake with room host: ${hostId}`);
        const conn = peer.connect(hostId);

        conn.on("open", () => {
          connectionsRef.current.push(conn);
          setConnectedPeers([hostId]);
          setStatus("connected");
          onEventRef.current("ok", "WEBRTC", `Successfully joined room. Data channel is open with host.`);

          conn.send({
            id: crypto.randomUUID(),
            type: "room.hello",
            sentAt: performance.now(),
            payload: {
              peerId: guestId,
              label: `Viewer (${guestId.slice(9)})`
            }
          });
        });

        conn.on("data", (data) => {
          handleMessage(conn, data);
        });

        conn.on("close", () => {
          connectionsRef.current = [];
          setConnectedPeers([]);
          setStatus("disconnected");
          setRemotePeer("Awaiting peer");
          onEventRef.current("warn", "WEBRTC", `Room host (${hostId}) disconnected.`);
        });

        conn.on("error", (err) => {
          onEventRef.current("error", "WEBRTC", `WebRTC data channel error: ${err.message}`);
          setStatus("failed");
        });
      });

      peer.on("error", (err) => {
        onEventRef.current("error", "PEERJS", `Guest broker socket error: ${err.message}`);
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
    send("clock.ping", {
      pingId,
      originAt
    });
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
    createHostOffer,
    acceptGuestAnswer,
    joinWithOffer,
    closeRoom,
    pingPeer,
    sendPlaybackState
  };
}
