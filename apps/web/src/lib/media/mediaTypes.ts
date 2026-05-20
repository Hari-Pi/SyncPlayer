export type MediaKind = "video" | "audio" | "unknown";
export type MediaFormat = "direct" | "hls" | "dash" | "unknown";

export type LoadedMedia = {
  id: string;
  title: string;
  sourceUrl: string;
  kind: MediaKind;
  format: MediaFormat;
  origin: "local-file" | "remote-url";
  sizeBytes?: number;
  durationSecs?: number;
  modifiedMs?: number;
};

export function inferMediaFormat(typeOrUrl: string): MediaFormat {
  const value = typeOrUrl.toLowerCase();

  if (value.includes("application/vnd.apple.mpegurl") || value.includes("application/x-mpegurl") || /\.m3u8(\?|#|$)/.test(value)) {
    return "hls";
  }

  if (value.includes("application/dash+xml") || /\.mpd(\?|#|$)/.test(value)) {
    return "dash";
  }

  if (
    value.startsWith("audio/") ||
    value.startsWith("video/") ||
    /\.(mp4|webm|mkv|mov|m4v|ogv|mp3|wav|aac|m4a|flac|ogg|opus)(\?|#|$)/.test(value)
  ) {
    return "direct";
  }

  return "unknown";
}

export function inferMediaKind(typeOrUrl: string): MediaKind {
  const value = typeOrUrl.toLowerCase();

  if (value.startsWith("audio/") || /\.(mp3|wav|aac|m4a|flac|ogg|opus)(\?|#|$)/.test(value)) {
    return "audio";
  }

  if (
    value.includes("mpegurl") ||
    value.includes("dash+xml") ||
    value.startsWith("video/") ||
    /\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|ogv)(\?|#|$)/.test(value)
  ) {
    return "video";
  }

  return "unknown";
}

export function mediaFormatLabel(format: MediaFormat) {
  if (format === "hls") {
    return "HLS / M3U8";
  }

  if (format === "dash") {
    return "MPEG-DASH";
  }

  if (format === "direct") {
    return "DIRECT FILE";
  }

  return "UNKNOWN";
}
