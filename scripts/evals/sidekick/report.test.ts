import { describe, expect, it } from "vite-plus/test";

import type { TaskResult } from "./cost.ts";
import {
  aggregateByTask,
  claimText,
  compareArms,
  disagreements,
  mulberry32,
  pairTasks,
  pairedBootstrap,
  renderReport,
  type Comparison,
} from "./report.ts";

function result(
  arm: string,
  taskId: string,
  passed: boolean | null,
  costUsd: number | null,
): TaskResult {
  return {
    schemaVersion: 1,
    taskId,
    arm,
    reward: passed === null ? null : passed ? 1 : 0,
    passed,
    wallMs: 600_000,
    settled: true,
    timedOut: false,
    costUsd,
    pricesVerified: true,
    unpricedModels: [],
    byModel: [],
    tokensByRole: { lead: 0, sidekick: 0, child: 0 },
    costByRole: { lead: costUsd, sidekick: 0, child: 0 },
    leadTokenShare: null,
    sidekickTokenShare: null,
    sidekickCostShare: null,
    cacheHitRatio: null,
    turns: 1,
    incompleteUsageTurns: 0,
    turnsWithNativeSubagents: 0,
    diagnostics: {
      delegations: 0,
      freshDelegations: 0,
      continuations: 0,
      blockedReports: 0,
      failedDelegations: 0,
      leadTakeovers: 0,
    },
    protectedFilesChanged: [],
  };
}

describe("bootstrap", () => {
  it("is deterministic for a seed and changes with the seed", () => {
    const first = mulberry32(42);
    const second = mulberry32(42);
    const sequence = Array.from({ length: 5 }, () => first());
    expect(Array.from({ length: 5 }, () => second())).toEqual(sequence);
    expect(sequence.every((value) => value >= 0 && value < 1)).toBe(true);

    const data = [0, 1, 1, 0, 1, 1, 1, 0, 1, 0];
    const meanOf = (sample: ReadonlyArray<number>) =>
      sample.reduce((s, v) => s + v, 0) / sample.length;
    const a = pairedBootstrap(data, meanOf, { seed: 7, iterations: 2000 });
    const b = pairedBootstrap(data, meanOf, { seed: 7, iterations: 2000 });
    const c = pairedBootstrap(data, meanOf, { seed: 8, iterations: 2000 });
    expect(a).toEqual(b);
    expect(mulberry32(8)()).not.toBe(mulberry32(7)());
    // Binary data puts percentiles on a coarse grid, so another seed lands close, not identical.
    expect(Math.abs(c.low - a.low)).toBeLessThanOrEqual(0.1);
    expect(a.estimate).toBeCloseTo(0.6);
    expect(a.low).toBeLessThan(0.6);
    expect(a.high).toBeGreaterThan(0.6);
  });

  it("collapses to a point when every task is identical", () => {
    const interval = pairedBootstrap([1, 1, 1], (s) => s.length, { iterations: 100 });
    expect(interval).toEqual({ estimate: 3, low: 3, high: 3 });
  });
});

describe("aggregation and pairing", () => {
  it("averages re-runs per task and pairs tasks present in both arms", () => {
    const a = aggregateByTask([
      result("A", "t1", true, 10),
      result("A", "t1", false, 14),
      result("A", "t2", true, 8),
    ]);
    const b = aggregateByTask([result("B", "t1", true, 4), result("B", "t3", false, 2)]);
    expect(a.get("t1")).toMatchObject({ attempts: 2, passRate: 0.5, costUsd: 12 });
    const { pairs, onlyA, onlyB } = pairTasks(a, b);
    expect(pairs.map((pair) => pair.taskId)).toEqual(["t1"]);
    expect(onlyA).toEqual(["t2"]);
    expect(onlyB).toEqual(["t3"]);
  });

  it("treats a task with any unpriced attempt as unpriced", () => {
    expect(
      aggregateByTask([result("A", "t1", true, 3), result("A", "t1", true, null)]).get("t1")
        ?.costUsd,
    ).toBeNull();
  });

  it("lists tasks where the arms disagree", () => {
    const a = aggregateByTask([result("A", "t1", true, 1), result("A", "t2", false, 1)]);
    const b = aggregateByTask([result("B", "t1", false, 1), result("B", "t2", false, 1)]);
    expect(disagreements(pairTasks(a, b).pairs)).toEqual(["t1"]);
  });
});

