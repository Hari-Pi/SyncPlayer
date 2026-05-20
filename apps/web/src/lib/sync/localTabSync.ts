import type { PlaybackSnapshot } from "@/lib/webrtc/messages";

export type LocalTabMessage =
  | {
      type: "hello";
      peerId: string;
      sentAt: number;
    }
  | {
      type: "playback";
      peerId: string;
      sentAt: number;
      payload: PlaybackSnapshot;
    };
type LocalTabPostMessage = { type: "hello" } | { type: "playback"; payload: PlaybackSnapshot };

export function createLocalTabChannel(onMessage: (message: LocalTabMessage) => void) {
  if (!("BroadcastChannel" in window)) {
    return null;
  }

  const peerId = `TAB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const channel = new BroadcastChannel("syncplayer-local-tabs");

  channel.onmessage = (event: MessageEvent<LocalTabMessage>) => {
    if (event.data.peerId === peerId) {
      return;
    }

    onMessage(event.data);
  };

  return {
    peerId,
    post(message: LocalTabPostMessage) {
      channel.postMessage({
        ...message,
        peerId,
        sentAt: performance.now()
      });
    },
    close() {
      channel.close();
    }
  };
}
