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
  /** true = full blob transfer (MKV etc.), false = MSE progressive stream */
  isBlob: boolean;
  totalChunks: number;
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
        /** Uint8Array serialised as number[] for JSON transport */
        data: number[];
        checksum: string;
      };
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
      type: "file.progress";
      sentAt: number;
      payload: {
        mediaId: string;
        chunksReceived: number;
        total: number;
      };
    };
