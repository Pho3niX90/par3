import { describe, expect, it } from "vite-plus/test";

import { priceKey, priceTotals, rollupByModel, summarizeTask, type PriceTable } from "./cost.ts";
import {
  extractTurnUsage,
  isThreadSettled,
  slimProjection,
  type ExportedThread,
  type Par3TaskExport,
} from "./usage.ts";

const OPUS = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "max" }],
};
const LUNA = {
  instanceId: "codex",
  model: "gpt-6-luna",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const PRICES: PriceTable = {
  models: {
    "claude-opus-5-5": { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20, reasoning: null },
    "gpt-6-luna": {
      input: 0.1,
      cachedInput: 0.01,
      cacheWrite: 0.125,
      output: 0.5,
      reasoning: null,
      verify: true,
    },
  },
};

function thread(
  overrides: Partial<ExportedThread> & Pick<ExportedThread, "threadId">,
): ExportedThread {
  return {
    parentThreadId: null,
    relationshipToParent: null,
    modelSelection: OPUS,
    sidekickModelSelection: null,
    runs: [],
    attempts: [],
    providerTurns: [],
    subagents: [],
    fileChangeRunIds: [],
    ...overrides,
  };
}

const usage = (input: number, cached: number, written: number, output: number, reasoning = 0) => ({
  usageScope: "main_agent",
  usageStatus: "complete" as const,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheCreationTokens: written,
  outputTokens: output,
  reasoningTokens: reasoning,
  hasSubagents: false,
});

const lead = thread({
  threadId: "lead",
  sidekickModelSelection: LUNA,
  runs: [
    {
      id: "r1",
      ordinal: 1,
      status: "completed",
      modelSelection: OPUS,
      startedAt: "2026-10-20T10:00:00Z",
      completedAt: "2026-10-20T10:05:00Z",
    },
    {
      id: "r2",
      ordinal: 2,
      status: "completed",
      modelSelection: OPUS,
      startedAt: "2026-10-20T10:20:00Z",
      completedAt: "2026-10-20T10:30:00Z",
    },
  ],
  attempts: [
    { id: "a1", runId: "r1" },
    { id: "a2", runId: "r2" },
  ],
  providerTurns: [
    {
      id: "t1",
      runAttemptId: "a1",
      status: "completed",
      startedAt: null,
      completedAt: null,
      turnTokenUsage: usage(1_000_000, 600_000, 100_000, 50_000),
    },
    {
      id: "t2",
      runAttemptId: "a2",
      status: "completed",
      startedAt: null,
      completedAt: null,
      turnTokenUsage: usage(200_000, 200_000, 0, 10_000),
    },
  ],
  subagents: [
    {
      id: "n1",
      origin: "app_owned",
      childThreadId: "child",
      status: "completed",
      result: "Status: done",
      model: "gpt-6-luna",
      startedAt: null,
      completedAt: "2026-10-20T10:10:00Z",
    },
    {
      id: "n2",
      origin: "app_owned",
      childThreadId: "child",
      status: "completed",
      result: "Status: blocked\nChanged: nothing",
      model: "gpt-6-luna",
      startedAt: null,
      completedAt: "2026-10-20T10:15:00Z",
    },
    {
      id: "n3",
      origin: "provider_native",
      childThreadId: null,
      status: "completed",
      result: null,
      model: null,
      startedAt: null,
      completedAt: null,
    },
  ],
  fileChangeRunIds: ["r2"],
});

const child = thread({
  threadId: "child",
  parentThreadId: "lead",
  relationshipToParent: "subagent",
  modelSelection: LUNA,
  runs: [
    {
      id: "c1",
      ordinal: 1,
      status: "completed",
      modelSelection: LUNA,
      startedAt: null,
      completedAt: null,
      delegatedTaskId: "n1",
    },
  ],
  attempts: [{ id: "ca1", runId: "c1" }],
  providerTurns: [
    {
      id: "ct1",
      runAttemptId: "ca1",
      status: "completed",
      startedAt: null,
      completedAt: null,
      turnTokenUsage: usage(2_000_000, 1_500_000, 0, 100_000, 40_000),
    },
    { id: "ct2", runAttemptId: null, status: "failed", startedAt: null, completedAt: null },
  ],
});

const taskExport: Par3TaskExport = {
  schemaVersion: 1,
  taskId: "fix-git",
  arm: "B",
  startedAt: "2026-10-20T10:00:00Z",
  finishedAt: "2026-10-20T10:30:00Z",
  settled: true,
  timedOut: false,
  leadThreadId: "lead",
  threads: [lead, child],
  protectedFilesChanged: [],
};

describe("pricing", () => {
  it("prices uncached input, cache reads, cache writes and output separately", () => {
    const cost = priceTotals(
      {
        uncachedInputTokens: 300_000,
        cacheReadTokens: 600_000,
        cacheWriteTokens: 100_000,
        outputTokens: 50_000,
        reasoningTokens: 0,
      },
      PRICES.models["claude-opus-5-5"]!,
    );
    expect(cost.input).toBeCloseTo(1.2);
    expect(cost.cacheRead).toBeCloseTo(0.12);
    expect(cost.cacheWrite).toBeCloseTo(0.5);
    expect(cost.output).toBeCloseTo(1.0);
    expect(cost.total).toBeCloseTo(2.82);
  });

  it("re-rates reasoning only when the model prices it apart from output", () => {
    const totals = {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 400_000,
    };
    expect(
      priceTotals(totals, { input: 0, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: null })
        .output,
    ).toBeCloseTo(10);
    expect(
      priceTotals(totals, { input: 0, cachedInput: 0, cacheWrite: 0, output: 10, reasoning: 20 })
        .output,
    ).toBeCloseTo(14);
  });

  it("drops the long-context variant suffix when looking up a price", () => {
    expect(priceKey(" Claude-Opus-5-5[1m] ")).toBe("claude-opus-5-5");
  });
});

describe("rollup", () => {
  it("attributes each turn to its run's model and role, and derives uncached input", () => {
    const records = extractTurnUsage(taskExport);
    expect(records.map((r) => [r.providerTurnId, r.role, r.model])).toEqual([
      ["t1", "lead", "claude-opus-5-5"],
      ["t2", "lead", "claude-opus-5-5"],
      ["ct1", "sidekick", "gpt-6-luna"],
      ["ct2", "sidekick", "gpt-6-luna"],
    ]);
    expect(records[0]).toMatchObject({
      uncachedInputTokens: 300_000,
      cacheReadTokens: 600_000,
      cacheWriteTokens: 100_000,
    });
    expect(records[3]?.usageStatus).toBe("missing");
  });

  it("sums tokens per model across the lead and child threads", () => {
    const rows = rollupByModel(extractTurnUsage(taskExport), PRICES);
    const opus = rows.find((row) => row.model === "claude-opus-5-5");
    const luna = rows.find((row) => row.model === "gpt-6-luna");
    expect(opus?.tokens).toEqual({
      uncachedInputTokens: 300_000,
      cacheReadTokens: 800_000,
      cacheWriteTokens: 100_000,
      outputTokens: 60_000,
      reasoningTokens: 0,
    });
    expect(opus?.optionSets).toEqual(["effort=max"]);
    expect(luna?.incompleteTurns).toBe(1);
    expect(luna?.priceVerified).toBe(false);
  });
});

describe("summarizeTask", () => {
  it("reports cost, shares, cache hit ratio and delegation diagnostics", () => {
    const result = summarizeTask(taskExport, PRICES, 1);
    // Opus: 300k*4 + 800k*0.2 + 100k*5 + 60k*20 per 1M = 1.2 + 0.16 + 0.5 + 1.2 = 3.06
    // Luna: 500k*0.1 + 1.5M*0.01 + 100k*0.5 per 1M = 0.05 + 0.015 + 0.05 = 0.115
    expect(result.costUsd).toBeCloseTo(3.175);
    expect(result.costByRole.sidekick).toBeCloseTo(0.115);
    expect(result.passed).toBe(true);
    expect(result.wallMs).toBe(30 * 60_000);
    expect(result.pricesVerified).toBe(false);
    expect(result.tokensByRole).toEqual({ lead: 1_260_000, sidekick: 2_100_000, child: 0 });
    expect(result.cacheHitRatio).toBeCloseTo(2_300_000 / 3_200_000);
    expect(result.diagnostics).toEqual({
      delegations: 2,
      freshDelegations: 1,
      continuations: 1,
      blockedReports: 1,
      failedDelegations: 0,
      leadTakeovers: 1,
    });
  });

  it("leaves total cost null when a used model has no price", () => {
    const result = summarizeTask(
      taskExport,
      { models: { "claude-opus-5-5": PRICES.models["claude-opus-5-5"]! } },
      null,
    );
    expect(result.costUsd).toBeNull();
    expect(result.unpricedModels).toEqual(["gpt-6-luna"]);
    expect(result.passed).toBeNull();
  });
});

describe("projection helpers", () => {
  it("slims a wire projection and finds file-changing runs", () => {
    const slim = slimProjection({
      thread: {
        id: "lead",
        modelSelection: OPUS,
        sidekickModelSelection: LUNA,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "lead" },
      },
      runs: [
        {
          id: "r1",
          ordinal: 1,
          status: "running",
          modelSelection: OPUS,
          startedAt: "x",
          completedAt: null,
        },
      ],
      attempts: [{ id: "a1", runId: "r1", status: "running" }],
      providerTurns: [
        { id: "t1", runAttemptId: "a1", status: "running", startedAt: null, completedAt: null },
      ],
      subagents: [],
      turnItems: [
        { type: "file_change", runId: "r1", fileName: "a.py" },
        { type: "assistant_message", runId: "r1" },
      ],
      messages: [{ text: "not exported" }],
    });
    expect(slim.sidekickModelSelection).toEqual(LUNA);
    expect(slim.fileChangeRunIds).toEqual(["r1"]);
    expect(isThreadSettled(slim)).toBe(false);
    expect(isThreadSettled(lead)).toBe(true);
  });
});