describe("comparison and claim", () => {
  const tasks = Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(2, "0")}`);

  it("computes paired pass-rate difference and cost change", () => {
    const a = tasks.map((task, i) => result("A", task, i % 2 === 0, 10));
    const b = tasks.map((task, i) => result("B", task, i % 2 === 0, 6));
    const comparison = compareArms(pairTasks(aggregateByTask(a), aggregateByTask(b)).pairs, {
      seed: 3,
      iterations: 500,
    });
    expect(comparison.passDiff).toEqual({ estimate: 0, low: 0, high: 0 });
    expect(comparison.costChange?.estimate).toBeCloseTo(-0.4);
    expect(claimText(comparison, false)).toMatch(/^Equal or better at 40% lower cost/);
  });

  it("refuses a cost claim when B is significantly worse", () => {
    const comparison: Comparison = {
      gradedPairs: 66,
      passA: { estimate: 0.66, low: 0.55, high: 0.77 },
      passB: { estimate: 0.5, low: 0.4, high: 0.6 },
      passDiff: { estimate: -0.16, low: -0.25, high: -0.05 },
      pricedPairs: 66,
      costChange: { estimate: -0.5, low: -0.6, high: -0.4 },
    };
    expect(claimText(comparison, false)).toMatch(/significantly lower.*No cost claim/);
  });

  it("caveats an interval that still allows a drop, and marks provisional prices", () => {
    const comparison: Comparison = {
      gradedPairs: 66,
      passA: { estimate: 0.66, low: 0.55, high: 0.77 },
      passB: { estimate: 0.64, low: 0.53, high: 0.75 },
      passDiff: { estimate: -0.02, low: -0.09, high: 0.05 },
      pricedPairs: 66,
      costChange: { estimate: -0.3, low: -0.4, high: -0.2 },
    };
    const text = claimText(comparison, true);
    expect(text).toMatch(/^PROVISIONAL/);
    expect(text).toContain("30% lower cost");
    expect(text).toContain("not proven equal");
  });

  it("makes no cost claim when Sidekick is not cheaper", () => {
    const comparison: Comparison = {
      gradedPairs: 10,
      passA: { estimate: 0.5, low: 0.3, high: 0.7 },
      passB: { estimate: 0.5, low: 0.3, high: 0.7 },
      passDiff: { estimate: 0, low: -0.1, high: 0.1 },
      pricedPairs: 10,
      costChange: { estimate: 0.1, low: 0, high: 0.2 },
    };
    expect(claimText(comparison, false)).toMatch(/not cheaper/);
  });
});

describe("renderReport", () => {
  it("renders arms, reference rows and flags", () => {
    const flagged = {
      ...result("B", "t1", true, 2),
      protectedFilesChanged: ["tests/test_outputs.py"],
    };
    const markdown = renderReport({
      a: [result("A", "t1", true, 4), result("A", "t2", false, 4)],
      b: [flagged, result("B", "t2", true, 2)],
      bootstrap: { seed: 1, iterations: 200 },
    });
    expect(markdown).toContain("| A: Par3 solo | 2 | 2 |");
    expect(markdown).toContain("AA Coding Agent Index");
    expect(markdown).toContain("B t1: changed tests/test_outputs.py");
    expect(markdown).toContain("re-run before scoring: t2");
    expect(markdown).toContain("**Claim:** PROVISIONAL");
  });

  it.each([{ settled: false }, { timedOut: true }, { turns: 0 }, { turnsWithNativeSubagents: 1 }])(
    "marks incomplete or unpriced execution provisional: %o",
    (execution) => {
      const markdown = renderReport({
        a: [result("A", "t1", true, 4)],
        b: [{ ...result("B", "t1", true, 2), ...execution }],
        bootstrap: { seed: 1, iterations: 100 },
      });
      expect(markdown).toContain("**Claim:** PROVISIONAL");
    },
  );
});
