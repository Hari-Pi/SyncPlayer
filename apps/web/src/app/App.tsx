import {
  Activity,
  AlertTriangle,
  AudioLines,
  BadgeCheck,
  CircleDot,
  Clipboard,
  FileVideo,
  Gauge,
  Link2,
  Pause,
  Radar,
  RadioTower,
  RotateCcw,
  ScanLine,
  Send,
  Settings,
  Shield,
  Signal,
  Upload,
  Video
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Artplayer from "artplayer";
import { createActivity, type ActivityEntry, type ActivityLevel } from "@/features/activity-log/activityLog";
import { usePeerRoom } from "@/features/room/usePeerRoom";
import { createMediaHint, loadSyncCore, readDrift, quantisePositionSync, type DriftReading } from "@/lib/wasm/syncCore";
import { formatBytes, formatClock, formatDuration } from "@/lib/time/format";
import { inferMediaFormat, inferMediaKind, mediaFormatLabel, type LoadedMedia } from "@/lib/media/mediaTypes";
import { createLocalTabChannel } from "@/lib/sync/localTabSync";
import type { PlaybackSnapshot, FileMeta, RemoteMediaMount } from "@/lib/webrtc/messages";
import type { FileStreamHandlers } from "@/features/room/usePeerRoom";

const emptyDrift: DriftReading = {
  driftMs: 0,
  mode: "hold",
  rate: 1
};

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
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

function getPrimaryIceServer(config: ShareRtcConfig | null) {
  return config?.iceServers?.[0] ?? null;
}

function getIceServerUrls(server: RTCIceServer | null) {
  if (!server?.urls) return "";
  return Array.isArray(server.urls) ? server.urls.join("\n") : server.urls;
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

export function App() {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const artplayerContainerRef = useRef<HTMLDivElement | null>(null);
  const artRef = useRef<Artplayer | null>(null);
  const remoteApplyRef = useRef(false);
  const lastBroadcastRef = useRef(0);
  const [clock, setClock] = useState(formatClock());
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  // Keep a ref to the live media so async callbacks always see the current value,
  // not a stale closure from when the callback was last created.
  const mediaStateRef = useRef<LoadedMedia | null>(null);
  useEffect(() => { mediaStateRef.current = media; }, [media]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [responseLink, setResponseLink] = useState("");
  const [responseInput, setResponseInput] = useState("");
  const [localTabPeer, setLocalTabPeer] = useState("No local tab");
  const [openedThroughRoomLink, setOpenedThroughRoomLink] = useState(false);
  const [turnUrls, setTurnUrls] = useState(() => getIceServerUrls(getPrimaryIceServer(readStoredRtcConfig())));
  const [turnUsername, setTurnUsername] = useState(() => {
    const username = getPrimaryIceServer(readStoredRtcConfig())?.username;
    return typeof username === "string" ? username : "";
  });
  const [turnCredential, setTurnCredential] = useState(() => {
    const credential = getPrimaryIceServer(readStoredRtcConfig())?.credential;
    return typeof credential === "string" ? credential : "";
  });
  const [forceRelay, setForceRelay] = useState(() => readStoredRtcConfig()?.iceTransportPolicy === "relay");
  const handledShareLinkRef = useRef(false);
  const localTabChannelRef = useRef<ReturnType<typeof createLocalTabChannel>>(null);
  const roleRef = useRef<"solo" | "host" | "guest">("solo");
  const manualPauseTimesRef = useRef<number[]>([]);
  const hostFileRef = useRef<File | null>(null);
  const guestMseRef = useRef<{ ms: MediaSource; sb: SourceBuffer; queue: ArrayBuffer[]; updating: boolean } | null>(null);
  const guestBlobChunksRef = useRef<ArrayBuffer[]>([]);
  const [guestStreamUrl, setGuestStreamUrl] = useState<string | null>(null);
  const [guestStreamMeta, setGuestStreamMeta] = useState<FileMeta | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([
    createActivity("info", "BOOT", "Command deck initialized.")
  ]);
  const [wasmReady, setWasmReady] = useState(false);
  const [drift, setDrift] = useState<DriftReading>(emptyDrift);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot>({
    mediaId: null,
    position: 0,
    duration: 0,
    paused: true,
    playbackRate: 1
  });

  const log = useCallback((level: ActivityLevel, label: string, detail: string) => {
    setActivity((entries) => [createActivity(level, label, detail), ...entries].slice(0, 12));
  }, []);

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

      if (roleRef.current === "host") {
        return;
      }

      const reading = await readDrift(element.currentTime, remoteSnapshot.position, latencyMs);
      setDrift(reading);
      remoteApplyRef.current = true;

      if (reading.mode === "seek" || reading.mode === "firm") {
        element.currentTime = quantisePositionSync(remoteSnapshot.position + latencyMs / 1000, 30);
      } else if (reading.mode === "soft") {
        element.playbackRate = reading.rate;
      } else {
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

  // ── Guest file stream receiver ─────────────────────────────────────────────
  const handleFileStream = useCallback((meta: FileMeta): FileStreamHandlers => {
    setGuestStreamUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return null;
    });
    guestMseRef.current = null;
    guestBlobChunksRef.current = [];
    setGuestStreamMeta(meta);
    log("info", "FILE", `Receiving "${meta.fileName}" (${(meta.fileSize / 1024 / 1024).toFixed(1)} MB) — ${meta.isBlob ? "full blob" : "MSE stream"} mode`);

    // Set up the media state on the guest side so mediaId matches the host
    const kind = inferMediaKind(meta.mimeType || meta.fileName);
    setMedia({
      id: meta.mediaId,
      title: meta.fileName,
      sourceUrl: "", // will be replaced when stream is ready
      kind,
      format: inferMediaFormat(meta.mimeType || meta.fileName),
      origin: "remote-url",
      sizeBytes: meta.fileSize
    });

    if (!meta.isBlob) {
      // MSE progressive path — start playing immediately
      const ms = new MediaSource();
      const url = URL.createObjectURL(ms);
      const pendingChunks: ArrayBuffer[] = [];
      let appendChunk = (chunk: ArrayBuffer) => {
        pendingChunks.push(chunk);
      };

      ms.addEventListener("sourceopen", () => {
        let sb: SourceBuffer;
        try { sb = ms.addSourceBuffer(meta.mimeType); }
        catch { try { sb = ms.addSourceBuffer("video/mp4"); } catch { return; } }

        const state = { ms, sb, queue: [] as ArrayBuffer[], updating: false };
        guestMseRef.current = state;

        const flush = () => {
          if (state.updating || state.sb.updating || state.queue.length === 0) return;
          const chunk = state.queue.shift()!;
          state.updating = true;
          try { state.sb.appendBuffer(chunk); } catch { state.updating = false; }
        };

        sb.addEventListener("updateend", () => { state.updating = false; flush(); });
        appendChunk = (chunk) => {
          state.queue.push(chunk);
          flush();
        };
        pendingChunks.splice(0).forEach(appendChunk);
      }, { once: true });

      setGuestStreamUrl(url);
      setMedia((prev) => prev ? { ...prev, sourceUrl: url } : prev);

      return {
        onChunk: (_index, _total, data) => {
          const chunk = new ArrayBuffer(data.byteLength);
          new Uint8Array(chunk).set(data);
          appendChunk(chunk);
        },
        onEnd: () => {
          const tryEnd = () => {
            const state = guestMseRef.current;
            if (!state) {
              setTimeout(tryEnd, 150);
              return;
            }
            if (state.queue.length === 0 && !state.sb.updating) {
              try { state.ms.endOfStream(); } catch { /* ignore */ }
              setGuestStreamMeta(null);
              guestMseRef.current = null;
            } else { setTimeout(tryEnd, 150); }
          };
          tryEnd();
        }
      };
    } else {
      // Full blob path — accumulate then mount (MKV etc.)
      guestBlobChunksRef.current = [];
      return {
        onChunk: (index, _total, data) => {
          const chunk = new ArrayBuffer(data.byteLength);
          new Uint8Array(chunk).set(data);
          guestBlobChunksRef.current[index] = chunk;
        },
        onEnd: () => {
          const blob = new Blob(guestBlobChunksRef.current, { type: meta.mimeType || "video/x-matroska" });
          const url = URL.createObjectURL(blob);
          guestBlobChunksRef.current = [];
          setGuestStreamUrl(url);
          setMedia((prev) => prev ? { ...prev, sourceUrl: url } : prev);
          setGuestStreamMeta(null);
          log("ok", "FILE", `"${meta.fileName}" received and mounted for playback.`);
        }
      };
    }
  }, [log]);

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
      hostFileRef.current = null;
      log("ok", "MEDIA", source === "invite" ? "Media URL loaded from invite link." : `${mediaFormatLabel(nextMedia.format)} URL mounted.`);
      return nextMedia;
    },
    [log]
  );

  const handleRemoteMediaMount = useCallback((nextMedia: RemoteMediaMount) => {
    setGuestStreamUrl((previousUrl) => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      return null;
    });
    guestMseRef.current = null;
    guestBlobChunksRef.current = [];
    setGuestStreamMeta(null);
    hostFileRef.current = null;
    setRemoteUrl(nextMedia.sourceUrl);
    setMedia(nextMedia);
    setDrift(emptyDrift);
    log("ok", "MEDIA", `${nextMedia.title} mounted from host.`);
  }, [log]);

  const room = usePeerRoom({
    onPlaybackState: handleRemotePlayback,
    onEvent: log,
    onFileStream: handleFileStream,
    onMediaMount: handleRemoteMediaMount
  });

  useEffect(() => {
    roleRef.current = room.role;
  }, [room.role]);

  const isSecureOrigin = window.isSecureContext || isLocalhost();
  const roomActionLabel =
    room.status === "connected"
      ? "Peer Connected"
      : room.role === "host" && inviteLink
        ? "Room Hosted"
        : room.status === "pairing"
          ? "Hosting Room"
          : "Start Room & Copy Invite";
  const topInviteLabel = inviteLink ? "Invite Copied" : "Copy Invite Link";

  const saveTurnConfig = useCallback(() => {
    const urls = turnUrls
      .split(/\r?\n|,/)
      .map((url) => url.trim())
      .filter(Boolean);

    if (urls.length === 0) {
      writeStoredRtcConfig(null);
      setForceRelay(false);
      log("warn", "ICE", "TURN relay config cleared. Public STUN/TURN fallback will be used.");
      return;
    }

    const config: ShareRtcConfig = {
      iceServers: [
        {
          urls,
          username: turnUsername.trim() || undefined,
          credential: turnCredential.trim() || undefined
        }
      ],
      iceTransportPolicy: forceRelay ? "relay" : "all"
    };

    writeStoredRtcConfig(config);
    log("ok", "ICE", `TURN relay config saved with ${urls.length} URL${urls.length === 1 ? "" : "s"}. Create a fresh invite link.`);
  }, [forceRelay, log, turnCredential, turnUrls, turnUsername]);

  const clearTurnConfig = useCallback(() => {
    writeStoredRtcConfig(null);
    setTurnUrls("");
    setTurnUsername("");
    setTurnCredential("");
    setForceRelay(false);
    log("warn", "ICE", "TURN relay config cleared. Public STUN/TURN fallback will be used.");
  }, [log]);

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

  const acceptResponseLink = useCallback(
    async (value: string) => {
      try {
        const payload = decodeSharePayload(value.trim());

        if (payload.type !== "response") {
          log("error", "SHARE", "That link is an invite link. Paste the viewer response link here.");
          return;
        }

        await room.acceptGuestAnswer(payload.answer);
      } catch {
        log("error", "SHARE", "Could not read that response link.");
      }
    },
    [log, room]
  );

  useEffect(() => {
    loadSyncCore()
      .then(() => {
        setWasmReady(true);
        log("ok", "WASM", "Sync core loaded.");
      })
      .catch(() => log("error", "WASM", "Sync core failed to load."));
  }, [log]);

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

  useEffect(() => {
    const channel = createLocalTabChannel((message) => {
      if (message.type === "hello") {
        setLocalTabPeer(message.peerId);
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
        const server = getPrimaryIceServer(payload.rtcConfig);
        setTurnUrls(getIceServerUrls(server));
        setTurnUsername(typeof server?.username === "string" ? server.username : "");
        setTurnCredential(typeof server?.credential === "string" ? server.credential : "");
        setForceRelay(payload.rtcConfig.iceTransportPolicy === "relay");
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

          setResponseLink(nextResponseLink);
          copyText(nextResponseLink);
          log("ok", "SHARE", "Response link copied. Send it back to the room owner.");
        })
        .catch(() => log("error", "SHARE", "Could not join from this invite link."));
      return;
    }

    setResponseInput(window.location.href);
    log("info", "SHARE", "Response link detected. Paste it into the open host tab to finish connecting.");
  }, [log, mountRemoteMedia, room]);

  const publishSnapshot = useCallback(() => {
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

    if (now - lastBroadcastRef.current > 250) {
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
    const timer = window.setInterval(publishSnapshot, 1500);
    return () => window.clearInterval(timer);
  }, [publishSnapshot]);

  const copyActivityLogs = useCallback(() => {
    const formattedLogs = activity
      .slice()
      .reverse()
      .map((entry) => `[${entry.at}] [${entry.level.toUpperCase()}] ${entry.label}: ${entry.detail}`)
      .join("\n");
    copyText(formattedLogs);
    log("ok", "SHARE", "Activity logs copied to clipboard.");
  }, [activity, log]);

  const handlePause = useCallback(() => {
    const element = mediaRef.current;
    if (!element) return;

    if (remoteApplyRef.current) {
      publishSnapshot();
      return;
    }

    if (room.role === "host") {
      publishSnapshot();
      return;
    }

    if (room.role === "guest") {
      const now = Date.now();
      manualPauseTimesRef.current = manualPauseTimesRef.current.filter(
        (t) => now - t < 60000
      );

      if (manualPauseTimesRef.current.length >= 3) {
        log("warn", "LIMIT", "Viewer pause limit exceeded (3 pauses per minute max). Resuming playback.");
        void element.play().catch(() => {
          log("error", "PLAYBACK", "Failed to override guest pause restriction.");
        });
      } else {
        manualPauseTimesRef.current.push(now);
        log("info", "PLAYBACK", `Local pause registered (${manualPauseTimesRef.current.length}/3 in last 1m).`);
        publishSnapshot();
      }
    } else {
      publishSnapshot();
    }
  }, [room.role, publishSnapshot, log]);

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
      void room.sendFile(hostFileRef.current, currentMedia.id);
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
    setResponseLink("");
    setResponseInput("");
    log("info", "NAV", "Share URL removed from address bar.");
  }, [log]);

  const publishSnapshotRef = useRef(publishSnapshot);
  const handlePauseRef = useRef(handlePause);
  const handleLoadedMetadataRef = useRef(handleLoadedMetadata);

  useEffect(() => {
    publishSnapshotRef.current = publishSnapshot;
  }, [publishSnapshot]);

  useEffect(() => {
    handlePauseRef.current = handlePause;
  }, [handlePause]);

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

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          log("ok", "HLS", "HLS Audio manifest parsed and attached.");
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          log(data.fatal ? "error" : "warn", "HLS", `${data.type}: ${data.details}`);
        });
        hls.loadSource(media.sourceUrl);
        hls.attachMedia(element);
        engineCleanup = () => hls.destroy();
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
        player.initialize(element, media.sourceUrl, false);
        log("ok", "DASH", "MPEG-DASH audio manifest attached.");
        engineCleanup = () => player.reset();
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
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              log("ok", "HLS", "HLS stream manifest attached to ArtPlayer.");
            });
            hls.on(Hls.Events.ERROR, (_, data) => {
              log(data.fatal ? "error" : "warn", "HLS", `${data.type}: ${data.details}`);
            });
            artInstance.on("destroy", () => hls.destroy());
          });
        },
        mpd: function (video, url, artInstance) {
          import("dashjs").then((dashjs) => {
            if (!dashjs.supportsMediaSource()) {
              log("error", "DASH", "MPEG-DASH is not supported in this browser.");
              return;
            }
            const player = dashjs.MediaPlayer().create();
            player.initialize(video, url, false);
            log("ok", "DASH", "MPEG-DASH stream attached to ArtPlayer.");
            artInstance.on("destroy", () => player.reset());
          });
        }
      }
    });

    artRef.current = art;

    art.on("ready", () => {
      const video = art.video;
      mediaRef.current = video;

      const onPlay = () => publishSnapshotRef.current();
      const onPause = () => handlePauseRef.current();
      const onSeeked = () => publishSnapshotRef.current();
      const onRateChange = () => publishSnapshotRef.current();
      const onTimeUpdate = () => publishSnapshotRef.current();
      const onLoadedMetadata = () => handleLoadedMetadataRef.current();

      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("ratechange", onRateChange);
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("loadedmetadata", onLoadedMetadata);

      if (video.duration) {
        onLoadedMetadata();
      }

      art.on("destroy", () => {
        video.removeEventListener("play", onPlay);
        video.removeEventListener("pause", onPause);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("ratechange", onRateChange);
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
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

  const driftTone = useMemo(() => {
    if (drift.mode === "hold" || drift.mode === "soft") {
      return "ok";
    }

    return "warn";
  }, [drift.mode]);

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
            {wasmReady ? "WASM READY" : "WASM BOOT"}
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
              <button type="button" className="status-band__btn" onClick={publishSnapshot}>
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
                Establishing automated WebRTC link to Host (<strong>{room.localOffer}</strong>). Please wait while signaling completes...
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
                Could not connect to Host (<strong>{room.localOffer}</strong>). Check the Activity Log below for details.
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
            <button type="button" className="status-band__btn primary-action" onClick={() => copyText(inviteLink)}>
              <Clipboard size={14} />
              Copy Invite Link
            </button>
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
              <Metric label="LATENCY" value={`${room.latencyMs}ms`} tone={room.latencyMs < 90 ? "ok" : "warn"} />
              <Metric label="PEER" value={room.remotePeer} />
              <Metric label="LOCAL TAB" value={localTabPeer} tone={localTabPeer === "No local tab" ? "normal" : "ok"} />
            </div>
          </Panel>

          <Panel title="Sync Core" icon={<Gauge size={15} />}>
            <div className="sync-meter">
              <div className="sync-meter__ring">
                <span>{Math.round(Math.abs(drift.driftMs))}</span>
                <small>MS</small>
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
          </Panel>
        </aside>

        <section className="main-stage">
          <div className="control-strip">
            <label className="file-button">
              <Upload size={16} />
              Select File
              <input accept="audio/*,video/*" type="file" onChange={handleLocalFile} />
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
              />
              <button type="button" onClick={handleRemoteUrl}>
                <Send size={15} />
                Load URL
              </button>
            </div>
            <button type="button" onClick={createInviteLink}>
              <Clipboard size={15} />
              {topInviteLabel}
            </button>
          </div>

          <Panel title="Playback Surface" icon={<Video size={15} />} className="player-panel">
            <div className="player-shell">
              {/* Guest receive progress bar */}
              {guestStreamMeta && (
                <div className="stream-progress-wrap">
                  <div className="stream-progress-label">
                    <span>{guestStreamMeta.isBlob ? "Receiving file" : "Streaming"}: <strong>{guestStreamMeta.fileName}</strong></span>
                    <span>{room.fileReceiveProgress ? `${Math.round((room.fileReceiveProgress.chunksReceived / room.fileReceiveProgress.total) * 100)}%` : ""}</span>
                  </div>
                  <div className="stream-progress-bar">
                    <div
                      className="stream-progress-bar__fill"
                      style={{ width: room.fileReceiveProgress ? `${(room.fileReceiveProgress.chunksReceived / room.fileReceiveProgress.total) * 100}%` : "0%" }}
                    />
                  </div>
                </div>
              )}
              {media ? (
                media.kind === "audio" ? (
                  <div className="audio-stage">
                    <AudioLines size={76} />
                    <strong>{media.title}</strong>
                    <audio
                      ref={bindMediaElement}
                      controls
                      onLoadedMetadata={handleLoadedMetadata}
                      onPlay={publishSnapshot}
                      onPause={handlePause}
                      onSeeked={publishSnapshot}
                      onRateChange={publishSnapshot}
                      onTimeUpdate={publishSnapshot}
                    />
                  </div>
                ) : (
                  <div
                    ref={artplayerContainerRef}
                    className="artplayer-container"
                    style={{ width: "100%", height: "100%", minHeight: "360px" }}
                  />
                )
              ) : (
                <div className="empty-player">
                  <ScanLine size={54} />
                  <strong>{guestStreamMeta ? `Receiving "${guestStreamMeta.fileName}"...` : "Mount media to begin"}</strong>
                  <span>{guestStreamMeta ? `${guestStreamMeta.isBlob ? "Full file transfer" : "MSE progressive stream"} in progress` : "Local files stream to viewers automatically over P2P."}</span>
                </div>
              )}
            </div>
          </Panel>
        </section>

        <aside className="right-rail">
          <Panel title="Share Room" icon={<Link2 size={15} />}>
            <div className="share-flow">
              <button type="button" className="primary-action" onClick={createInviteLink}>
                <Clipboard size={15} />
                {roomActionLabel}
              </button>
              <button type="button" onClick={room.closeRoom}>
                <Pause size={15} />
                End Room
              </button>
            </div>

            <div className="helper-copy">
              <strong>How sharing works</strong>
              <p>
                Send the invite link to a viewer. Once they open it, they will connect to your room automatically using PeerJS.
              </p>
            </div>

            <div className="relay-settings">
              <span className="section-title">TURN Relay</span>
              <label className="signal-box signal-box--compact">
                URLs
                <textarea
                  value={turnUrls}
                  onChange={(event) => setTurnUrls(event.target.value)}
                  placeholder={"turn:relay.example.com:3478\nturns:relay.example.com:443?transport=tcp"}
                  rows={3}
                />
              </label>
              <div className="relay-settings__grid">
                <label className="signal-box signal-box--compact">
                  Username
                  <input value={turnUsername} onChange={(event) => setTurnUsername(event.target.value)} />
                </label>
                <label className="signal-box signal-box--compact">
                  Credential
                  <input value={turnCredential} onChange={(event) => setTurnCredential(event.target.value)} type="password" />
                </label>
              </div>
              <label className="relay-settings__toggle">
                <input checked={forceRelay} onChange={(event) => setForceRelay(event.target.checked)} type="checkbox" />
                Force TURN relay
              </label>
              <div className="relay-settings__actions">
                <button type="button" onClick={saveTurnConfig}>
                  <Settings size={14} />
                  Save TURN
                </button>
                <button type="button" onClick={clearTurnConfig}>
                  <RotateCcw size={14} />
                  Clear
                </button>
              </div>
            </div>

            {/* Host send progress bar */}
            {room.fileSendProgress && (
              <div className="stream-progress-wrap">
                <div className="stream-progress-label">
                  <span>Streaming to peers: <strong>{room.fileSendProgress.fileName}</strong></span>
                  <span>{Math.round((room.fileSendProgress.chunksSent / room.fileSendProgress.total) * 100)}%</span>
                </div>
                <div className="stream-progress-bar">
                  <div
                    className="stream-progress-bar__fill"
                    style={{ width: `${(room.fileSendProgress.chunksSent / room.fileSendProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <label className="signal-box signal-box--compact">
              Invite link to send
              <input readOnly value={inviteLink} placeholder="Select media, then click Start Room & Copy Invite." />
              <button type="button" onClick={() => copyText(inviteLink)}>
                <Clipboard size={14} />
                Copy Invite Link
              </button>
            </label>

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

            <button type="button" onClick={publishSnapshot} style={{ marginTop: "1.2rem" }}>
              <CircleDot size={15} />
              Send Current Playback State
            </button>
          </Panel>
        </aside>
      </section>

      <footer className="bottom-console">
        <Panel
          title="Activity Log"
          icon={<Activity size={15} />}
          action={
            <button type="button" className="panel__btn" onClick={copyActivityLogs}>
              <Clipboard size={12} />
              Copy Logs
            </button>
          }
        >
          <div className="log-list">
            {activity.map((entry) => (
              <div className={cx("log-entry", `log-entry--${entry.level}`)} key={entry.id}>
                <span>{entry.at}</span>
                <strong>{entry.label}</strong>
                <p>{entry.detail}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Transport Telemetry" icon={<Settings size={15} />} className="telemetry-panel">
          <div className="metrics-grid metrics-grid--wide">
            <Metric label="SENT" value={String(room.messagesSent)} />
            <Metric label="RECEIVED" value={String(room.messagesReceived)} />
            <Metric label="POSITION" value={formatDuration(snapshot.position)} />
            <Metric label="RATE" value={`${snapshot.playbackRate.toFixed(2)}x`} />
          </div>
        </Panel>
      </footer>
    </main>
  );
}
