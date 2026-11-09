import { describe, expect, it } from "vitest";
import { chunkChecksum, combineChecksums, fnv1aHash, indicesToRanges, rangesInclude } from "./checksum";

const bytes = (...n: number[]) => new Uint8Array(n);

describe("checksums", () => {
  it("matches the known FNV-1a 64 value for an empty input", () => {
    expect(fnv1aHash(bytes())).toBe("cbf29ce484222325");
  });

  it("binds a chunk's checksum to its index", () => {
    expect(chunkChecksum(0, bytes(1, 2, 3))).not.toBe(chunkChecksum(1, bytes(1, 2, 3)));
  });

  it("detects a corrupted byte", () => {
    expect(chunkChecksum(4, bytes(1, 2, 3))).not.toBe(chunkChecksum(4, bytes(1, 2, 4)));
  });

  it("combineChecksums flags a missing chunk", () => {
    const full = new Map([[0, "a"], [1, "b"]]);
    const gap = new Map([[0, "a"]]);
    expect(combineChecksums(full, 2)).not.toBe(combineChecksums(gap, 2));
  });
});

describe("ranges", () => {
  it("collapses indices into sorted inclusive ranges", () => {
    expect(indicesToRanges([5, 1, 2, 3, 9, 10])).toEqual([[1, 3], [5, 5], [9, 10]]);
    expect(indicesToRanges([])).toEqual([]);
  });

  it("rangesInclude respects both bounds", () => {
    const r: Array<[number, number]> = [[2, 4]];
    expect([1, 2, 4, 5].map((i) => rangesInclude(r, i))).toEqual([false, true, true, false]);
  });
});
