import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

const hasAvailableCapacity = (limits: ServerProviderUsageLimits) =>
  limits.unavailable === undefined &&
  limits.windows.length > 0 &&
  limits.windows.every((window) => window.usedPercent < 100);

const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  limits?: ServerProviderUsageLimits,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  if (thread.scheduledTaskFallback !== undefined) {
    if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
      return null;
    return {
      type: "message.dispatch",
      commandId: CommandId.make(`scheduled-task-fallback:${thread.latestRunId}`),
      messageId: MessageId.make(`scheduled-task-fallback:${thread.latestRunId}`),
      threadId: thread.id,
      scheduledTaskFallbackOfRunId: thread.latestRunId,
      modelSelection: thread.scheduledTaskFallback,
      text: "The automation's primary provider reached its usage limit. Continue where it left off using the configured fallback model. Preserve completed work and check existing results before repeating actions.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    };
  }
  if (!thread.usageLimitResetAt) return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  // A reset credit can restore capacity before the failed turn's original deadline.
  // An older snapshot must never retry a newly limited turn.
  const resetConfirmed =
    limits !== undefined &&
    hasAvailableCapacity(limits) &&
    Date.parse(limits.checkedAt) >
      DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt) &&
    Date.parse(limits.checkedAt) <= nowMs;
  const recoverySnooze =
    recovery.snooze &&
    thread.snoozedUntil != null &&
    DateTime.toEpochMillis(thread.snoozedUntil) === resetMs;
  if (
    !recovery.autoResume ||
    (resetMs > nowMs && !resetConfirmed) ||
    (thread.snoozedUntil != null &&
      DateTime.toEpochMillis(thread.snoozedUntil) > nowMs &&
      !(resetConfirmed && recoverySnooze))
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(resetConfirmed ? { usageLimitResetConfirmedAt: limits.checkedAt } : {}),
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  let lastCapacity = "";
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const availableLimits = new Map(
      yield* Effect.forEach(yield* providers.listInstances, (instance) =>
        instance.snapshot.getSnapshot.pipe(
          Effect.map(
            (snapshot) =>
              [instance.instanceId, instance.enabled ? snapshot.usageLimits : undefined] as const,
          ),
        ),
      ),
    );
    // Capacity coming back reaches this worker as a provider snapshot, not a domain event.
    const availableProviderInstanceIds = [...availableLimits]
      .filter(([, limits]) => limits !== undefined && hasAvailableCapacity(limits))
      .map(([id]) => id);
    const capacity = availableProviderInstanceIds.join();
    if (capacity !== lastCapacity) {
      lastCapacity = capacity;
      yield* due.invalidate;
    }
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      availableProviderInstanceIds,
    });
    let acted = false;
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
        availableLimits.get(thread.providerInstanceId),
      );
      if (command === null) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
