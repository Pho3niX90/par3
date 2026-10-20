/**
 * The per-task export written by the Harbor driver, and the pure functions that read it.
 *
 * The export is a slimmed copy of each thread's `OrchestrationV2ThreadProjection`
 * (packages/contracts/src/orchestrationV2.ts) as it arrives on the wire: dates are ISO strings
 * and model selections use the wire shape `{ instanceId, model, options: [{ id, value }] }`.
 * This file stays dependency-free so the driver can run it inside a task container that has
 * Node but not the Par3 monorepo.
 */

export interface WireModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
}

/**
 * `OrchestrationV2ProviderTurn.turnTokenUsage` (providerRuntime.ts `TurnTokenUsage`): billed usage
 * for one provider turn. inputTokens includes cache reads and writes; outputTokens includes
 * reasoning. The `tokenUsage` field on the same turn is a context-window snapshot and is not
 * summed.
 */
export interface WireTurnTokenUsage {
  readonly usageScope?: string;
  readonly usageStatus: "complete" | "partial" | "unavailable";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly hasSubagents: boolean;
}

export interface ExportedRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly modelSelection: WireModelSelection;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly delegatedTaskId?: string;
}

export interface ExportedProviderTurn {
  readonly id: string;
  readonly runAttemptId: string | null;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly turnTokenUsage?: WireTurnTokenUsage;
}

export interface ExportedSubagent {
  readonly id: string;
  readonly origin: string;
  readonly childThreadId: string | null;
  readonly status: string;
  readonly result: string | null;
  readonly model: string | null;
  readonly modelSelection?: WireModelSelection;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ExportedThread {
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: string | null;
  readonly modelSelection: WireModelSelection;
  readonly sidekickModelSelection: WireModelSelection | null;
  readonly runs: ReadonlyArray<ExportedRun>;
  readonly attempts: ReadonlyArray<{ readonly id: string; readonly runId: string }>;
  readonly providerTurns: ReadonlyArray<ExportedProviderTurn>;
  readonly subagents: ReadonlyArray<ExportedSubagent>;
  /** Runs of this thread that produced at least one `file_change` turn item. */
  readonly fileChangeRunIds: ReadonlyArray<string>;
}

export interface Par3TaskExport {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly arm: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly settled: boolean;
  readonly timedOut: boolean;
  readonly leadThreadId: string;
  readonly threads: ReadonlyArray<ExportedThread>;
  /** Test/verifier files whose content changed while the agent ran (reward-hacking check). */
  readonly protectedFilesChanged: ReadonlyArray<string>;
}

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json =>
  typeof value === "object" && value !== null ? (value as Json) : {};
const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

function wireModelSelection(value: unknown): WireModelSelection {
  const raw = asRecord(value);
  const options = asArray(raw["options"]).map((option) => {
    const entry = asRecord(option);
    return { id: String(entry["id"]), value: entry["value"] };
  });
  return {
    instanceId: String(raw["instanceId"] ?? raw["provider"] ?? "unknown"),
    model: String(raw["model"] ?? "unknown"),
    ...(options.length > 0 ? { options } : {}),
  };
}

/** Keeps only what cost and diagnostics need, so exports stay small (no messages, no diffs). */
export function slimProjection(projection: unknown): ExportedThread {
  const raw = asRecord(projection);
  const thread = asRecord(raw["thread"]);
  const lineage = asRecord(thread["lineage"]);
  const sidekick = thread["sidekickModelSelection"];
  const fileChangeRunIds = new Set<string>();
  for (const item of asArray(raw["turnItems"])) {
    const entry = asRecord(item);
    const runId = asString(entry["runId"]);
    if (entry["type"] === "file_change" && runId !== null) fileChangeRunIds.add(runId);
  }
  return {
    threadId: String(thread["id"]),
    parentThreadId: asString(lineage["parentThreadId"]),
    relationshipToParent: asString(lineage["relationshipToParent"]),
    modelSelection: wireModelSelection(thread["modelSelection"]),
    sidekickModelSelection:
      sidekick === null || sidekick === undefined ? null : wireModelSelection(sidekick),
    runs: asArray(raw["runs"]).map((value) => {
      const run = asRecord(value);
      const delegatedTaskId = asString(run["delegatedTaskId"]);
      return {
        id: String(run["id"]),
        ordinal: Number(run["ordinal"]),
        status: String(run["status"]),
        modelSelection: wireModelSelection(run["modelSelection"]),
        startedAt: asString(run["startedAt"]),
        completedAt: asString(run["completedAt"]),
        ...(delegatedTaskId === null ? {} : { delegatedTaskId }),
      };
    }),
    attempts: asArray(raw["attempts"]).map((value) => {
      const attempt = asRecord(value);
      return { id: String(attempt["id"]), runId: String(attempt["runId"]) };
    }),
    providerTurns: asArray(raw["providerTurns"]).map((value) => {
      const turn = asRecord(value);
      const usage = turn["turnTokenUsage"];
      return {
        id: String(turn["id"]),
        runAttemptId: asString(turn["runAttemptId"]),
        status: String(turn["status"]),
        startedAt: asString(turn["startedAt"]),
        completedAt: asString(turn["completedAt"]),
        ...(usage === undefined ? {} : { turnTokenUsage: usage as WireTurnTokenUsage }),
      };
    }),
    subagents: asArray(raw["subagents"]).map((value) => {
      const subagent = asRecord(value);
      const modelSelection = subagent["modelSelection"];
      return {
        id: String(subagent["id"]),
        origin: String(subagent["origin"]),
        childThreadId: asString(subagent["childThreadId"]),
        status: String(subagent["status"]),
        result: asString(subagent["result"]),
        model: asString(subagent["model"]),
        ...(modelSelection === undefined
          ? {}
          : { modelSelection: wireModelSelection(modelSelection) }),
        startedAt: asString(subagent["startedAt"]),
        completedAt: asString(subagent["completedAt"]),
      };
    }),
    fileChangeRunIds: [...fileChangeRunIds],
  };
}

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const LIVE_SUBAGENT_STATUSES = new Set(["pending", "running", "waiting"]);

/**
 * A thread is settled when no run is queued or running and no delegated task is live. A child's
 * completion wakes the lead with a new run, so callers should see two settled polls in a row
 * before trusting this.
 */
export function isThreadSettled(thread: ExportedThread): boolean {
  return (
    thread.runs.length > 0 &&
    thread.runs.every((run) => TERMINAL_RUN_STATUSES.has(run.status)) &&
    thread.subagents.every((subagent) => !LIVE_SUBAGENT_STATUSES.has(subagent.status))
  );
}

export function childThreadIds(thread: ExportedThread): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const subagent of thread.subagents) {
    if (subagent.childThreadId !== null) ids.add(subagent.childThreadId);
  }
  return [...ids];
}

