export type MediaKind = "video" | "audio" | "unknown";

export type LoadedMedia = {
  id: string;
  title: string;
  sourceUrl: string;
  kind: MediaKind;
  origin: "local-file" | "remote-url";
  sizeBytes?: number;
  durationSecs?: number;
  modifiedMs?: number;
};

export function inferMediaKind(typeOrUrl: string): MediaKind {
  const value = typeOrUrl.toLowerCase();

  if (value.startsWith("audio/") || /\.(mp3|wav|aac|m4a|flac|ogg|opus)(\?|#|$)/.test(value)) {
    return "audio";
  }

  if (value.startsWith("video/") || /\.(mp4|webm|mkv|mov|m4v|ogv)(\?|#|$)/.test(value)) {
    return "video";
  }

  return "unknown";
}

