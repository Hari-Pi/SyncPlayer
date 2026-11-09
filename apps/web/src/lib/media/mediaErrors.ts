/** Human-readable explanation for the standard HTMLMediaElement error codes. */
export function describeMediaErrorCode(code: number): string {
  switch (code) {
    case 1:
      return "Loading was aborted.";
    case 2:
      return "A network error interrupted the download.";
    case 3:
      return "The media could not be decoded — the file may be corrupt or use an unsupported codec.";
    case 4:
      return "This source isn't a supported media format, the URL is invalid, or the server refused the request.";
    default:
      return "Unknown media error.";
  }
}

// readyState 0 (HAVE_NOTHING) + networkState 3 (NETWORK_NO_SOURCE) + no
// MediaError object means the browser never got usable media data at all —
// not a decode/format problem. In practice this is almost always the remote
// server refusing the request outright, most commonly hotlink/Referer
// protection (very common on streaming and file-lock CDNs, which only allow
// their own site to embed the link), a link that requires a login/session
// cookie, or an expired one-time URL. It's a restriction on the source's
// side — no amount of client-side retrying gets around it.
export const LOCAL_FILE_UNPLAYABLE_HINT =
  "This browser can't play this file. It may be damaged, or use a format the browser doesn't support (MKV, AVI and HEVC/H.265 video often aren't). Converting it to MP4 (H.264 video, AAC audio) usually fixes it.";

export const NO_SOURCE_HINT =
  "No data was received from the server at all. This is almost always the server refusing the request — common causes are " +
  "hotlink/Referer protection (many streaming and file-lock CDNs only allow their own site to embed the link), a link that " +
  "requires a login/session, or an expired one-time URL. This is a restriction on the source's side, not something SyncPlayer " +
  "can bypass. Try downloading the file and using \"Select File\" instead, or use a direct link from a host that allows embedding.";
