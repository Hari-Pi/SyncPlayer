import type { MediaFormat, MediaKind } from "../media/mediaTypes";

export type PlaybackSnapshot = {
  mediaId: string | null;
  position: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
};

export type FileMeta = {
  mediaId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  format: MediaFormat;
  /** true = full blob transfer (MKV etc.), false = MSE progressive stream */
  isBlob: boolean;
  totalChunks: number;
};

export const CHUNK_SIZE = 64 * 1024;

/** Bump when the wire format changes incompatibly; peers on different versions refuse to pair. */
export const PROTOCOL_VERSION = 1;

export type PlaybackConfig = {
  subtitleTrack: number; // -1 = off, 0+ = embedded track index
  qualityLevel: number;  // -1 = auto ABR, 0+ = level/representation index
};

export type RemoteMediaMount = {
  id: string;
  title: string;
  sourceUrl: string;
  kind: MediaKind;
  format: MediaFormat;
  origin: "remote-url";
};

export type WireMessage =
  | {
      id: string;
      type: "room.hello";
      sentAt: number;
      payload: {
        peerId: string;
        label: string;
        /** Absent on builds that predate versioning. */
        version?: number;
      };
    }
  | {
      id: string;
      type: "room.joinDeclined";
      sentAt: number;
      payload: {
        reason?: string;
      };
    }
  | {
      id: string;
      type: "playback.state";
      sentAt: number;
      payload: PlaybackSnapshot;
    }
  | {
      id: string;
      type: "clock.ping" | "clock.pong";
      sentAt: number;
      payload: {
        pingId: string;
        originAt: number;
      };
    }
  | {
      id: string;
      type: "file.meta";
      sentAt: number;
      payload: FileMeta;
    }
  | {
      id: string;
      type: "file.chunk";
      sentAt: number;
      payload: {
        mediaId: string;
        index: number;
        total: number;
        data: Uint8Array;
        checksum: string;
      };
    }
  | {
      id: string;
      type: "media.mount";
      sentAt: number;
      payload: RemoteMediaMount;
    }
  | {
      id: string;
      type: "file.end";
      sentAt: number;
      payload: {
        mediaId: string;
        checksum: string;
      };
    }
  | {
      id: string;
      type: "file.resume";
      sentAt: number;
      payload: {
        mediaId: string;
        /** Sorted, non-overlapping inclusive [start, end] chunk-index ranges already received. Empty for a fresh transfer. */
        receivedRanges: Array<[number, number]>;
      };
    }
  | {
      id: string;
      type: "file.progress";
      sentAt: number;
      payload: {
        mediaId: string;
        chunksReceived: number;
        total: number;
      };
    }
  | {
      id: string;
      type: "file.aborted";
      sentAt: number;
      /** host→guest: the send pipeline died. guest→host: the receive pipeline died (e.g. disk write failed). */
      payload: {
        mediaId: string;
        reason?: string;
      };
    }
  | {
      id: string;
      type: "file.retry";
      sentAt: number;
      /** guest→host: some received chunks failed verification; please re-send what's missing (file.resume tells which). */
      payload: {
        mediaId: string;
      };
    }
  | {
      id: string;
      type: "config.request";
      sentAt: number;
      payload: Record<string, never>;
    }
  | {
      id: string;
      type: "config.state";
      sentAt: number;
      payload: PlaybackConfig;
    }
  | {
      id: string;
      type: "config.changed";
      sentAt: number;
      payload: Record<string, never>;
    }
  | {
      id: string;
      type: "sync.health";
      sentAt: number;
      payload: {
        /** true if the reporting peer's media element is currently starved for data. */
        stalled: boolean;
        /** seconds of buffered media ahead of the reporting peer's current playback position. */
        bufferedAheadSecs: number;
      };
    }
  | {
      id: string;
      type: "playback.guestAction";
      sentAt: number;
      payload: {
        /** A viewer-initiated control action, reverse-synced to the host (rate-limited). */
        action: "pause" | "resume" | "seek";
        snapshot: PlaybackSnapshot;
      };
    };

export type GuestPlaybackAction = "pause" | "resume" | "seek";

const KNOWN_TYPES = new Set<string>([
  "room.hello", "room.joinDeclined", "playback.state", "clock.ping", "clock.pong",
  "file.meta", "file.chunk", "media.mount", "file.end", "file.resume", "file.progress",
  "file.aborted", "file.retry", "config.request", "config.state", "config.changed",
  "sync.health", "playback.guestAction"
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Structural check on data arriving off the wire, before any handler touches it. */
export function isWireMessage(value: unknown): value is WireMessage {
  if (!isObj(value) || typeof value.type !== "string" || !KNOWN_TYPES.has(value.type) || !isObj(value.payload)) {
    return false;
  }
  const p = value.payload;
  switch (value.type) {
    case "file.chunk":
      return typeof p.mediaId === "string" && Number.isInteger(p.index) && typeof p.total === "number" &&
        (p.data instanceof Uint8Array || p.data instanceof ArrayBuffer) && typeof p.checksum === "string";
    case "file.meta":
      return typeof p.mediaId === "string" && typeof p.fileName === "string" &&
        typeof p.fileSize === "number" && Number.isInteger(p.totalChunks) && (p.totalChunks as number) >= 0;
    case "file.end": case "file.aborted": case "file.retry": case "file.progress": case "file.resume":
      return typeof p.mediaId === "string" && (value.type !== "file.resume" || Array.isArray(p.receivedRanges));
    case "playback.state":
      return typeof p.position === "number" && typeof p.paused === "boolean" && typeof p.playbackRate === "number";
    case "playback.guestAction":
      return (p.action === "pause" || p.action === "resume" || p.action === "seek") && isObj(p.snapshot);
    case "clock.ping": case "clock.pong":
      return typeof p.pingId === "string";
    case "sync.health":
      return typeof p.stalled === "boolean";
    case "media.mount":
      return typeof p.sourceUrl === "string";
    default:
      return true;
  }
}
