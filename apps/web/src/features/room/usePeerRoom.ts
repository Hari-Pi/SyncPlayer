import { useCallback, useMemo, useRef, useState } from "react";
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
    { urls: "stun:stun.services.mozilla.com" }
  ]
};

function encodeDescription(description: RTCSessionDescription | RTCSessionDescriptionInit | null) {
  if (!description) {
    return "";
  }

  return JSON.stringify({ type: description.type, sdp: description.sdp }, null, 2);
}

function parseDescription(signal: string): RTCSessionDescriptionInit {
  const parsed = JSON.parse(signal) as RTCSessionDescriptionInit;

  if (!parsed.type || !parsed.sdp) {
    throw new Error("Signal must include type and sdp.");
  }

  return parsed;
}

function hasRtcSupport() {
  return typeof RTCPeerConnection !== "undefined";
}

async function waitForIceGathering(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 6000);

    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") {
        window.clearTimeout(timeout);
        resolve();
      }
    });
  });
}

export function usePeerRoom({ onPlaybackState, onEvent }: PeerRoomOptions) {
  const [role, setRole] = useState<RoomRole>("solo");
  const [status, setStatus] = useState<LinkStatus>("idle");
  const [localOffer, setLocalOffer] = useState("");
  const [localAnswer, setLocalAnswer] = useState("");
  const [remotePeer, setRemotePeer] = useState("Awaiting peer");
  const [latencyMs, setLatencyMs] = useState(0);
  const [messagesSent, setMessagesSent] = useState(0);
  const [messagesReceived, setMessagesReceived] = useState(0);
  const peerId = useMemo(() => `SP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, []);
  const connectionRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const pingRef = useRef<{ id: string; at: number } | null>(null);

  const closeRoom = useCallback(() => {
    channelRef.current?.close();
    connectionRef.current?.close();
    channelRef.current = null;
    connectionRef.current = null;
    setStatus("idle");
    setRole("solo");
    setRemotePeer("Awaiting peer");
  }, []);

  const send = useCallback((type: WireMessage["type"], payload: WireMessage["payload"]) => {
    const channel = channelRef.current;

    if (!channel || channel.readyState !== "open") {
      return false;
    }

    const message = {
      id: crypto.randomUUID(),
      type,
      sentAt: performance.now(),
      payload
    };

    channel.send(JSON.stringify(message));
    setMessagesSent((count) => count + 1);
    return true;
  }, []);

  const sendPlaybackState = useCallback(
    (snapshot: PlaybackSnapshot) => {
      send("playback.state", snapshot);
    },
    [send]
  );

  const handleMessage = useCallback(
    (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as WireMessage;
      setMessagesReceived((count) => count + 1);

      if (message.type === "room.hello") {
        setRemotePeer(message.payload.label);
        onEvent("ok", "PEER LINK", `${message.payload.label} joined the data channel.`);
        return;
      }

      if (message.type === "playback.state") {
        onPlaybackState(message.payload, latencyMs);
        return;
      }

      if (message.type === "clock.ping") {
        send("clock.pong", {
          pingId: message.payload.pingId,
          originAt: message.payload.originAt
        });
        return;
      }

      if (message.type === "clock.pong" && pingRef.current?.id === message.payload.pingId) {
        const roundTrip = performance.now() - pingRef.current.at;
        setLatencyMs(Math.round(roundTrip / 2));
        pingRef.current = null;
      }
    },
    [latencyMs, onEvent, onPlaybackState, send]
  );

  const bindConnection = useCallback(
    (peer: RTCPeerConnection) => {
      peer.onconnectionstatechange = () => {
        const state = peer.connectionState;

        if (state === "connected") {
          setStatus("connected");
          onEvent("ok", "RTC", "Peer connection established.");
        } else if (state === "failed") {
          setStatus("failed");
          onEvent("error", "RTC", "Peer connection failed.");
        } else if (state === "disconnected" || state === "closed") {
          setStatus("disconnected");
          onEvent("warn", "RTC", "Peer connection disconnected.");
        }
      };
    },
    [onEvent]
  );

  const bindChannel = useCallback(
    (channel: RTCDataChannel, localLabel: string) => {
      channelRef.current = channel;
      channel.onmessage = handleMessage;
      channel.onopen = () => {
        setStatus("connected");
        onEvent("ok", "DATA CHANNEL", "Control channel is open.");
        send("room.hello", {
          peerId,
          label: localLabel
        });
      };
      channel.onclose = () => {
        setStatus("disconnected");
        onEvent("warn", "DATA CHANNEL", "Control channel closed.");
      };
    },
    [handleMessage, onEvent, peerId, send]
  );

  const createHostOffer = useCallback(async () => {
    closeRoom();
    setRole("host");
    setStatus("pairing");
    setLocalAnswer("");
    setLocalOffer("");

    if (!hasRtcSupport()) {
      setStatus("failed");
      onEvent("error", "RTC", "WebRTC is unavailable. Open this app over HTTPS or localhost.");
      return;
    }

    const peer = new RTCPeerConnection(rtcConfig);
    connectionRef.current = peer;
    bindConnection(peer);

    const channel = peer.createDataChannel("syncplayer-control", { ordered: true });
    bindChannel(channel, "Room owner");

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForIceGathering(peer);
    const encodedOffer = encodeDescription(peer.localDescription);
    setLocalOffer(encodedOffer);
    onEvent("info", "ROOM", "Invite link is ready to share.");
    return encodedOffer;
  }, [bindChannel, bindConnection, closeRoom, onEvent]);

  const acceptGuestAnswer = useCallback(
    async (answerSignal: string) => {
      if (!connectionRef.current) {
        onEvent("error", "ROOM", "Create an invite link before applying a response link.");
        return;
      }

      await connectionRef.current.setRemoteDescription(parseDescription(answerSignal));
      onEvent("ok", "ROOM", "Viewer response accepted. Connecting peer-to-peer.");
    },
    [onEvent]
  );

  const joinWithOffer = useCallback(
    async (offerSignal: string) => {
      closeRoom();
      setRole("guest");
      setStatus("pairing");
      setLocalOffer("");
      setLocalAnswer("");

      if (!hasRtcSupport()) {
        setStatus("failed");
        onEvent("error", "RTC", "WebRTC is unavailable. Open this app over HTTPS or localhost.");
        return;
      }

      const peer = new RTCPeerConnection(rtcConfig);
      connectionRef.current = peer;
      bindConnection(peer);
      peer.ondatachannel = (event) => bindChannel(event.channel, "Viewer");

      await peer.setRemoteDescription(parseDescription(offerSignal));
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      await waitForIceGathering(peer);
      const encodedAnswer = encodeDescription(peer.localDescription);
      setLocalAnswer(encodedAnswer);
      onEvent("info", "ROOM", "Response link is ready. Send it back to the room owner.");
      return encodedAnswer;
    },
    [bindChannel, bindConnection, closeRoom, onEvent]
  );

  const pingPeer = useCallback(() => {
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
    createHostOffer,
    acceptGuestAnswer,
    joinWithOffer,
    closeRoom,
    pingPeer,
    sendPlaybackState
  };
}
