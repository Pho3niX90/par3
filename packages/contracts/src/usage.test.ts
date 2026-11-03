import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OrchestratorMcpThreadCostInput } from "./orchestratorMcp.ts";
import { ThreadCost, ThreadCostInput, UsageReadError } from "./usage.ts";

const decodeCost = Schema.decodeUnknownSync(ThreadCost);
const decodeInput = Schema.decodeUnknownSync(ThreadCostInput);
const decodeMcpInput = Schema.decodeUnknownSync(OrchestratorMcpThreadCostInput);
const decodeReadError = Schema.decodeUnknownSync(UsageReadError);

const line = {
  provider: "claude",
  model: "claude-fable-5",
  totals: {
    uncachedInputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
  },
  costUsd: 1,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
};
const estimate = {
  threadId: "thread-1",
  readAt: "2026-08-02T00:00:00.000Z",
  totalCostUsd: 1,
  thread: { threadCount: 1, costUsd: 1, models: [line] },
  subagents: { threadCount: 0, costUsd: 0, models: [] },
  coverage: {
    complete: true,
    untrackedConversations: 0,
    conversationsWithoutUsage: 0,
    unreadableSources: 0,
    unpricedRecords: 0,
  },
  pricing: null,
};

describe("ThreadCost", () => {
  it("accepts an estimate, with or without pricing", () => {
    expect(decodeCost(estimate).thread.models).toHaveLength(1);
    const pricing = {
      status: "fresh",
      source: "https://example.test/rates.json",
      fetchedAt: null,
      knownModels: 1,
    };
    expect(decodeCost({ ...estimate, pricing }).pricing).toEqual(pricing);
  });

  it("skips a model line from a newer provider instead of failing the estimate", () => {
    const decoded = decodeCost({
      ...estimate,
      thread: {
        threadCount: 1,
        costUsd: 1,
        models: [line, { ...line, provider: "provider-from-the-future" }],
      },
    });
    expect(decoded.thread.models).toHaveLength(1);
  });

  it("rejects an estimate with no coverage or a negative count", () => {
    const { coverage: _coverage, ...withoutCoverage } = estimate;
    expect(() => decodeCost(withoutCoverage)).toThrow();
    expect(() =>
      decodeCost({ ...estimate, coverage: { ...estimate.coverage, unreadableSources: -1 } }),
    ).toThrow();
  });
});

describe("thread cost inputs", () => {
  it("accepts a thread id, and for agents an optional environment", () => {
    expect(decodeInput({ threadId: "thread-1" }).threadId).toBe("thread-1");
    expect(decodeMcpInput({ threadId: "thread-1" }).environmentId).toBeUndefined();
    expect(decodeMcpInput({ threadId: "thread-1", environmentId: "box" }).environmentId).toBe(
      "box",
    );
  });

  it("rejects a missing or blank thread id", () => {
    expect(() => decodeInput({})).toThrow();
    expect(() => decodeInput({ threadId: "" })).toThrow();
    expect(() => decodeMcpInput({})).toThrow();
  });
});

describe("UsageReadError", () => {
  it("names a missing thread", () => {
    const error = new UsageReadError({ reason: "threadNotFound", detail: "gone" });
    expect(error.message).toBe("Usage read failed (threadNotFound): gone");
  });

  it("rejects an unknown reason", () => {
    expect(() =>
      decodeReadError({
        _tag: "UsageReadError",
        reason: "nope",
        detail: "x",
      }),
    ).toThrow();
  });
});

describe("ThreadCostScope.nativeAgentCount", () => {
  it("is optional, so a client can read a server that does not send it", () => {
    expect(decodeCost(estimate).subagents.nativeAgentCount).toBeUndefined();
    expect(
      decodeCost({
        ...estimate,
        subagents: { threadCount: 0, nativeAgentCount: 2, costUsd: 0, models: [] },
      }).subagents.nativeAgentCount,
    ).toBe(2);
  });

  it("rejects a negative count", () => {
    expect(() =>
      decodeCost({
        ...estimate,
        subagents: { threadCount: 0, nativeAgentCount: -1, costUsd: 0, models: [] },
      }),
    ).toThrow();
  });
});
