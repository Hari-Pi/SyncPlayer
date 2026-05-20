export type PlaybackSnapshot = {
  mediaId: string | null;
  position: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
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
    };

