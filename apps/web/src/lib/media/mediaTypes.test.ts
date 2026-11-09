import { describe, expect, it } from "vitest";
import { inferMediaFormat, inferMediaKind } from "./mediaTypes";

describe("media inference", () => {
  it("detects HLS and DASH by mime or extension, ignoring query strings", () => {
    expect(inferMediaFormat("https://x.test/a.m3u8?token=1")).toBe("hls");
    expect(inferMediaFormat("application/dash+xml")).toBe("dash");
  });

  it("treats common containers as direct files", () => {
    expect(inferMediaFormat("video/mp4")).toBe("direct");
    expect(inferMediaFormat("movie.MKV")).toBe("direct");
    expect(inferMediaFormat("notes.txt")).toBe("unknown");
  });

  it("splits audio from video", () => {
    expect(inferMediaKind("song.flac")).toBe("audio");
    expect(inferMediaKind("clip.mp4")).toBe("video");
    expect(inferMediaKind("stream.m3u8")).toBe("video");
  });
});
