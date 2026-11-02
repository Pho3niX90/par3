// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";
import {
  ThreadId,
  type ThreadCost,
  type ThreadCostLine,
  type UsageSource,
} from "@t3tools/contracts";

import {
  describeThreadCost,
  formatHourShort,
  formatTokens,
  makeWindow,
  usageSourceMessages,
} from "./usageFormat.ts";

function malformedSource(count: number, overrides: Partial<UsageSource> = {}): UsageSource {
  return {
    fingerprint: {
      hostId: "demo-host",
      provider: "codex",
      resolvedHomePath: "/demo/codex",
      volumeId: "demo-volume",
    },
    status: "partial",
    scannedFiles: 1,
    skippedFiles: 0,
    malformedRecords: count,
    distinctSessions: 1,
    message: `${count} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
    ...overrides,
  };
}

describe("usage source messages", () => {
  it("combines different skipped-record counts into one warning", () => {
    const codex = malformedSource(1);
    const claude = malformedSource(11, {
      fingerprint: { ...codex.fingerprint, provider: "claude", resolvedHomePath: "/demo/claude" },
    });

    expect(usageSourceMessages([codex, claude])).toEqual([
      "12 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it.each([
    { first: 1, second: 1, total: 2 },
    { first: 1, second: 11, total: 12 },
  ])(
    "combines hosts reporting $first and $second skipped records once per source",
    ({ first, second, total }) => {
      const source = malformedSource(first);
      const otherHost = malformedSource(second, {
        fingerprint: { ...source.fingerprint, hostId: "other-demo-host" },
      });

      expect(usageSourceMessages([source, source, otherHost, otherHost])).toEqual([
        `${total} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
      ]);
      expect(usageSourceMessages([source, source])).toEqual([
        `${first} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
      ]);
      expect(usageSourceMessages([otherHost, otherHost])).toEqual([
        `${second} malformed or inconsistent usage record(s) were skipped; usage may be incomplete.`,
      ]);
    },
  );

  it("keeps different machines with the same hostname and home path distinct", () => {
    const source = malformedSource(1);
    const otherMachine = malformedSource(11, {
      fingerprint: { ...source.fingerprint, volumeId: "other-demo-volume" },
    });

    expect(usageSourceMessages([source, otherMachine])).toEqual([
      "12 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it("uses the largest count when connected environments report the same source", () => {
    const source = malformedSource(1);

    expect(usageSourceMessages([source, malformedSource(11), source])).toEqual([
      "11 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it("retains other diagnostics beside the combined warning", () => {
    const source = malformedSource(1);
    const readFailure = "2 transcript path(s) could not be read; usage may be incomplete.";
    const cursor = malformedSource(0, {
      fingerprint: { ...source.fingerprint, provider: "cursor" },
      status: "ok",
      message: "Cursor history is limited to the last 30 days.",
    });

    expect(
      usageSourceMessages([
        { ...source, message: `${readFailure} ${source.message}` },
        { ...source, malformedRecords: 0, message: readFailure },
        cursor,
      ]),
    ).toEqual([
      readFailure,
      cursor.message,
      "1 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it("includes cached diagnostics when a transcript directory is missing", () => {
    const source = malformedSource(1);
    const missing = malformedSource(2, {
      fingerprint: { ...source.fingerprint, hostId: "other-demo-host" },
      status: "missing",
      scannedFiles: 0,
      skippedFiles: 1,
      distinctSessions: 0,
      message:
        "No transcript directory on this environment. 2 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    });

    expect(usageSourceMessages([source, missing, missing])).toEqual([
      "No transcript directory on this environment.",
      "3 malformed or inconsistent usage record(s) were skipped; usage may be incomplete.",
    ]);
  });

  it("omits empty missing sources, healthy sources, and diagnostics handled by an action", () => {
    expect(
      usageSourceMessages([
        malformedSource(0, { status: "missing" }),
        malformedSource(1, { status: "ok" }),
        malformedSource(1, { action: "enableCursorKeychain" }),
      ]),
    ).toEqual([]);
    expect(usageSourceMessages([])).toEqual([]);
  });
});

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EDT",
    );
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York", false)).toBe(
      "01:00 EST",
    );
  });

  it("builds an exact minute-aligned 24-hour request", () => {
    const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

    expect(window.resolution).toBe("hour");
    expect(window.sinceTime).toBe("2026-08-10T12:37:00.000Z");
    expect(window.untilTime).toBe("2026-08-11T12:37:00.000Z");
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});

describe("describeThreadCost", () => {
  const line = (overrides: Partial<ThreadCostLine> = {}): ThreadCostLine => ({
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 200,
      cacheCreationTokens: 300,
      outputTokens: 400,
      reasoningTokens: 50,
    },
    costUsd: 1,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    ...overrides,
  });
  const coverage = (overrides: Partial<ThreadCost["coverage"]> = {}): ThreadCost["coverage"] => ({
    complete: true,
    untrackedConversations: 0,
    conversationsWithoutUsage: 0,
    unreadableSources: 0,
    unpricedRecords: 0,
    ...overrides,
  });
  const cost = (overrides: Partial<ThreadCost> = {}): ThreadCost => ({
    threadId: ThreadId.make("thread"),
    readAt: "2026-08-02T00:00:00.000Z",
    totalCostUsd: 1,
    thread: { threadCount: 1, costUsd: 1, models: [line()] },
    subagents: { threadCount: 0, costUsd: 0, models: [] },
    coverage: coverage(),
    pricing: null,
    ...overrides,
  });

  it("states a complete figure plainly, with no split or notes", () => {
    expect(describeThreadCost(cost())).toEqual({
      amount: "$1.00",
      breakdown: [],
      models: [
        {
          key: "claude:claude-fable-5",
          label: "claude-fable-5",
          amount: "$1.00",
          // reasoningTokens is inside outputTokens, so it is not counted twice.
          tokens: formatTokens(1000),
        },
      ],
      notes: [],
    });
  });

  it("marks an incomplete figure as a lower bound", () => {
    const description = describeThreadCost(
      cost({ coverage: coverage({ complete: false, unreadableSources: 1 }) }),
    );
    expect(description.amount).toBe("$1.00+");
  });

  it("does not round real spend down to zero", () => {
    expect(describeThreadCost(cost({ totalCostUsd: 0.004 })).amount).toBe("<$0.01");
  });

  it("states a complete zero as zero and an incomplete zero as unknown", () => {
    expect(describeThreadCost(cost({ totalCostUsd: 0 })).amount).toBe("$0.00");
    expect(
      describeThreadCost(cost({ totalCostUsd: 0, coverage: coverage({ complete: false }) })).amount,
    ).toBe("Unknown");
  });

  it("splits out sub-agents only when the thread has some", () => {
    expect(
      describeThreadCost(cost({ subagents: { threadCount: 2, costUsd: 0.5, models: [] } }))
        .breakdown,
    ).toEqual([
      { label: "This thread", amount: "$1.00" },
      { label: "2 sub-agent threads", amount: "$0.50" },
    ]);
    expect(
      describeThreadCost(cost({ subagents: { threadCount: 1, costUsd: 0, models: [] } }))
        .breakdown[1]?.label,
    ).toBe("1 sub-agent thread");
  });

  it("merges a model used by the thread and a sub-agent, ordered by cost", () => {
    const description = describeThreadCost(
      cost({
        thread: {
          threadCount: 1,
          costUsd: 1.5,
          models: [line(), line({ model: "b-model", costUsd: 0.5 })],
        },
        subagents: {
          threadCount: 1,
          costUsd: 2,
          models: [line({ costUsd: 2 })],
        },
      }),
    );
    expect(description.models.map(({ label, amount, tokens }) => [label, amount, tokens])).toEqual([
      ["claude-fable-5", "$3.00", formatTokens(2000)],
      ["b-model", "$0.50", formatTokens(1000)],
    ]);
  });

  it("orders equal costs by model name", () => {
    const description = describeThreadCost(
      cost({
        thread: {
          threadCount: 1,
          costUsd: 2,
          models: [line({ model: "b-model" }), line({ model: "a-model" })],
        },
      }),
    );
    expect(description.models.map(({ label }) => label)).toEqual(["a-model", "b-model"]);
  });

  it("keeps one model from two providers apart", () => {
    const keys = describeThreadCost(
      cost({
        thread: {
          threadCount: 1,
          costUsd: 2,
          models: [line(), line({ provider: "cursor" })],
        },
      }),
    ).models.map(({ key }) => key);
    expect(keys).toEqual(["claude:claude-fable-5", "cursor:claude-fable-5"]);
  });

  it("says a model has no price rather than that it was free", () => {
    const description = describeThreadCost(
      cost({
        thread: {
          threadCount: 1,
          costUsd: 0,
          models: [line({ costUsd: 0, unpricedRecords: 1, costSource: "unpriced" })],
        },
      }),
    );
    expect(description.models[0]?.amount).toBe("No price");
  });

  it("explains each reason the figure may be low, with counts", () => {
    expect(
      describeThreadCost(
        cost({
          coverage: coverage({
            complete: false,
            untrackedConversations: 1,
            conversationsWithoutUsage: 1,
            unreadableSources: 1,
            unpricedRecords: 1,
          }),
        }),
      ).notes,
    ).toEqual([
      "1 conversation uses a provider with no usage history.",
      "1 conversation has no usage in this machine's history.",
      "1 usage source could not be fully read.",
      "1 usage record has no known price.",
    ]);
    expect(
      describeThreadCost(
        cost({
          coverage: coverage({
            complete: false,
            untrackedConversations: 2,
            conversationsWithoutUsage: 2,
            unreadableSources: 2,
            unpricedRecords: 2,
          }),
        }),
      ).notes,
    ).toEqual([
      "2 conversations use a provider with no usage history.",
      "2 conversations have no usage in this machine's history.",
      "2 usage sources could not be fully read.",
      "2 usage records have no known price.",
    ]);
  });

  it("says when a thread has not used a provider", () => {
    expect(
      describeThreadCost(cost({ totalCostUsd: 0, coverage: coverage({ complete: false }) })).notes,
    ).toEqual(["This thread has not used a provider yet."]);
  });
});