export type UsageRole = "lead" | "sidekick" | "child";

export interface TurnUsageRecord {
  readonly threadId: string;
  readonly providerTurnId: string;
  readonly role: UsageRole;
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
  readonly usageStatus: WireTurnTokenUsage["usageStatus"] | "missing";
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Provider-native subagents ran inside this turn; their tokens are not in this record. */
  readonly hasNativeSubagents: boolean;
}

const sameModel = (a: WireModelSelection, b: WireModelSelection | null) =>
  b !== null && a.instanceId === b.instanceId && a.model === b.model;

/**
 * One record per provider turn across the lead and every child thread. The model is the turn's
 * run's selection (the effective model for that turn), not the thread's current selection,
 * which the lead can change mid-task.
 */
export function extractTurnUsage(taskExport: Par3TaskExport): ReadonlyArray<TurnUsageRecord> {
  const lead = taskExport.threads.find((thread) => thread.threadId === taskExport.leadThreadId);
  const sidekick = lead?.sidekickModelSelection ?? null;
  const records: TurnUsageRecord[] = [];
  for (const thread of taskExport.threads) {
    const runById = new Map(thread.runs.map((run) => [run.id, run]));
    const runIdByAttempt = new Map(thread.attempts.map((attempt) => [attempt.id, attempt.runId]));
    for (const turn of thread.providerTurns) {
      const runId = turn.runAttemptId === null ? undefined : runIdByAttempt.get(turn.runAttemptId);
      const selection = (runId === undefined ? undefined : runById.get(runId))?.modelSelection;
      const effective = selection ?? thread.modelSelection;
      const role: UsageRole =
        thread.threadId === taskExport.leadThreadId
          ? "lead"
          : sameModel(effective, sidekick)
            ? "sidekick"
            : "child";
      const usage = turn.turnTokenUsage;
      const input = usage?.inputTokens ?? 0;
      const cacheRead = usage?.cachedInputTokens ?? 0;
      const cacheWrite = usage?.cacheCreationTokens ?? 0;
      records.push({
        threadId: thread.threadId,
        providerTurnId: turn.id,
        role,
        instanceId: effective.instanceId,
        model: effective.model,
        options: effective.options ?? [],
        usageStatus: usage?.usageStatus ?? "missing",
        uncachedInputTokens: Math.max(0, input - cacheRead - cacheWrite),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        hasNativeSubagents: usage?.hasSubagents ?? false,
      });
    }
  }
  return records;
}

export interface DelegationDiagnostics {
  /** delegate_task calls from the lead (fresh + continueTaskId follow-ups). */
  readonly delegations: number;
  readonly freshDelegations: number;
  readonly continuations: number;
  readonly blockedReports: number;
  readonly failedDelegations: number;
  /** Blocked or failed tasks after which the lead itself changed files. */
  readonly leadTakeovers: number;
}

const BLOCKED_REPORT = /^\s*Status:\s*blocked\b/im;

/**
 * Assumes each delegate_task call, including a continueTaskId follow-up, is one app-owned
 * subagent node on the lead, and a follow-up reuses the earlier task's child thread.
 * VERIFY against a live Sidekick run before the scored run.
 */
export function delegationDiagnostics(taskExport: Par3TaskExport): DelegationDiagnostics {
  const lead = taskExport.threads.find((thread) => thread.threadId === taskExport.leadThreadId);
  if (lead === undefined) {
    return {
      delegations: 0,
      freshDelegations: 0,
      continuations: 0,
      blockedReports: 0,
      failedDelegations: 0,
      leadTakeovers: 0,
    };
  }
  const delegated = lead.subagents.filter((subagent) => subagent.origin === "app_owned");
  const fresh = new Set(delegated.map((subagent) => subagent.childThreadId ?? subagent.id)).size;
  const blocked = delegated.filter(
    (subagent) => subagent.result !== null && BLOCKED_REPORT.test(subagent.result),
  );
  const failed = delegated.filter((subagent) => subagent.status === "failed");
  const editingRunStarts = lead.runs
    .filter((run) => lead.fileChangeRunIds.includes(run.id) && run.startedAt !== null)
    .map((run) => Date.parse(run.startedAt as string));
  const leadTakeovers = [...new Set([...blocked, ...failed])].filter((subagent) => {
    if (subagent.completedAt === null) return false;
    const endedAt = Date.parse(subagent.completedAt);
    return editingRunStarts.some((startedAt) => startedAt >= endedAt);
  }).length;
  return {
    delegations: delegated.length,
    freshDelegations: fresh,
    continuations: delegated.length - fresh,
    blockedReports: blocked.length,
    failedDelegations: failed.length,
    leadTakeovers,
  };
}
