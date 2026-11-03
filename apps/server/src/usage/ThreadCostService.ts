import {
  type ThreadCost,
  type ThreadCostInput,
  type ThreadCostLine,
  type ThreadCostScope,
  type ThreadId,
  UsageDay,
  type UsageBucket,
  type UsageProviderKind,
  UsageReadError,
  type UsageSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BUILT_IN_USAGE_DRIVERS } from "../provider/builtInDrivers.ts";
import * as UsageService from "./UsageService.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const encodeThreadIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export function usageProvidersByDriver(
  drivers: readonly {
    readonly driverKind: string;
    readonly usage?: { readonly provider: UsageProviderKind };
  }[],
): ReadonlyMap<string, UsageProviderKind> {
  return new Map(
    drivers.flatMap(({ driverKind, usage }) =>
      usage === undefined ? [] : [[driverKind, usage.provider] as const],
    ),
  );
}

const USAGE_PROVIDER_BY_DRIVER = usageProvidersByDriver(BUILT_IN_USAGE_DRIVERS);

export interface ThreadConversationRow {
  readonly thread_id: string;
  readonly provider_thread_id: string;
  readonly driver: string;
  readonly created_at: string | null;
  readonly native_id: string | null;
}

export interface ThreadConversations {
  readonly scope: UsageService.UsageSessionScope;
  readonly ownSessions: ReadonlySet<string>;
  readonly untrackedConversations: number;
  readonly firstCountedMs: number | null;
}

const sessionKey = (provider: string, sessionId: string) => `${provider}\u0000${sessionId}`;

/**
 * A conversation's first instant is its provider thread's creation, not the transcript's start, so
 * history a fork inherited stays with the parent. A session both a thread and its sub-agent report
 * counts once, under the thread.
 */
export function planThreadConversations(
  threadId: ThreadId,
  rows: readonly ThreadConversationRow[],
): ThreadConversations {
  const scope = new Map<UsageProviderKind, Map<string, number>>();
  const ownSessions = new Set<string>();
  const untracked = new Set<string>();
  let firstCountedMs: number | null = null;
  for (const row of rows) {
    const provider = USAGE_PROVIDER_BY_DRIVER.get(row.driver);
    if (provider === undefined) {
      untracked.add(row.provider_thread_id);
      continue;
    }
    if (row.native_id === null) continue;
    const createdAt = DateTime.make(row.created_at ?? "");
    if (Option.isNone(createdAt)) {
      untracked.add(row.provider_thread_id);
      continue;
    }
    const createdAtMs = DateTime.toEpochMillis(createdAt.value);
    const sessions = scope.get(provider) ?? new Map<string, number>();
    scope.set(provider, sessions);
    const previous = sessions.get(row.native_id);
    sessions.set(
      row.native_id,
      previous === undefined ? createdAtMs : Math.min(previous, createdAtMs),
    );
    if (row.thread_id === threadId) ownSessions.add(sessionKey(provider, row.native_id));
    firstCountedMs = firstCountedMs === null ? createdAtMs : Math.min(firstCountedMs, createdAtMs);
  }
  return { scope, ownSessions, untrackedConversations: untracked.size, firstCountedMs };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function mergedCostSource(
  current: ThreadCostLine["costSource"],
  next: ThreadCostLine["costSource"],
): ThreadCostLine["costSource"] {
  return current === next ? current : "modelPriced";
}

function summarizeScope(
  threadCount: number,
  buckets: readonly UsageBucket[],
  nativeAgentCount = 0,
): ThreadCostScope {
  const lines = new Map<string, ThreadCostLine>();
  for (const bucket of buckets) {
    const key = `${bucket.provider}\u0000${bucket.model}`;
    const line = lines.get(key);
    lines.set(key, {
      provider: bucket.provider,
      model: bucket.model,
      totals: {
        uncachedInputTokens:
          (line?.totals.uncachedInputTokens ?? 0) + bucket.totals.uncachedInputTokens,
        cachedInputTokens: (line?.totals.cachedInputTokens ?? 0) + bucket.totals.cachedInputTokens,
        cacheCreationTokens:
          (line?.totals.cacheCreationTokens ?? 0) + bucket.totals.cacheCreationTokens,
        outputTokens: (line?.totals.outputTokens ?? 0) + bucket.totals.outputTokens,
        reasoningTokens: (line?.totals.reasoningTokens ?? 0) + bucket.totals.reasoningTokens,
      },
      costUsd: (line?.costUsd ?? 0) + bucket.costUsd,
      costSource:
        line === undefined
          ? bucket.costSource
          : mergedCostSource(line.costSource, bucket.costSource),
      records: (line?.records ?? 0) + bucket.records,
      unpricedRecords: (line?.unpricedRecords ?? 0) + bucket.unpricedRecords,
    });
  }
  const models = [...lines.values()]
    .toSorted((a, b) => b.costUsd - a.costUsd || a.model.localeCompare(b.model))
    .map((line) => ({ ...line, costUsd: roundUsd(line.costUsd) }));
  return {
    threadCount,
    ...(nativeAgentCount === 0 ? {} : { nativeAgentCount }),
    costUsd: roundUsd(buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0)),
    models,
  };
}

