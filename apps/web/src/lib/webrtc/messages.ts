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
