import type { LoadedMedia } from "@/lib/media/mediaTypes";

export type ShareMedia = Pick<LoadedMedia, "id" | "title" | "sourceUrl" | "kind" | "format" | "origin">;
export type ShareRtcConfig = Pick<RTCConfiguration, "iceServers" | "iceTransportPolicy">;
export type SharePayload =
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

export function createShareUrl(payload: SharePayload) {
  return `${window.location.origin}${window.location.pathname}#sync=${encodeSharePayload(payload)}`;
}

export function readSharePayloadFromUrl() {
  if (!window.location.hash.startsWith("#sync=")) {
    return null;
  }

  return decodeSharePayload(window.location.hash);
}

export function readStoredRtcConfig(): ShareRtcConfig | null {
  try {
    const stored = localStorage.getItem("syncplayer:rtcconfig");
    return stored ? JSON.parse(stored) as ShareRtcConfig : null;
  } catch {
    return null;
  }
}

export function writeStoredRtcConfig(config: ShareRtcConfig | null) {
  if (!config) {
    localStorage.removeItem("syncplayer:rtcconfig");
    return;
  }

  localStorage.setItem("syncplayer:rtcconfig", JSON.stringify(config));
}


/**
 * The ICE config that goes into an invite link. Links get pasted into chats and kept in browser
 * history, so relay usernames/passwords are left out unless the host opts in
 * (localStorage "syncplayer:sharecredentials" = "true"). Viewers then use the app defaults for relay.
 */
export function shareableRtcConfig(): ShareRtcConfig | null {
  const config = readStoredRtcConfig();
  if (!config) return null;

  let optedIn = false;
  try {
    optedIn = localStorage.getItem("syncplayer:sharecredentials") === "true";
  } catch { /* storage unavailable */ }
  if (optedIn) return config;

  const iceServers = (config.iceServers ?? []).filter((server) => !server.username && !server.credential);
  if (iceServers.length === 0 && config.iceTransportPolicy === undefined) return null;
  return { ...config, iceServers };
}
