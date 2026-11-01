import { assert, it, describe } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const completedAt = DateTime.makeUnsafe("2026-10-20T10:00:00.000Z");
const checkedAt = "2026-10-20T10:01:00.000Z";
const nowMs = Date.parse(checkedAt);
const resetAt = "2026-10-21T10:00:00.000Z";
const thread: ProjectionStore.ProjectionLimitRecoveryCandidate = {
  id: ThreadId.make("limited"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: RunId.make("limited-run"),
  latestRunCompletedAt: completedAt,
  usageLimitResetAt: resetAt,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  updatedAt: completedAt,
  snoozedUntil: null,
  limitRecovery: {
    runId: RunId.make("limited-run"),
    resetAt,
    autoResume: true,
    requestId: CommandId.make("arm"),
  },
};
const limits: ServerProviderUsageLimits = {
  checkedAt,
  windows: [
    { id: "primary", kind: "session", label: "Session", usedPercent: 0 },
    { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 20 },
  ],
};

describe("usage-limit capacity recovery", () => {
  it("continues before the original deadline after a fresh capacity read", () => {
    const command = UsageLimitRecoveryWorker.limitRecoveryCommand(
      thread,
      true,
      nowMs,
      false,
      limits,
    );
    expect(command).toMatchObject({
      type: "message.dispatch",
      usageLimitContinuationOfRunId: thread.latestRunId,
      usageLimitResetConfirmedAt: checkedAt,
      usageLimitRecoveryRequestId: thread.limitRecovery!.requestId,
    });
    expect(
      UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs + 1000, false, limits)
        ?.commandId,
    ).toBe(command?.commandId);
  });

  it.each([
    { ...limits, checkedAt: DateTime.formatIso(completedAt) },
    { ...limits, checkedAt: "2026-10-20T09:59:00.000Z" },
    { ...limits, checkedAt: "2026-10-20T10:02:00.000Z" },
    { ...limits, windows: [] },
    { ...limits, unavailable: { reason: "probeFailed" as const } },
    {
      ...limits,
      windows: [
        ...limits.windows,
        { id: "monthly", kind: "monthly" as const, label: "Monthly", usedPercent: 100 },
      ],
    },
  ])("waits when capacity is unconfirmed: %j", (snapshot) => {
    expect(
      UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs, false, snapshot),
    ).toBeNull();
  });

  it("honors cancellation and manual snoozes while waking a recovery snooze", () => {
    const snoozed = { ...thread, snoozedUntil: DateTime.makeUnsafe(resetAt) };
    expect(
      UsageLimitRecoveryWorker.limitRecoveryCommand(snoozed, true, nowMs, false, limits),
    ).toBeNull();
    expect(
      UsageLimitRecoveryWorker.limitRecoveryCommand(
        { ...snoozed, limitRecovery: { ...thread.limitRecovery!, snooze: true } },
        true,
        nowMs,
        false,
        limits,
      )?.type,
    ).toBe("message.dispatch");
    expect(
      UsageLimitRecoveryWorker.limitRecoveryCommand(
        { ...thread, limitRecovery: { ...thread.limitRecovery!, autoResume: false } },
        true,
        nowMs,
        false,
        limits,
      ),
    ).toBeNull();
    expect(
      UsageLimitRecoveryWorker.limitRecoveryCommand(
        { ...thread, latestRunCompletedAt: DateTime.makeUnsafe(checkedAt) },
        true,
        nowMs,
        false,
        limits,
      ),
    ).toBeNull();
  });

  it.effect("uses the destination provider snapshot in the recovery sweep", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const freshLimits = { ...limits, checkedAt: DateTime.formatIso(now) };
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const candidate = {
        ...thread,
        latestRunCompletedAt: DateTime.subtract(now, { minutes: 1 }),
        updatedAt: DateTime.subtract(now, { minutes: 1 }),
        usageLimitResetAt: DateTime.formatIso(DateTime.add(now, { days: 1 })),
      };
      candidate.limitRecovery = {
        ...candidate.limitRecovery!,
        resetAt: candidate.usageLimitResetAt,
      };
      const provider = {
        instanceId: thread.providerInstanceId,
        enabled: true,
        snapshot: { getSnapshot: Effect.succeed({ usageLimits: freshLimits }) },
      } as ProviderInstance;
      const dependencies = Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed([provider]),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitRecoveryCandidates: (options) => {
            assert.deepEqual(options.availableProviderInstanceIds, [thread.providerInstanceId]);
            return Effect.succeed([candidate]);
          },
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Ref.update(commands, (all) => [...all, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(Scheduler.Scheduler)({ register: (_name, run) => run.pipe(Effect.orDie) }),
      );
      yield* Effect.void.pipe(
        Effect.provide(UsageLimitRecoveryWorker.layer.pipe(Layer.provide(dependencies))),
      );
      assert.lengthOf(yield* Ref.get(commands), 1);
      expect((yield* Ref.get(commands))[0]).toMatchObject({
        type: "message.dispatch",
        usageLimitResetConfirmedAt: freshLimits.checkedAt,
      });
    }).pipe(Effect.scoped),
  );
});

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed([]),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

describe("limitRecoveryCommand arming", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

  const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
    const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
    const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
      id: ThreadId.make("thread:limited"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "failed",
      lastErrorClass: "usage_limit",
      usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
      latestRunId: RunId.make("run:limited"),
      latestRunCompletedAt: failedAt,
      updatedAt: failedAt,
      archivedAt: null,
      settledOverride: null,
      pendingRuntimeRequest: null,
      limitRecovery: null,
      snoozedUntil: null,
    };
    return candidate;
  };

  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(UsageLimitRecoveryWorker.limitRecoveryCommand(thread, true, nowMs));
  });
});
