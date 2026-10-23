import {
  type EnvironmentId,
  type SyncApplyOp,
  type SyncBaseline,
  type SyncSnapshot,
  splitSyncItemKey,
} from "@t3tools/contracts";

/**
 * Reconciles what several environments share. Each environment remembers, per item, the version
 * it last agreed on (its baseline). An item that changed on exactly one side moves forward to the
 * others; anything ambiguous is a conflict for a person to resolve, never a silent overwrite.
 *
 * Joining is not special: a machine with no baselines follows the same rules, so an identical
 * file is adopted, a missing one is copied, and a different one is a conflict.
 */

export interface SyncEnvironmentView {
  readonly environmentId: EnvironmentId;
  readonly snapshot: SyncSnapshot;
}

export type PlannedAction =
  | { readonly _tag: "write"; readonly sourceEnvironmentId: EnvironmentId }
  /** Contents no machine has yet, such as a merge of two versions. */
  | { readonly _tag: "content"; readonly contents: string }
  | { readonly _tag: "delete" }
  | { readonly _tag: "adopt" };

export interface PlannedOp {
  readonly key: string;
  readonly expectedHash: string | null;
  readonly action: PlannedAction;
  readonly baseline: SyncBaseline;
}

export interface SyncConflict {
  readonly key: string;
  readonly categoryId: string;
  readonly name: string;
  readonly candidates: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly hash: string | null;
  }>;
}

export interface SyncPlan {
  readonly opsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<PlannedOp>>;
  readonly conflicts: ReadonlyArray<SyncConflict>;
  /** Items every participant already agrees on. */
  readonly inSync: number;
}

interface Participant {
  readonly environmentId: EnvironmentId;
  readonly current: string | null;
  readonly baseline: SyncBaseline | undefined;
}

// Planning runs on every snapshot, so items are looked up by key rather than scanned per item.
const itemIndexes = new WeakMap<SyncSnapshot, ReadonlyMap<string, SyncSnapshot["items"][number]>>();
function itemIndex(snapshot: SyncSnapshot) {
  let index = itemIndexes.get(snapshot);
  if (index === undefined) {
    index = new Map(snapshot.items.map((item) => [item.key, item]));
    itemIndexes.set(snapshot, index);
  }
  return index;
}

/** Whether `environmentId` takes part in syncing `key` right now. */
function participates(snapshot: SyncSnapshot, key: string, categoryId: string): boolean {
  const participation = snapshot.participation;
  if (participation === null || !participation.enabled) return false;
  if (!participation.categories.includes(categoryId)) return false;
  if (participation.excluded.includes(key)) return false;
  const category = snapshot.categories.find((candidate) => candidate.id === categoryId);
  if (category === undefined || !category.available) return false;
  return itemIndex(snapshot).get(key)?.skipped === undefined;
}

function participantsFor(
  environments: ReadonlyArray<SyncEnvironmentView>,
  key: string,
  categoryId: string,
): Participant[] {
  return environments
    .filter((environment) => participates(environment.snapshot, key, categoryId))
    .map((environment) => ({
      environmentId: environment.environmentId,
      current: itemIndex(environment.snapshot).get(key)?.hash ?? null,
      baseline: environment.snapshot.baselines[key],
    }));
}

