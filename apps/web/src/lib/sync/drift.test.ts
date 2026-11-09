import { describe, expect, it } from "vitest";
import { predictSeekTarget, readDrift, SEEK_COST_MAX_SECS, updateSeekCost } from "./drift";

describe("readDrift", () => {
  it("holds inside the dead zone", () => {
    expect(readDrift(0.02, 1, 10)).toMatchObject({ mode: "hold", rate: 1 });
  });

  it("slows down softly when ahead of the host", () => {
    const r = readDrift(0.1, 1, 10); // +100 ms = we are ahead
    expect(r.mode).toBe("soft");
    expect(r.rate).toBeCloseTo(0.95);
  });

  it("speeds up firmly when well behind with a healthy buffer", () => {
    const r = readDrift(-0.3, 1, 10);
    expect(r.mode).toBe("firm");
    expect(r.rate).toBeCloseTo(1.1);
  });

  it("holds instead of speeding up when the buffer is thin", () => {
    expect(readDrift(-0.1, 1, 0.5).mode).toBe("hold");
    expect(readDrift(-0.3, 1, 0.5).mode).toBe("hold");
  });

  it("still seeks on large drift even with a thin buffer", () => {
    expect(readDrift(-0.8, 1, 0.5).mode).toBe("seek");
    expect(readDrift(0.8, 1, 10)).toMatchObject({ mode: "seek", rate: 1 });
  });

  it("scales the correction by the host rate", () => {
    expect(readDrift(0.1, 2, 10).rate).toBeCloseTo(1.9);
  });
});

describe("predictive seeking", () => {
  it("aims ahead by the expected seek time while the host plays", () => {
    expect(predictSeekTarget(60, 1, false, 0.8)).toBeCloseTo(60.8);
    expect(predictSeekTarget(60, 2, false, 0.5)).toBeCloseTo(61);
  });

  it("seeks exactly when the host is paused", () => {
    expect(predictSeekTarget(60, 1, true, 0.8)).toBe(60);
  });

  it("smooths measurements and caps outliers", () => {
    expect(updateSeekCost(0.3, 1.3)).toBeCloseTo(0.8);
    expect(updateSeekCost(0.3, 60)).toBeCloseTo((0.3 + SEEK_COST_MAX_SECS) / 2);
    expect(updateSeekCost(0.3, -1)).toBeCloseTo(0.15);
  });
});
