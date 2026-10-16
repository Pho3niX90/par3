import { assert, describe, it } from "@effect/vitest";

import {
  bootstrapMedianDifferenceCi,
  formatDelta,
  median,
  overheadVerdict,
  percentile,
  seededRandom,
} from "./benchStats.ts";

describe("benchStats", () => {
  it("interpolates percentiles between samples", () => {
    assert.strictEqual(median([5, 1, 3]), 3);
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
    assert.closeTo(percentile([10, 20, 30, 40, 50], 95), 48, 1e-9);
    assert.isNaN(median([]));
  });

  it("repeats the same bootstrap interval for the same seed", () => {
    const random = seededRandom(7);
    const a = Array.from({ length: 10 }, () => 1000 + random() * 200);
    const b = Array.from({ length: 10 }, () => 900 + random() * 200);
    const first = bootstrapMedianDifferenceCi(a, b, { seed: 3 });
    assert.deepStrictEqual(bootstrapMedianDifferenceCi(a, b, { seed: 3 }), first);
    assert.isBelow(first.low, median(a) - median(b));
    assert.isAbove(first.high, median(a) - median(b));
  });

  it("passes a gap within the floor and fails one past 5% of wall time", () => {
    const reference = { referenceNonApiMs: [1000, 1000, 1000], referenceWallMs: [20_000] };
    assert.deepStrictEqual(
      overheadVerdict({ ...reference, candidateNonApiMs: [1250, 1300, 1200], floorMs: 300 }),
      { pass: true, gapMs: 250, allowanceMs: 1000 },
    );
    assert.isFalse(
      overheadVerdict({ ...reference, candidateNonApiMs: [2100, 2100, 2100], floorMs: 300 }).pass,
    );
  });

  it("formats signed deltas against the reference", () => {
    assert.strictEqual(formatDelta(1400, 41_600), "+1.4 s (+3.4%)");
    assert.strictEqual(formatDelta(-500, 10_000), "−0.5 s (−5.0%)");
  });
});
