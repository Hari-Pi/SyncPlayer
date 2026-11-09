import { describe, expect, it } from "vitest";
import { isWireMessage } from "./messages";

const msg = (type: string, payload: unknown) => ({ id: "1", type, sentAt: 0, payload });

describe("isWireMessage", () => {
  it("rejects non-objects, unknown types and missing payloads", () => {
    expect(isWireMessage(null)).toBe(false);
    expect(isWireMessage("hi")).toBe(false);
    expect(isWireMessage(msg("nope", {}))).toBe(false);
    expect(isWireMessage({ type: "room.hello" })).toBe(false);
  });

  it("accepts a well-formed chunk and rejects a malformed one", () => {
    const ok = { mediaId: "m", index: 3, total: 9, data: new Uint8Array(4), checksum: "ab" };
    expect(isWireMessage(msg("file.chunk", ok))).toBe(true);
    expect(isWireMessage(msg("file.chunk", { ...ok, data: "text" }))).toBe(false);
    expect(isWireMessage(msg("file.chunk", { ...ok, index: 1.5 }))).toBe(false);
  });

  it("validates playback state and guest actions", () => {
    expect(isWireMessage(msg("playback.state", { position: 1, paused: false, playbackRate: 1 }))).toBe(true);
    expect(isWireMessage(msg("playback.state", { position: "1" }))).toBe(false);
    expect(isWireMessage(msg("playback.guestAction", { action: "explode", snapshot: {} }))).toBe(false);
  });
});
