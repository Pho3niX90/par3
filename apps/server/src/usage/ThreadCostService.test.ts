import { assert, describe, it } from "@effect/vitest";
import {
  ThreadId,
  type UsageBucket,
  UsageDay,
  UsageReadError,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ThreadCostService from "./ThreadCostService.ts";
import * as UsageService from "./UsageService.ts";

const ROOT = ThreadId.make("thread-root");
const PRICING = {
  status: "fresh",
  source: "https://example.test/rates.json",
  fetchedAt: null,
  knownModels: 1,
} satisfies UsageSummary["pricing"];

const row = (overrides: Partial<ThreadCostService.ThreadConversationRow> = {}) => ({
  thread_id: ROOT,
  provider_thread_id: "pt-1",
  driver: "claudeAgent",
  created_at: "2026-08-01T10:00:00.000Z",
  native_id: "session-1",
  ...overrides,
});

const bucket = (overrides: Partial<UsageBucket> = {}): UsageBucket => ({
  day: UsageDay.make("2026-08-01"),
  provider: "claude",
  model: "claude-fable-5",
  sourcePath: "session-1",
  totals: {
    uncachedInputTokens: 1,
    cachedInputTokens: 2,
    cacheCreationTokens: 3,
    outputTokens: 4,
    reasoningTokens: 5,
  },
  costUsd: 1,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 1,
  unpricedRecords: 0,
  sessions: 1,
  ...overrides,
});

const source = (status: UsageSource["status"]): UsageSource => ({
  fingerprint: {
    hostId: "host",
    provider: "claude",
    resolvedHomePath: "/home",
    volumeId: "volume",
  },
  status,
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
});

const summary = (
  buckets: readonly UsageBucket[],
  sources: readonly UsageSource[] = [source("ok")],
): UsageSummary => ({
  contractVersion: 6,
  readAt: "2026-08-02T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-08-01"),
  untilDay: UsageDay.make("2026-08-02"),
  buckets,
  sources,
  pricing: PRICING,
  scanDurationMs: 0,
});

const summarize = (
  rows: readonly ThreadCostService.ThreadConversationRow[],
  usage: UsageSummary | null,
  threadCount = 1,
) =>
  ThreadCostService.summarizeThreadCost({
    threadId: ROOT,
    readAt: "2026-08-02T00:00:00.000Z",
    threadCount,
    conversations: ThreadCostService.planThreadConversations(ROOT, rows),
    summary: usage,
  });

describe("usageProvidersByDriver", () => {
  it("maps drivers that report usage and leaves out those that do not", () => {
    assert.deepStrictEqual(
      [
        ...ThreadCostService.usageProvidersByDriver([
          { driverKind: "claudeAgent", usage: { provider: "claude" } },
          { driverKind: "acpRegistry" },
        ]),
      ],
      [["claudeAgent", "claude"]],
    );
  });
});

