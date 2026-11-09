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
export const PROTOCOL_VERSION = 2;

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

// ─── Wire encoding ─────────────────────────────────────────────────────────────
// Connections use PeerJS "raw" serialization, so we frame messages ourselves. PeerJS's default
// encoder packs every message and splits anything over 16 KB into pieces; a 64 KiB file chunk
// became ~5 messages. Raw sends one message per chunk.
//   control messages: JSON text
//   file.chunk:       binary frame  [1][u32 index][u32 total][u8 idLen][mediaId][16B checksum][data]

const FRAME_CHUNK = 1;
const CHECKSUM_LEN = 16;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeWire(message: WireMessage): string | ArrayBuffer {
  if (message.type !== "file.chunk") return JSON.stringify(message);

  const { mediaId, index, total, data, checksum } = message.payload;
  const id = textEncoder.encode(mediaId);
  if (id.length > 255 || checksum.length !== CHECKSUM_LEN) throw new Error("file.chunk header out of range");
  const header = 1 + 4 + 4 + 1 + id.length + CHECKSUM_LEN;
  const frame = new Uint8Array(header + data.length);
  const view = new DataView(frame.buffer);
  frame[0] = FRAME_CHUNK;
  view.setUint32(1, index);
  view.setUint32(5, total);
  frame[9] = id.length;
  frame.set(id, 10);
  frame.set(textEncoder.encode(checksum), 10 + id.length);
  frame.set(data, header);
  return frame.buffer;
}

/** Inverse of encodeWire; returns null for anything that isn't one of our frames. */
export function decodeWire(raw: unknown): unknown {
  try {
    if (typeof raw === "string") return JSON.parse(raw);
    const buffer = raw instanceof ArrayBuffer ? raw : ArrayBuffer.isView(raw) ? raw.buffer : null;
    if (!buffer) return null;
    const bytes = new Uint8Array(buffer, ArrayBuffer.isView(raw) ? raw.byteOffset : 0, ArrayBuffer.isView(raw) ? raw.byteLength : undefined);
    if (bytes[0] !== FRAME_CHUNK || bytes.length < 10) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const idLen = bytes[9];
    const header = 10 + idLen + CHECKSUM_LEN;
    if (bytes.length < header) return null;
    return {
      id: "",
      type: "file.chunk",
      sentAt: 0,
      payload: {
        mediaId: textDecoder.decode(bytes.subarray(10, 10 + idLen)),
        index: view.getUint32(1),
        total: view.getUint32(5),
        checksum: textDecoder.decode(bytes.subarray(10 + idLen, header)),
        data: bytes.subarray(header)
      }
    };
  } catch {
    return null;
  }
}