export function summarizeThreadCost(input: {
  readonly threadId: ThreadId;
  readonly readAt: string;
  readonly threadCount: number;
  readonly conversations: ThreadConversations;
  readonly summary: UsageSummary | null;
}): ThreadCost {
  const { conversations, summary } = input;
  const buckets = summary?.buckets ?? [];
  const seen = new Set<string>();
  const own: UsageBucket[] = [];
  const subagent: UsageBucket[] = [];
  const nativeAgents = new Set<string>();
  for (const bucket of buckets) {
    const { sessionId, nativeSubagentId } = UsageService.decodeScopedUsageSource(
      bucket.sourcePath ?? "",
    );
    const key = sessionKey(bucket.provider, sessionId);
    seen.add(key);
    if (nativeSubagentId !== null) nativeAgents.add(`${key}\u0000${nativeSubagentId}`);
    (nativeSubagentId === null && conversations.ownSessions.has(key) ? own : subagent).push(bucket);
  }
  let knownSessions = 0;
  let conversationsWithoutUsage = 0;
  for (const [provider, sessions] of conversations.scope) {
    for (const sessionId of sessions.keys()) {
      knownSessions += 1;
      if (!seen.has(sessionKey(provider, sessionId))) conversationsWithoutUsage += 1;
    }
  }
  const unreadableSources = (summary?.sources ?? []).filter(
    (source) => source.status === "partial" || source.status === "failed",
  ).length;
  const unpricedRecords = buckets.reduce((sum, bucket) => sum + bucket.unpricedRecords, 0);
  const totalCostUsd = buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);
  return {
    threadId: input.threadId,
    readAt: input.readAt,
    totalCostUsd: roundUsd(totalCostUsd),
    thread: summarizeScope(1, own),
    subagents: summarizeScope(input.threadCount - 1, subagent, nativeAgents.size),
    coverage: {
      complete:
        knownSessions + conversations.untrackedConversations > 0 &&
        conversations.untrackedConversations === 0 &&
        conversationsWithoutUsage === 0 &&
        unreadableSources === 0 &&
        unpricedRecords === 0,
      untrackedConversations: conversations.untrackedConversations,
      conversationsWithoutUsage,
      unreadableSources,
      unpricedRecords,
    },
    pricing: summary?.pricing ?? null,
  };
}

export class ThreadCostService extends Context.Service<
  ThreadCostService,
  {
    readonly read: (input: ThreadCostInput) => Effect.Effect<ThreadCost, UsageReadError>;
  }
>()("t3/usage/ThreadCostService") {}

const scanFailed = (cause: unknown) =>
  new UsageReadError({
    reason: "scanFailed",
    detail: "The thread's provider conversations could not be read.",
    cause,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService.UsageService;

  // Sub-agent threads are spend the thread caused. A fork is its own line of work, so it stops here.
  const readThreadTree = (threadId: ThreadId) =>
    sql<{ readonly thread_id: string }>`
      WITH RECURSIVE tree(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
        UNION
        SELECT child.thread_id
        FROM orchestration_v2_projection_threads AS child
        JOIN tree ON json_extract(child.payload_json, '$.lineage.parentThreadId') = tree.thread_id
        WHERE json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
      )
      SELECT thread_id FROM tree
    `.pipe(NodeSqliteClient.readOnly, Effect.mapError(scanFailed));

  // Attempts keep a session the provider thread later replaced, such as after a failed resume.
  const readConversations = (threadIds: readonly string[]) => {
    const threadIdsJson = encodeThreadIds(threadIds);
    return sql<ThreadConversationRow>`
      SELECT provider_thread.thread_id,
        provider_thread.provider_thread_id,
        provider_thread.provider AS driver,
        json_extract(provider_thread.payload_json, '$.createdAt') AS created_at,
        json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId') AS native_id
      FROM orchestration_v2_projection_provider_threads AS provider_thread
      WHERE provider_thread.thread_id IN (SELECT value FROM json_each(${threadIdsJson}))
      UNION
      SELECT provider_thread.thread_id,
        provider_thread.provider_thread_id,
        provider_thread.provider AS driver,
        json_extract(provider_thread.payload_json, '$.createdAt') AS created_at,
        json_extract(attempt.payload_json, '$.nativeThreadId') AS native_id
      FROM orchestration_v2_projection_run_attempts AS attempt
      JOIN orchestration_v2_projection_provider_threads AS provider_thread
        ON provider_thread.provider_thread_id = attempt.provider_thread_id
      WHERE provider_thread.thread_id IN (SELECT value FROM json_each(${threadIdsJson}))
    `.pipe(NodeSqliteClient.readOnly, Effect.mapError(scanFailed));
  };

  const read = Effect.fn("ThreadCostService.read")(function* (input: ThreadCostInput) {
    const tree = yield* readThreadTree(input.threadId);
    if (tree.length === 0) {
      return yield* new UsageReadError({
        reason: "threadNotFound",
        detail: `Thread ${input.threadId} is no longer available.`,
      });
    }
    const conversations = planThreadConversations(
      input.threadId,
      yield* readConversations(tree.map((row) => row.thread_id)),
    );
    const now = yield* DateTime.now;
    const summary =
      conversations.firstCountedMs === null
        ? null
        : yield* usage.readSessions(
            {
              timeZone: "UTC",
              sinceDay: utcDay(conversations.firstCountedMs),
              // A day ahead so usage written while this read runs is not cut off at midnight.
              untilDay: utcDay(DateTime.toEpochMillis(now) + DAY_MS),
              // This read answers one question once, so it waits for slow sources.
              awaitRefresh: true,
            },
            conversations.scope,
          );
    return summarizeThreadCost({
      threadId: input.threadId,
      readAt: DateTime.formatIso(now),
      threadCount: tree.length,
      conversations,
      summary,
    });
  });

  return ThreadCostService.of({ read });
});

function utcDay(epochMs: number): UsageDay {
  return UsageDay.make(DateTime.formatIso(DateTime.makeUnsafe(epochMs)).slice(0, 10));
}

export const layer = Layer.effect(ThreadCostService, make);
