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
  Play,
  Radar,
  RadioTower,
  RotateCcw,
  ScanLine,
  Send,
  Settings,
  Shield,
  Signal,
  Terminal,
  Upload,
  Video
} from "lucide-react";
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createActivity, type ActivityEntry, type ActivityLevel } from "@/features/activity-log/activityLog";
import { usePeerRoom } from "@/features/room/usePeerRoom";
import { createMediaHint, loadSyncCore, readDrift, type DriftReading } from "@/lib/wasm/syncCore";
import { formatBytes, formatClock, formatDuration } from "@/lib/time/format";
import { inferMediaKind, type LoadedMedia } from "@/lib/media/mediaTypes";
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

export function App() {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const remoteApplyRef = useRef(false);
  const lastBroadcastRef = useRef(0);
  const [clock, setClock] = useState(formatClock());
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [hostAnswer, setHostAnswer] = useState("");
  const [guestOffer, setGuestOffer] = useState("");
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

  useEffect(() => {
    loadSyncCore()
      .then(() => {
        setWasmReady(true);
        log("ok", "WASM", "Sync core loaded.");
      })
      .catch(() => log("error", "WASM", "Sync core failed to load."));
  }, [log]);

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

    setMedia({
      id: `url:${url}`,
      title: new URL(url).pathname.split("/").pop() || "Remote stream",
      sourceUrl: url,
      kind: inferMediaKind(url),
      origin: "remote-url"
    });
    setDrift(emptyDrift);
    log("ok", "MEDIA", "Remote media URL mounted.");
  }, [log, remoteUrl]);

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
          <span>{clock}</span>
        </div>
      </header>

      <section className="deck__grid">
        <aside className="left-rail">
          <Panel title="Session" icon={<RadioTower size={15} />}>
            <div className="metrics-grid">
              <Metric label="ROLE" value={room.role.toUpperCase()} tone={room.role === "solo" ? "normal" : "ok"} />
              <Metric label="LINK" value={room.status.toUpperCase()} tone={statusTone} />
              <Metric label="LATENCY" value={`${room.latencyMs}ms`} tone={room.latencyMs < 90 ? "ok" : "warn"} />
              <Metric label="PEER" value={room.remotePeer} />
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
              <Metric label="SIZE" value={formatBytes(media?.sizeBytes || 0)} />
              <Metric label="DURATION" value={formatDuration(media?.durationSecs || snapshot.duration)} />
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
        </aside>

        <section className="main-stage">
          <Panel title="Playback Surface" icon={<Video size={15} />} className="player-panel">
            <div className="player-shell">
              {media ? (
                media.kind === "audio" ? (
                  <div className="audio-stage">
                    <AudioLines size={76} />
                    <strong>{media.title}</strong>
                    <audio
                      ref={mediaRef}
                      src={media.sourceUrl}
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
                    ref={mediaRef}
                    src={media.sourceUrl}
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

          <div className="control-strip">
            <label className="file-button">
              <Upload size={16} />
              Local File
              <input accept="audio/*,video/*" type="file" onChange={handleLocalFile} />
            </label>
            <div className="url-loader">
              <Link2 size={16} />
              <input
                value={remoteUrl}
                onChange={(event) => setRemoteUrl(event.target.value)}
                placeholder="https://example.com/media.mp4"
              />
              <button type="button" onClick={handleRemoteUrl}>
                <Send size={15} />
              </button>
            </div>
            <button type="button" onClick={publishSnapshot}>
              <CircleDot size={15} />
              Broadcast State
            </button>
          </div>
        </section>

        <aside className="right-rail">
          <Panel title="Pairing Console" icon={<Terminal size={15} />}>
            <div className="pairing-actions">
              <button type="button" onClick={room.createHostOffer}>
                <Play size={15} />
                Create Host Offer
              </button>
              <button type="button" onClick={room.closeRoom}>
                <Pause size={15} />
                Close Link
              </button>
            </div>

            <label className="signal-box">
              Host offer
              <textarea readOnly value={room.localOffer} placeholder="Create a host offer, then send this block to a guest." />
              <button type="button" onClick={() => copyText(room.localOffer)}>
                <Clipboard size={14} />
                Copy Offer
              </button>
            </label>

            <label className="signal-box">
              Guest answer for host
              <textarea
                value={hostAnswer}
                onChange={(event) => setHostAnswer(event.target.value)}
                placeholder="Host pastes the guest answer here."
              />
              <button type="button" onClick={() => void room.acceptGuestAnswer(hostAnswer)}>
                <BadgeCheck size={14} />
                Accept Answer
              </button>
            </label>

            <label className="signal-box">
              Offer received as guest
              <textarea
                value={guestOffer}
                onChange={(event) => setGuestOffer(event.target.value)}
                placeholder="Guest pastes the host offer here."
              />
              <button type="button" onClick={() => void room.joinWithOffer(guestOffer)}>
                <RotateCcw size={14} />
                Generate Answer
              </button>
            </label>

            <label className="signal-box">
              Generated guest answer
              <textarea readOnly value={room.localAnswer} placeholder="Guest sends this answer back to the host." />
              <button type="button" onClick={() => copyText(room.localAnswer)}>
                <Clipboard size={14} />
                Copy Answer
              </button>
            </label>
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