function allKeys(environments: ReadonlyArray<SyncEnvironmentView>): string[] {
  const keys = new Set<string>();
  for (const { snapshot } of environments) {
    for (const item of snapshot.items) keys.add(item.key);
    for (const key of Object.keys(snapshot.baselines)) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * Ops that bring every participant to `target`, copying from whoever already has it, or writing
 * `contents` when given.
 */
function converge(
  key: string,
  participants: ReadonlyArray<Participant>,
  target: SyncBaseline,
  contents?: string,
): Array<[EnvironmentId, PlannedOp]> | null {
  const source =
    target.hash === null || contents !== undefined
      ? undefined
      : participants.find((participant) => participant.current === target.hash);
  if (target.hash !== null && contents === undefined && source === undefined) return null;
  const ops: Array<[EnvironmentId, PlannedOp]> = [];
  for (const participant of participants) {
    const atTarget =
      participant.baseline?.hash === target.hash && participant.baseline.rev === target.rev;
    if (participant.current === target.hash) {
      if (!atTarget) {
        ops.push([
          participant.environmentId,
          { key, expectedHash: participant.current, action: { _tag: "adopt" }, baseline: target },
        ]);
      }
      continue;
    }
    ops.push([
      participant.environmentId,
      {
        key,
        expectedHash: participant.current,
        action:
          target.hash === null
            ? { _tag: "delete" }
            : contents !== undefined
              ? { _tag: "content", contents }
              : { _tag: "write", sourceEnvironmentId: source!.environmentId },
        baseline: target,
      },
    ]);
  }
  return ops;
}

export function planSync(environments: ReadonlyArray<SyncEnvironmentView>): SyncPlan {
  const opsByEnvironment = new Map<EnvironmentId, PlannedOp[]>();
  const conflicts: SyncConflict[] = [];
  let inSync = 0;

  for (const key of allKeys(environments)) {
    const parts = splitSyncItemKey(key);
    if (parts === null) continue;
    const participants = participantsFor(environments, key, parts.categoryId);
    if (participants.length < 2) continue;

    const conflict = () =>
      conflicts.push({
        key,
        categoryId: parts.categoryId,
        name: parts.name,
        candidates: participants.map((participant) => ({
          environmentId: participant.environmentId,
          hash: participant.current,
        })),
      });

    const baselines = participants.flatMap((participant) =>
      participant.baseline === undefined ? [] : [participant.baseline],
    );
    const headRev = Math.max(-1, ...baselines.map((baseline) => baseline.rev));
    const headHashes = new Set(
      baselines.filter((baseline) => baseline.rev === headRev).map((baseline) => baseline.hash),
    );
    // Two groups of machines moved the item to the same version number independently.
    if (headHashes.size > 1) {
      conflict();
      continue;
    }
    const head: SyncBaseline | undefined =
      headRev < 0 ? undefined : { hash: [...headHashes][0] ?? null, rev: headRev };

    const dirty = participants.filter((participant) =>
      participant.baseline === undefined
        ? participant.current !== null
        : participant.current !== participant.baseline.hash,
    );
    // A change that already matches the agreed version needs no decision.
    const divergent = dirty.filter(
      (participant) => head === undefined || participant.current !== head.hash,
    );

    let target: SyncBaseline | undefined;
    if (divergent.length === 0) {
      target = head;
    } else {
      const values = new Set(divergent.map((participant) => participant.current));
      const allFromHead = divergent.every((participant) =>
        head === undefined
          ? participant.baseline === undefined
          : participant.baseline?.rev === head.rev,
      );
      if (values.size !== 1 || !allFromHead) {
        conflict();
        continue;
      }
      target = { hash: [...values][0] ?? null, rev: (head?.rev ?? 0) + 1 };
    }
    if (target === undefined) continue;

    const ops = converge(key, participants, target);
    if (ops === null) continue;
    if (ops.length === 0) {
      inSync += 1;
      continue;
    }
    for (const [environmentId, op] of ops) {
      const list = opsByEnvironment.get(environmentId) ?? [];
      list.push(op);
      opsByEnvironment.set(environmentId, list);
    }
  }

  return { opsByEnvironment, conflicts, inSync };
}

/** Contents written to every machine, with their hash as the servers compute it. */
export interface SyncMergedVersion {
  readonly contents: string;
  readonly hash: string;
}

/**
 * Ops that settle a conflict on one machine's version, on merged contents, or on deleting the
 * item everywhere.
 */
export function planConflictResolution(
  environments: ReadonlyArray<SyncEnvironmentView>,
  key: string,
  winner: EnvironmentId | "delete" | SyncMergedVersion,
): ReadonlyMap<EnvironmentId, ReadonlyArray<PlannedOp>> {
  const parts = splitSyncItemKey(key);
  const result = new Map<EnvironmentId, PlannedOp[]>();
  if (parts === null) return result;
  const participants = participantsFor(environments, key, parts.categoryId);
  const hash =
    winner === "delete"
      ? null
      : typeof winner === "object"
        ? winner.hash
        : (participants.find((participant) => participant.environmentId === winner)?.current ??
          null);
  const rev = Math.max(0, ...participants.map((participant) => participant.baseline?.rev ?? 0)) + 1;
  const contents = typeof winner === "object" ? winner.contents : undefined;
  for (const [environmentId, op] of converge(key, participants, { hash, rev }, contents) ?? []) {
    const list = result.get(environmentId) ?? [];
    list.push(op);
    result.set(environmentId, list);
  }
  return result;
}

export interface SyncTransport {
  readonly read: (
    environmentId: EnvironmentId,
    key: string,
  ) => Promise<{ readonly contents: string; readonly hash: string }>;
  readonly apply: (
    environmentId: EnvironmentId,
    ops: ReadonlyArray<SyncApplyOp>,
  ) => Promise<{
    readonly results: ReadonlyArray<{ readonly key: string; readonly status: string }>;
  }>;
}

export interface SyncRunResult {
  readonly applied: number;
  readonly stale: number;
  readonly rejected: number;
  readonly failed: number;
}

const APPLY_BATCH = 200;

/**
 * Carries each item from its source to the machines that need it. A target that changed since
 * the plan reports the item as stale and is left alone; the next snapshot plans it again.
 */
export async function runSyncPlan(
  opsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<PlannedOp>>,
  transport: SyncTransport,
): Promise<SyncRunResult> {
  const contents = new Map<string, Promise<{ contents: string; hash: string } | null>>();
  const readOnce = (environmentId: EnvironmentId, key: string) => {
    const cacheKey = `${environmentId}\u0000${key}`;
    let pending = contents.get(cacheKey);
    if (pending === undefined) {
      pending = transport.read(environmentId, key).catch(() => null);
      contents.set(cacheKey, pending);
    }
    return pending;
  };

  let applied = 0;
  let stale = 0;
  let rejected = 0;
  let failed = 0;
  await Promise.all(
    [...opsByEnvironment].map(async ([environmentId, planned]) => {
      const ops: SyncApplyOp[] = [];
      for (const op of planned) {
        if (op.action._tag === "content") {
          ops.push({ ...op, action: { _tag: "write", contents: op.action.contents } });
          continue;
        }
        if (op.action._tag !== "write") {
          ops.push({ ...op, action: op.action });
          continue;
        }
        const source = await readOnce(op.action.sourceEnvironmentId, op.key);
        // The source moved on since the plan; its next snapshot replans this item.
        if (source === null || source.hash !== op.baseline.hash) {
          failed += 1;
          continue;
        }
        ops.push({ ...op, action: { _tag: "write", contents: source.contents } });
      }
      for (let index = 0; index < ops.length; index += APPLY_BATCH) {
        const batch = ops.slice(index, index + APPLY_BATCH);
        try {
          const { results } = await transport.apply(environmentId, batch);
          for (const result of results) {
            if (result.status === "applied") applied += 1;
            else if (result.status === "stale") stale += 1;
            else rejected += 1;
          }
        } catch {
          failed += batch.length;
        }
      }
    }),
  );
  return { applied, stale, rejected, failed };
}
