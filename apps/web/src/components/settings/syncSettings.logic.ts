import {
  planSync,
  type SyncConflict,
  type SyncEnvironmentView,
  type SyncPlan,
} from "@t3tools/client-runtime/sync/plan";
import type { EnvironmentId, SyncSnapshot } from "@t3tools/contracts";

export interface EnvironmentSyncCounts {
  readonly pending: number;
  readonly conflicts: number;
}

export function environmentSyncCounts(
  plan: SyncPlan,
  environmentId: EnvironmentId,
): EnvironmentSyncCounts {
  return {
    pending: plan.opsByEnvironment.get(environmentId)?.length ?? 0,
    conflicts: plan.conflicts.filter((conflict) =>
      conflict.candidates.some((candidate) => candidate.environmentId === environmentId),
    ).length,
  };
}

/** Secrets are never shown, and MCP servers are stored as settings rather than as the text. */
const UNMERGEABLE_CATEGORIES = new Set(["vault", "mcpServers"]);

export interface SyncMergeSide {
  readonly hash: string;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

/**
 * The two versions a conflict can be merged from: a text file present everywhere in exactly two
 * versions. A deletion or a third version can only be settled by choosing.
 */
export function syncMergeSides(
  conflict: SyncConflict,
): readonly [SyncMergeSide, SyncMergeSide] | null {
  if (UNMERGEABLE_CATEGORIES.has(conflict.categoryId)) return null;
  const sides = new Map<string, EnvironmentId[]>();
  for (const candidate of conflict.candidates) {
    if (candidate.hash === null) return null;
    const environmentIds = sides.get(candidate.hash) ?? [];
    environmentIds.push(candidate.environmentId);
    sides.set(candidate.hash, environmentIds);
  }
  const [left, right, ...rest] = [...sides].map(([hash, environmentIds]) => ({
    hash,
    environmentIds,
  }));
  return left !== undefined && right !== undefined && rest.length === 0 ? [left, right] : null;
}

/** Categories a machine offers to sync by default: everything it can sync right now. */
export function defaultSyncCategories(snapshot: SyncSnapshot): string[] {
  return snapshot.categories.filter((category) => category.available).map(({ id }) => id);
}

/** The categories already shared by the machines a new one would join, that it can also sync. */
export function peerSyncCategories(
  peers: ReadonlyArray<SyncEnvironmentView>,
  snapshot: SyncSnapshot,
): string[] {
  const shared = new Set(peers.flatMap((peer) => peer.snapshot.participation?.categories ?? []));
  return defaultSyncCategories(snapshot).filter((id) => shared.has(id));
}

export interface JoinCategorySummary {
  readonly categoryId: string;
  /** Items the joining machine would receive or delete. */
  readonly incoming: number;
  /** Items the joining machine would share with the others. */
  readonly outgoing: number;
  /** Items that differ and need a decision. */
  readonly conflicts: number;
}

/**
 * What joining would do, from a plan over the participating peers and the candidate with its
 * proposed categories. Changes among the peers themselves are not the candidate's to report.
 */
export function summarizeSyncJoin(
  peers: ReadonlyArray<SyncEnvironmentView>,
  candidate: SyncEnvironmentView,
  categories: ReadonlyArray<string>,
): JoinCategorySummary[] {
  const proposed: SyncEnvironmentView = {
    environmentId: candidate.environmentId,
    snapshot: {
      ...candidate.snapshot,
      participation: {
        enabled: true,
        categories: [...categories],
        excluded: candidate.snapshot.participation?.excluded ?? [],
        decidedAt: candidate.snapshot.participation?.decidedAt ?? new Date(0).toISOString(),
      },
    },
  };
  const plan = planSync([
    ...peers.filter((peer) => peer.snapshot.participation?.enabled === true),
    proposed,
  ]);
  const counts = new Map(
    categories.map((categoryId) => [categoryId, { incoming: 0, outgoing: new Set<string>() }]),
  );
  const categoryOf = (key: string) => key.slice(0, key.indexOf(":"));
  for (const op of plan.opsByEnvironment.get(candidate.environmentId) ?? []) {
    if (op.action._tag === "adopt") continue;
    const entry = counts.get(categoryOf(op.key));
    if (entry) entry.incoming += 1;
  }
  for (const [environmentId, ops] of plan.opsByEnvironment) {
    if (environmentId === candidate.environmentId) continue;
    for (const op of ops) {
      if (op.action._tag !== "write" || op.action.sourceEnvironmentId !== candidate.environmentId)
        continue;
      counts.get(categoryOf(op.key))?.outgoing.add(op.key);
    }
  }
  return categories.map((categoryId) => ({
    categoryId,
    incoming: counts.get(categoryId)?.incoming ?? 0,
    outgoing: counts.get(categoryId)?.outgoing.size ?? 0,
    conflicts: plan.conflicts.filter(
      (conflict) =>
        conflict.categoryId === categoryId &&
        conflict.candidates.some((entry) => entry.environmentId === candidate.environmentId),
    ).length,
  }));
}
