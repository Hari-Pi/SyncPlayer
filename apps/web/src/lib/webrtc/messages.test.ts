import { describe, expect, it } from "vitest";
import { decodeWire, encodeWire, isWireMessage, type WireMessage } from "./messages";

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

describe("wire encoding", () => {
  it("round-trips a file chunk through the binary frame", () => {
    const data = Uint8Array.from({ length: 65536 }, (_, i) => i % 251);
    const message = { id: "x", type: "file.chunk", sentAt: 0, payload: { mediaId: "media-é1", index: 2501, total: 2502, data, checksum: "0123456789abcdef" } } as WireMessage;
    const frame = encodeWire(message);
    expect(frame).toBeInstanceOf(ArrayBuffer);
    const back = decodeWire(frame) as typeof message & { payload: { data: Uint8Array } };
    expect(isWireMessage(back)).toBe(true);
    expect(back.payload).toMatchObject({ mediaId: "media-é1", index: 2501, total: 2502, checksum: "0123456789abcdef" });
    expect(Array.from(back.payload.data)).toEqual(Array.from(data));
  });

  it("round-trips control messages as JSON and rejects garbage", () => {
    const ping = { id: "1", type: "clock.ping", sentAt: 5, payload: { pingId: "p", originAt: 1 } } as WireMessage;
    expect(decodeWire(encodeWire(ping))).toEqual(ping);
    expect(decodeWire(new Uint8Array([9, 9, 9]).buffer)).toBeNull();
    expect(decodeWire("{nope")).toBeNull();
    expect(decodeWire(42)).toBeNull();
  });
});
