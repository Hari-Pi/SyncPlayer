import {
  Activity,
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
import { createActivity, type ActivityEntry, type ActivityLevel } from "@/features/activity-log/activityLog";
import { usePeerRoom } from "@/features/room/usePeerRoom";
import { createMediaHint, loadSyncCore, readDrift, type DriftReading } from "@/lib/wasm/syncCore";
import { formatBytes, formatClock, formatDuration } from "@/lib/time/format";
import { inferMediaFormat, inferMediaKind, mediaFormatLabel, type LoadedMedia } from "@/lib/media/mediaTypes";
import { createLocalTabChannel } from "@/lib/sync/localTabSync";
import type { PlaybackSnapshot } from "@/lib/webrtc/messages";

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
  children,
  className
}: {
  title: string;
  icon?: React.ReactNode;
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
type SharePayload =
  | {
      type: "invite";
      offer: string;
      media: ShareMedia | null;
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

export function App() {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const remoteApplyRef = useRef(false);
  const lastBroadcastRef = useRef(0);
  const [clock, setClock] = useState(formatClock());
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [inviteLink, setInviteLink] = useState("");
  const [responseLink, setResponseLink] = useState("");
  const [responseInput, setResponseInput] = useState("");
  const [localTabPeer, setLocalTabPeer] = useState("No local tab");
  const handledShareLinkRef = useRef(false);
  const localTabChannelRef = useRef<ReturnType<typeof createLocalTabChannel>>(null);
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

      if (!element || !media || remoteSnapshot.mediaId !== media.id) {
        log("warn", "SYNC", "Remote playback state received for different media.");
        return;
      }

      const reading = await readDrift(element.currentTime, remoteSnapshot.position, latencyMs);
      setDrift(reading);
      remoteApplyRef.current = true;

      if (reading.mode === "seek" || reading.mode === "firm") {
        element.currentTime = remoteSnapshot.position + latencyMs / 1000;
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
    [log, media]
  );

  const room = usePeerRoom({
    onPlaybackState: handleRemotePlayback,
    onEvent: log
  });

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

  const mountRemoteMedia = useCallback(
    (url: string, source: "manual" | "invite") => {
      let parsedUrl: URL;

      try {
        parsedUrl = new URL(url);
      } catch {
        log("error", "MEDIA", "That media URL is not valid.");
        return false;
      }

      const format = inferMediaFormat(url);

      setRemoteUrl(url);
      setMedia({
        id: `url:${url}`,
        title: parsedUrl.pathname.split("/").pop() || "Remote stream",
        sourceUrl: url,
        kind: inferMediaKind(url),
        format,
        origin: "remote-url"
      });
      setDrift(emptyDrift);
      log("ok", "MEDIA", source === "invite" ? "Media URL loaded from invite link." : `${mediaFormatLabel(format)} URL mounted.`);
      return true;
    },
    [log]
  );

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
      media: shareableMedia
    });

    setInviteLink(nextInviteLink);
    copyText(nextInviteLink);

    if (media?.origin === "local-file") {
      log("warn", "SHARE", "Invite link created. Local file transfer is not active yet, so the viewer will need the same file.");
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
      room.sendPlaybackState(nextSnapshot);
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

  const handleLocalFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];

      if (!file) {
        return;
      }

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
    },
    [log]
  );

  const handleRemoteUrl = useCallback(async () => {
    const url = remoteUrl.trim();

    if (!url) {
      return;
    }

    mountRemoteMedia(url, "manual");
  }, [mountRemoteMedia, remoteUrl]);

  useEffect(() => {
    const element = mediaRef.current;
    let disposed = false;
    let engineCleanup: (() => void) | undefined;

    if (!element || !media) {
      return;
    }

    element.pause();
    element.removeAttribute("src");
    element.load();

    const attachMedia = async () => {
      if (media.format === "hls") {
        if (element.canPlayType("application/vnd.apple.mpegurl")) {
          element.src = media.sourceUrl;
          element.load();
          log("ok", "HLS", "Using native HLS playback.");
          return;
        }

        const { default: Hls } = await import("hls.js");

        if (disposed) {
          return;
        }

        if (!Hls.isSupported()) {
          log("error", "HLS", "This browser cannot play HLS streams.");
          return;
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          log("ok", "HLS", "Manifest parsed and attached.");
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
          log("error", "DASH", "This browser cannot play MPEG-DASH streams.");
          return;
        }

        const player = dashjs.MediaPlayer().create();
        player.initialize(element, media.sourceUrl, false);
        log("ok", "DASH", "MPEG-DASH manifest attached.");
        engineCleanup = () => player.reset();
        return;
      }

      element.src = media.sourceUrl;
      element.load();
    };

    void attachMedia().catch((error: unknown) => {
      log("error", "MEDIA", error instanceof Error ? error.message : "Media engine failed to attach.");
    });

    return () => {
      disposed = true;
      engineCleanup?.();
      element.removeAttribute("src");
      element.load();
    };
  }, [log, media?.format, media?.id, media?.sourceUrl]);

  const handleLoadedMetadata = useCallback(async () => {
    const element = mediaRef.current;

    if (!element || !media) {
      return;
    }

    const duration = element.duration || 0;
    setMedia({ ...media, durationSecs: duration });
    setSnapshot((current) => ({ ...current, duration }));
  }, [media]);

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
        <div className="brand">
          <span className="brand__mark">
            <Radar size={24} />
          </span>
          <div>
            <strong>SyncPlayer</strong>
            <span>Command Deck</span>
          </div>
        </div>

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
                      onPause={publishSnapshot}
                      onSeeked={publishSnapshot}
                      onRateChange={publishSnapshot}
                      onTimeUpdate={publishSnapshot}
                    />
                  </div>
                ) : (
                  <video
                    ref={bindMediaElement}
                    controls
                    playsInline
                    onLoadedMetadata={handleLoadedMetadata}
                    onPlay={publishSnapshot}
                    onPause={publishSnapshot}
                    onSeeked={publishSnapshot}
                    onRateChange={publishSnapshot}
                    onTimeUpdate={publishSnapshot}
                  />
                )
              ) : (
                <div className="empty-player">
                  <ScanLine size={54} />
                  <strong>Mount media to begin</strong>
                  <span>Local files stay on this device. Peers only receive sync state.</span>
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
                Send the invite link to a viewer. They open it, SyncPlayer loads the same online URL when possible, and
                copies a response link for them to send back.
              </p>
            </div>

            {media?.origin === "local-file" ? (
              <div className="helper-copy helper-copy--warn">
                Local files are private to this device right now. The link connects playback, but the viewer still needs
                the same file until P2P file transfer is added.
              </div>
            ) : null}

            <label className="signal-box signal-box--compact">
              Invite link to send
              <input readOnly value={inviteLink} placeholder="Select media, then click Start Room & Copy Invite." />
              <button type="button" onClick={() => copyText(inviteLink)}>
                <Clipboard size={14} />
                Copy Invite Link
              </button>
            </label>

            <label className="signal-box signal-box--compact">
              Response link from viewer
              <input
                value={responseInput}
                onChange={(event) => setResponseInput(event.target.value)}
                placeholder="Paste the response link they send back."
              />
              <button type="button" onClick={() => void acceptResponseLink(responseInput)}>
                <BadgeCheck size={14} />
                Finish Connection
              </button>
            </label>

            {responseLink ? (
              <label className="signal-box signal-box--compact">
                Your response link
                <input readOnly value={responseLink} />
                <button type="button" onClick={() => copyText(responseLink)}>
                  <RotateCcw size={14} />
                  Copy Response Link
                </button>
              </label>
            ) : null}

            <button type="button" onClick={publishSnapshot}>
              <CircleDot size={15} />
              Send Current Playback State
            </button>
          </Panel>
        </aside>
      </section>

      <footer className="bottom-console">
        <Panel title="Activity Log" icon={<Activity size={15} />}>
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