describe("planThreadConversations", () => {
  it("maps a driver to its usage provider and starts each session at its provider thread", () => {
    const plan = ThreadCostService.planThreadConversations(ROOT, [
      row(),
      row({ provider_thread_id: "pt-2", driver: "codex", native_id: "session-2" }),
    ]);
    assert.deepStrictEqual(
      [...plan.scope].map(([provider, sessions]) => [provider, [...sessions]]),
      [
        ["claude", [["session-1", Date.parse("2026-08-01T10:00:00.000Z")]]],
        ["codex", [["session-2", Date.parse("2026-08-01T10:00:00.000Z")]]],
      ],
    );
    assert.strictEqual(plan.untrackedConversations, 0);
    assert.strictEqual(plan.firstCountedMs, Date.parse("2026-08-01T10:00:00.000Z"));
  });

  it("keeps the earliest instant when two provider threads report one session", () => {
    const plan = ThreadCostService.planThreadConversations(ROOT, [
      row({ created_at: "2026-08-03T00:00:00.000Z" }),
      row({ provider_thread_id: "pt-2", created_at: "2026-08-01T00:00:00.000Z" }),
      row({ provider_thread_id: "pt-3", created_at: "2026-08-02T00:00:00.000Z" }),
    ]);
    assert.strictEqual(
      plan.scope.get("claude")?.get("session-1"),
      Date.parse("2026-08-01T00:00:00.000Z"),
    );
    assert.strictEqual(plan.firstCountedMs, Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("marks a session the thread itself reports as its own, and a sub-agent's as not", () => {
    const plan = ThreadCostService.planThreadConversations(ROOT, [
      row(),
      row({ thread_id: "thread-child", provider_thread_id: "pt-2", native_id: "session-2" }),
    ]);
    assert.deepStrictEqual([...plan.ownSessions], ["claude\u0000session-1"]);
    assert.strictEqual(plan.scope.get("claude")?.size, 2);
  });

  it("counts a driver with no usage history once per provider thread, whatever its session", () => {
    const plan = ThreadCostService.planThreadConversations(ROOT, [
      row({ driver: "acpRegistry" }),
      row({ driver: "acpRegistry", native_id: "other-session" }),
      row({ driver: "acpRegistry", native_id: null }),
    ]);
    assert.strictEqual(plan.untrackedConversations, 1);
    assert.strictEqual(plan.scope.size, 0);
    assert.strictEqual(plan.firstCountedMs, null);
  });

  it("ignores a supported provider thread that has not started a session", () => {
    const plan = ThreadCostService.planThreadConversations(ROOT, [row({ native_id: null })]);
    assert.strictEqual(plan.untrackedConversations, 0);
    assert.strictEqual(plan.scope.size, 0);
    assert.strictEqual(plan.firstCountedMs, null);
  });

  it("reports a session it cannot date as untracked instead of counting all of its history", () => {
    for (const created_at of ["not a date", null]) {
      const plan = ThreadCostService.planThreadConversations(ROOT, [row({ created_at })]);
      assert.strictEqual(plan.untrackedConversations, 1);
      assert.strictEqual(plan.scope.size, 0);
      assert.strictEqual(plan.firstCountedMs, null);
    }
  });
});

describe("summarizeThreadCost", () => {
  it("merges days into one line per model and is complete when nothing is missing", () => {
    const cost = summarize(
      [row()],
      summary([bucket(), bucket({ day: UsageDay.make("2026-08-02"), costUsd: 0.5 })]),
    );
    assert.strictEqual(cost.totalCostUsd, 1.5);
    assert.strictEqual(cost.thread.costUsd, 1.5);
    assert.strictEqual(cost.thread.threadCount, 1);
    assert.deepStrictEqual(cost.thread.models, [
      {
        provider: "claude",
        model: "claude-fable-5",
        totals: {
          uncachedInputTokens: 2,
          cachedInputTokens: 4,
          cacheCreationTokens: 6,
          outputTokens: 8,
          reasoningTokens: 10,
        },
        costUsd: 1.5,
        costSource: "modelPriced",
        records: 2,
        unpricedRecords: 0,
      },
    ]);
    assert.deepStrictEqual(cost.subagents, { threadCount: 0, costUsd: 0, models: [] });
    assert.deepStrictEqual(cost.coverage, {
      complete: true,
      untrackedConversations: 0,
      conversationsWithoutUsage: 0,
      unreadableSources: 0,
      unpricedRecords: 0,
    });
    assert.deepStrictEqual(cost.pricing, PRICING);
  });

  it("splits sub-agent spend from the thread's own and totals both", () => {
    const cost = summarize(
      [
        row(),
        row({ thread_id: "thread-child", provider_thread_id: "pt-2", native_id: "session-2" }),
      ],
      summary([bucket({ costUsd: 2 }), bucket({ sourcePath: "session-2", costUsd: 3 })]),
      3,
    );
    assert.strictEqual(cost.thread.costUsd, 2);
    assert.strictEqual(cost.subagents.costUsd, 3);
    assert.strictEqual(cost.subagents.threadCount, 2);
    assert.strictEqual(cost.totalCostUsd, 5);
  });

  it("does not confuse equal session ids from different providers", () => {
    const cost = summarize(
      [
        row(),
        row({
          thread_id: "thread-child",
          provider_thread_id: "pt-2",
          driver: "codex",
        }),
      ],
      summary([bucket({ costUsd: 2 }), bucket({ provider: "codex", costUsd: 3 })]),
      2,
    );
    assert.strictEqual(cost.thread.costUsd, 2);
    assert.strictEqual(cost.subagents.costUsd, 3);
  });

  it("orders lines by cost, then model, and rounds to a millionth of a dollar", () => {
    const cost = summarize(
      [row()],
      summary([
        bucket({ model: "b-model", costUsd: 1 }),
        bucket({ model: "a-model", costUsd: 1 }),
        bucket({ model: "c-model", costUsd: 2.123_456_7 }),
      ]),
    );
    assert.deepStrictEqual(
      cost.thread.models.map(({ model, costUsd }) => [model, costUsd]),
      [
        ["c-model", 2.123_457],
        ["a-model", 1],
        ["b-model", 1],
      ],
    );
    assert.strictEqual(cost.totalCostUsd, 4.123_457);
  });

  it("keeps a line's source when every day agrees and falls back to modelPriced when not", () => {
    const sourceOf = (...sources: UsageBucket["costSource"][]) =>
      summarize([row()], summary(sources.map((costSource) => bucket({ costSource })))).thread
        .models[0]?.costSource;
    assert.strictEqual(sourceOf("providerReported", "providerReported"), "providerReported");
    assert.strictEqual(sourceOf("unpriced", "unpriced"), "unpriced");
    assert.strictEqual(sourceOf("providerReported", "unpriced"), "modelPriced");
  });

  it("is not complete when a driver has no usage history", () => {
    const cost = summarize([row({ driver: "acpRegistry" })], null);
    assert.strictEqual(cost.totalCostUsd, 0);
    assert.strictEqual(cost.pricing, null);
    assert.deepStrictEqual(cost.coverage, {
      complete: false,
      untrackedConversations: 1,
      conversationsWithoutUsage: 0,
      unreadableSources: 0,
      unpricedRecords: 0,
    });
  });

  it("is not complete when a conversation has no usage in history", () => {
    const cost = summarize(
      [row(), row({ provider_thread_id: "pt-2", native_id: "session-2" })],
      summary([bucket()]),
    );
    assert.strictEqual(cost.coverage.complete, false);
    assert.strictEqual(cost.coverage.conversationsWithoutUsage, 1);
  });

  it("counts only partial and failed sources as unreadable", () => {
    for (const [status, expected] of [
      ["ok", 0],
      ["missing", 0],
      ["partial", 1],
      ["failed", 1],
    ] as const) {
      const cost = summarize([row()], summary([bucket()], [source(status)]));
      assert.strictEqual(cost.coverage.unreadableSources, expected);
      assert.strictEqual(cost.coverage.complete, expected === 0);
    }
  });

  it("is not complete when any record has no price", () => {
    const cost = summarize(
      [row()],
      summary([bucket({ unpricedRecords: 2, records: 2, costUsd: 0, costSource: "unpriced" })]),
    );
    assert.strictEqual(cost.coverage.complete, false);
    assert.strictEqual(cost.coverage.unpricedRecords, 2);
  });

  it("does not call a thread with no provider conversations complete", () => {
    const cost = summarize([], null);
    assert.strictEqual(cost.totalCostUsd, 0);
    assert.strictEqual(cost.coverage.complete, false);
  });

  it("treats a bucket with no session as sub-agent spend rather than dropping it", () => {
    const { sourcePath: _sourcePath, ...withoutSession } = bucket();
    const cost = summarize([row()], summary([withoutSession]));
    assert.strictEqual(cost.thread.costUsd, 0);
    assert.strictEqual(cost.subagents.costUsd, 1);
    assert.strictEqual(cost.totalCostUsd, 1);
    assert.strictEqual(cost.coverage.conversationsWithoutUsage, 1);
  });
});

describe("ThreadCostService.read", () => {
  type ReadCall = { input: UsageSummaryInput; scope: UsageService.UsageSessionScope };

  const seedThread = (input: {
    readonly id: string;
    readonly parent?: string;
    readonly relationship?: "fork" | "subagent";
    readonly deletedAt?: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: input.id,
        project_id: "project",
        title: input.id,
        default_provider: "claudeAgent",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
        deleted_at: input.deletedAt ?? null,
        payload_json: JSON.stringify({
          lineage: {
            parentThreadId: input.parent ?? null,
            relationshipToParent: input.relationship ?? null,
          },
        }),
      })}`;
    });

  const seedProviderThread = (input: {
    readonly id: string;
    readonly threadId: string;
    readonly driver?: string;
    readonly nativeId?: string | null;
    readonly createdAt?: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads ${sql.insert({
        provider_thread_id: input.id,
        thread_id: input.threadId,
        provider: input.driver ?? "claudeAgent",
        status: "idle",
        updated_at: "2026-08-01T00:00:00.000Z",
        payload_json: JSON.stringify({
          createdAt: input.createdAt ?? "2026-08-01T10:00:00.000Z",
          nativeThreadRef:
            input.nativeId === null
              ? null
              : { driver: input.driver ?? "claudeAgent", nativeId: input.nativeId ?? input.id },
        }),
      })}`;
    });

  const seedAttempt = (input: {
    readonly id: string;
    readonly threadId: string;
    readonly providerThreadId: string;
    readonly nativeThreadId: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
        attempt_id: input.id,
        thread_id: input.threadId,
        run_id: `run-${input.id}`,
        attempt_ordinal: 1,
        root_node_id: "node",
        provider: "claudeAgent",
        provider_thread_id: input.providerThreadId,
        status: "completed",
        payload_json: JSON.stringify({ nativeThreadId: input.nativeThreadId }),
      })}`;
    });

  const makeHarness = (
    readSessions: (
      input: UsageSummaryInput,
      scope: UsageService.UsageSessionScope,
    ) => Effect.Effect<UsageSummary, UsageReadError> = () => Effect.succeed(summary([])),
  ) => {
    const calls: ReadCall[] = [];
    const layer = ThreadCostService.layer.pipe(
      Layer.provide(
        Layer.mock(UsageService.UsageService)({
          readSessions: (input, scope) => {
            calls.push({ input, scope });
            return readSessions(input, scope);
          },
        }),
      ),
      Layer.provideMerge(Sqlite.layerMemory),
    );
    return { calls, layer };
  };

  const scopeOf = (call: ReadCall | undefined) =>
    call === undefined
      ? null
      : [...call.scope].map(([provider, sessions]) => [provider, [...sessions.keys()].toSorted()]);

  it.effect("reports a missing thread without scanning", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const service = yield* ThreadCostService.ThreadCostService;
      const error = yield* Effect.flip(service.read({ threadId: ROOT }));
      assert.instanceOf(error, UsageReadError);
      assert.strictEqual(error.reason, "threadNotFound");
      assert.strictEqual(harness.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a deleted thread as missing", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread({ id: ROOT, deletedAt: "2026-08-02T00:00:00.000Z" });
      yield* seedProviderThread({ id: "pt-1", threadId: ROOT });
      const service = yield* ThreadCostService.ThreadCostService;
      const error = yield* Effect.flip(service.read({ threadId: ROOT }));
      assert.strictEqual(error.reason, "threadNotFound");
      assert.strictEqual(harness.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("skips the scan for a thread that has not talked to a provider", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread({ id: ROOT });
      const service = yield* ThreadCostService.ThreadCostService;
      const cost = yield* service.read({ threadId: ROOT });
      assert.strictEqual(harness.calls.length, 0);
      assert.strictEqual(cost.totalCostUsd, 0);
      assert.strictEqual(cost.pricing, null);
      assert.strictEqual(cost.coverage.complete, false);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("rolls up nested sub-agents, including deleted ones, but stops at forks", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread({ id: ROOT });
      yield* seedThread({ id: "child", parent: ROOT, relationship: "subagent" });
      yield* seedThread({ id: "grandchild", parent: "child", relationship: "subagent" });
      yield* seedThread({
        id: "deleted-child",
        parent: ROOT,
        relationship: "subagent",
        deletedAt: "2026-08-02T00:00:00.000Z",
      });
      yield* seedThread({ id: "fork", parent: ROOT, relationship: "fork" });
      yield* seedThread({ id: "unrelated" });
      for (const id of [ROOT, "child", "grandchild", "deleted-child", "fork", "unrelated"]) {
        yield* seedProviderThread({ id: `pt-${id}`, threadId: id, nativeId: `session-${id}` });
      }
      const service = yield* ThreadCostService.ThreadCostService;
      const cost = yield* service.read({ threadId: ROOT });
      assert.deepStrictEqual(scopeOf(harness.calls[0]), [
        [
          "claude",
          [
            "session-child",
            "session-deleted-child",
            "session-grandchild",
            `session-${ROOT}`,
          ].toSorted(),
        ],
      ]);
      assert.strictEqual(cost.subagents.threadCount, 3);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports a sub-agent thread on its own, without its parent", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread({ id: ROOT });
      yield* seedThread({ id: "child", parent: ROOT, relationship: "subagent" });
      yield* seedProviderThread({ id: "pt-root", threadId: ROOT, nativeId: "session-root" });
      yield* seedProviderThread({ id: "pt-child", threadId: "child", nativeId: "session-child" });
      const service = yield* ThreadCostService.ThreadCostService;
      const cost = yield* service.read({ threadId: ThreadId.make("child") });
      assert.deepStrictEqual(scopeOf(harness.calls[0]), [["claude", ["session-child"]]]);
      assert.strictEqual(cost.subagents.threadCount, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("includes a session only a past attempt knows, once per session", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* seedThread({ id: ROOT });
      yield* seedProviderThread({ id: "pt-1", threadId: ROOT, nativeId: "current-session" });
      yield* seedAttempt({
        id: "attempt-1",
        threadId: ROOT,
        providerThreadId: "pt-1",
        nativeThreadId: "replaced-session",
      });
      yield* seedAttempt({
        id: "attempt-2",
        threadId: ROOT,
        providerThreadId: "pt-1",
        nativeThreadId: "current-session",
      });
      const service = yield* ThreadCostService.ThreadCostService;
      yield* service.read({ threadId: ROOT });
      assert.deepStrictEqual(scopeOf(harness.calls[0]), [
        ["claude", ["current-session", "replaced-session"]],
      ]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reads from the first conversation's day to tomorrow, waiting for slow sources", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-05T23:30:00.000Z"));
      yield* seedThread({ id: ROOT });
      yield* seedProviderThread({
        id: "pt-1",
        threadId: ROOT,
        createdAt: "2026-08-01T23:59:00.000Z",
      });
      const service = yield* ThreadCostService.ThreadCostService;
      const cost = yield* service.read({ threadId: ROOT });
      assert.deepStrictEqual(harness.calls[0]?.input, {
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-08-01"),
        untilDay: UsageDay.make("2026-08-06"),
        awaitRefresh: true,
      });
      assert.strictEqual(cost.readAt, "2026-08-05T23:30:00.000Z");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("passes scan failures through and reads again afterwards", () => {
    let fail = true;
    const harness = makeHarness(() =>
      fail
        ? Effect.fail(new UsageReadError({ reason: "scanFailed", detail: "disk" }))
        : Effect.succeed(summary([bucket({ sourcePath: "pt-1" })])),
    );
    return Effect.gen(function* () {
      yield* seedThread({ id: ROOT });
      yield* seedProviderThread({ id: "pt-1", threadId: ROOT });
      const service = yield* ThreadCostService.ThreadCostService;
      const error = yield* Effect.flip(service.read({ threadId: ROOT }));
      assert.strictEqual(error.reason, "scanFailed");
      fail = false;
      assert.strictEqual((yield* service.read({ threadId: ROOT })).totalCostUsd, 1);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports SQL failures through the typed channel", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ThreadCostService.ThreadCostService;
      yield* seedThread({ id: ROOT });

      yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads RENAME TO unavailable`;
      const conversations = yield* Effect.flip(service.read({ threadId: ROOT }));
      assert.strictEqual(conversations.reason, "scanFailed");
      assert.isDefined(conversations.cause);
      yield* sql`ALTER TABLE unavailable RENAME TO orchestration_v2_projection_provider_threads`;

      yield* sql`ALTER TABLE orchestration_v2_projection_threads RENAME TO unavailable`;
      const tree = yield* Effect.flip(service.read({ threadId: ROOT }));
      assert.strictEqual(tree.reason, "scanFailed");
      yield* sql`ALTER TABLE unavailable RENAME TO orchestration_v2_projection_threads`;

      assert.strictEqual((yield* service.read({ threadId: ROOT })).totalCostUsd, 0);
    }).pipe(Effect.provide(harness.layer));
  });
});
