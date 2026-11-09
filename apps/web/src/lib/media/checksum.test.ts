import { describe, expect, it } from "vitest";
import { chunkChecksum, combineChecksums, fnv1aHash, indicesToRanges, rangesInclude } from "./checksum";

const bytes = (...n: number[]) => new Uint8Array(n);

// The original BigInt implementation: sender and receiver must keep agreeing with it.
function referenceFnv(data: Uint8Array): string {
  let hash = 14695981039346656037n;
  for (const byte of data) {
    hash = (hash ^ BigInt(byte)) & 0xffffffffffffffffn;
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

describe("checksums", () => {
  it("matches the BigInt reference on random and edge-case inputs", () => {
    const inputs = [bytes(), bytes(0), bytes(255), new Uint8Array(1000).fill(255)];
    for (let n = 0; n < 50; n++) {
      const len = Math.floor(Math.random() * 300);
      inputs.push(Uint8Array.from({ length: len }, () => Math.floor(Math.random() * 256)));
    }
    for (const input of inputs) expect(fnv1aHash(input)).toBe(referenceFnv(input));
  });

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
