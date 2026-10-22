import type { VcsOperationKind, VcsStatusLocalResult } from "@t3tools/contracts";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";

export interface MergeConflictState {
  /** Null when no merge, rebase, cherry-pick or revert is in progress. */
  readonly operation: VcsOperationKind | null;
  /** Unmerged paths, from the status `conflictCount` (the listed paths are capped). */
  readonly conflictCount: number;
  /** An operation is in progress and nothing is left to resolve. */
  readonly canContinue: boolean;
  /** Something needs the resolver: an operation, or unmerged paths without one. */
  readonly needsResolution: boolean;
}

export const NO_MERGE_CONFLICT_STATE: MergeConflictState = {
  operation: null,
  conflictCount: 0,
  canContinue: false,
  needsResolution: false,
};

type ConflictStatus = Pick<VcsStatusLocalResult, "operation" | "conflictCount" | "conflicts">;

/**
 * Reads the resolver state from a status snapshot. Servers that predate the resolver never send
 * `operation` or `conflicts`, so they yield the idle state and the resolver stays out of sight.
 */
export function selectMergeConflictState(
  status: ConflictStatus | null | undefined,
): MergeConflictState {
  if (status === null || status === undefined) return NO_MERGE_CONFLICT_STATE;
  const operation = status.operation?.kind ?? null;
  const conflictCount = status.conflictCount ?? status.conflicts?.length ?? 0;
  if (operation === null && conflictCount === 0) return NO_MERGE_CONFLICT_STATE;
  return {
    operation,
    conflictCount,
    canContinue: operation !== null && conflictCount === 0,
    needsResolution: true,
  };
}

/** Adds up repositories, as a thread header does for a folder that holds several. */
export function sumMergeConflictStates(
  states: ReadonlyArray<MergeConflictState>,
): MergeConflictState {
  let operation: VcsOperationKind | null = null;
  let conflictCount = 0;
  let needsResolution = false;
  let anyConflicts = false;
  for (const state of states) {
    operation ??= state.operation;
    conflictCount += state.conflictCount;
    needsResolution ||= state.needsResolution;
    anyConflicts ||= state.conflictCount > 0;
  }
  if (!needsResolution) return NO_MERGE_CONFLICT_STATE;
  return {
    operation,
    conflictCount,
    canContinue: operation !== null && !anyConflicts,
    needsResolution,
  };
}

const OPERATION_NOUNS: Record<VcsOperationKind, string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
};

export function mergeOperationNoun(operation: VcsOperationKind | null): string {
  return operation === null ? "conflict resolution" : OPERATION_NOUNS[operation];
}

type RunningTurnThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "projectId" | "worktreePath" | "runtime" | "archivedAt"
>;

interface RunningTurnProject {
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly id: EnvironmentThreadShell["projectId"];
  readonly workspaceRoot: string;
}

const normalizeCwd = (value: string) => {
  const slashed = value.replaceAll("\\", "/");
  return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
};

const isSameOrInside = (inner: string, outer: string) =>
  inner === outer || outer === "/" || inner.startsWith(`${outer}/`);

/**
 * Whether any thread in the environment has a turn in flight in a folder that contains, or sits
 * inside, `cwd`. An agent in a parent folder or a child repository can run git against this
 * repository too, so resolving by hand while it works would race its own merge.
 */
export function hasRunningTurnInRepository(input: {
  readonly environmentId: EnvironmentThreadShell["environmentId"];
  readonly cwd: string;
  readonly threads: ReadonlyArray<RunningTurnThread>;
  readonly projects: ReadonlyArray<RunningTurnProject>;
}): boolean {
  const cwd = normalizeCwd(input.cwd);
  const roots = new Map(
    input.projects
      .filter((project) => project.environmentId === input.environmentId)
      .map((project) => [project.id, project.workspaceRoot] as const),
  );
  return input.threads.some((thread) => {
    if (
      thread.environmentId !== input.environmentId ||
      thread.archivedAt !== null ||
      !threadRuntimeIsActive(thread.runtime)
    ) {
      return false;
    }
    const threadCwd = thread.worktreePath ?? roots.get(thread.projectId);
    if (threadCwd === undefined) return false;
    const normalized = normalizeCwd(threadCwd);
    return isSameOrInside(cwd, normalized) || isSameOrInside(normalized, cwd);
  });
}
