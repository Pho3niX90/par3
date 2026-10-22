import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError, VcsConflictKind, VcsOperationKind } from "./git.ts";
import { VcsError } from "./vcs.ts";

const RepositoryPath = Schema.String.check(Schema.isNonEmpty());
const Oid = Schema.NullOr(Schema.String);

/**
 * "Ours" always means git's stage 2 and "theirs" stage 3. During a rebase git swaps what those
 * are (stage 2 is the branch being rebased onto, stage 3 the commit being replayed), so only
 * the labels differ, never the API.
 */
export const MergeConflictLabels = Schema.Struct({
  ours: Schema.String,
  theirs: Schema.String,
});
export type MergeConflictLabels = typeof MergeConflictLabels.Type;

export const MergeConflictOperation = Schema.Struct({
  kind: VcsOperationKind,
  /** Rebase progress (`rebase-merge/msgnum` of `end`). Absent for other operations. */
  step: Schema.optional(Schema.Struct({ current: NonNegativeInt, total: NonNegativeInt })),
});
export type MergeConflictOperation = typeof MergeConflictOperation.Type;

/** Blob ids of the three index stages; null when the stage does not exist. */
export const MergeConflictStageOids = Schema.Struct({
  base: Oid,
  ours: Oid,
  theirs: Oid,
});
export type MergeConflictStageOids = typeof MergeConflictStageOids.Type;

/**
 * What a client saw when it read a file. Mutations send it back and the server rejects them with
 * `MergeConflictStaleError` when the stages or the working copy moved since.
 */
export const MergeConflictExpected = Schema.Struct({
  stages: MergeConflictStageOids,
  /** Blob id of the working copy as read (no filters); null when the file was missing. */
  workingCopyHash: Oid,
});
export type MergeConflictExpected = typeof MergeConflictExpected.Type;

/** Why a file can only be resolved by taking a side or deleting it. */
export const MergeConflictFileLevelReason = Schema.Literals([
  "binary",
  "too-large",
  "filter",
  "special-file",
]);
export type MergeConflictFileLevelReason = typeof MergeConflictFileLevelReason.Type;

export const MergeConflictAutoResolveSkipReason = Schema.Literals([
  "binary",
  "too-large",
  "filter",
  "special-file",
  "merge-driver",
  "conflicts-remain",
  /** The working copy no longer holds git's markers, so someone already edited it. */
  "working-copy-edited",
]);
export type MergeConflictAutoResolveSkipReason = typeof MergeConflictAutoResolveSkipReason.Type;

export const MergeConflictListInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type MergeConflictListInput = typeof MergeConflictListInput.Type;

/**
 * A conflicted path with everything a file-level action needs, so a client can accept a side
 * without downloading the file: `expected` is what `resolve` checks.
 */
export const MergeConflictListEntry = Schema.Struct({
  path: RepositoryPath,
  kind: VcsConflictKind,
  expected: MergeConflictExpected,
  /** Set when only choosing a side or deleting is possible (known without reading contents). */
  fileLevelReason: Schema.optional(MergeConflictFileLevelReason),
  /**
   * The working copy holds no conflict markers, as after a rerere-recorded resolution (or an
   * unstaged manual edit). Resolving with `workingCopy` accepts it. Scanned for the first 1000 paths.
   */
  rerereResolved: Schema.optional(Schema.Boolean),
});
export type MergeConflictListEntry = typeof MergeConflictListEntry.Type;

export const MergeConflictListResult = Schema.Struct({
  /** Absent when unmerged paths exist without an operation, such as after `git stash pop`. */
  operation: Schema.optional(MergeConflictOperation),
  labels: MergeConflictLabels,
  conflicts: Schema.Array(MergeConflictListEntry),
  conflictCount: NonNegativeInt,
});
export type MergeConflictListResult = typeof MergeConflictListResult.Type;

export const MergeConflictReadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: RepositoryPath,
});
export type MergeConflictReadInput = typeof MergeConflictReadInput.Type;

export const MergeConflictReadResult = Schema.Struct({
  path: RepositoryPath,
  kind: VcsConflictKind,
  operation: Schema.optional(MergeConflictOperation),
  labels: MergeConflictLabels,
  expected: MergeConflictExpected,
  /** Stage texts; null when the stage is absent or `fileLevelReason` is set. */
  base: Schema.NullOr(Schema.String),
  ours: Schema.NullOr(Schema.String),
  theirs: Schema.NullOr(Schema.String),
  /** The file on disk, usually holding git's conflict markers. Null when missing or file-level. */
  workingCopy: Schema.NullOr(Schema.String),
  workingCopyHasMarkers: Schema.Boolean,
  /**
   * Git still lists the file as unmerged but its working copy has no markers, which is what a
   * rerere-recorded resolution looks like (or an edit that was never staged). Resolving with
   * `workingCopy` accepts it.
   */
  rerereResolved: Schema.Boolean,
  /** Line ending the working copy uses; content writes are converted to it. */
  lineEnding: Schema.Literals(["lf", "crlf"]),
  fileLevelReason: Schema.optional(MergeConflictFileLevelReason),
});
export type MergeConflictReadResult = typeof MergeConflictReadResult.Type;

export const MergeConflictResolution = Schema.Union([
  Schema.TaggedStruct("content", { content: Schema.String }),
  /** Takes stage 2 (`ours`) or stage 3 (`theirs`) wholesale; a missing side deletes the file. */
  Schema.TaggedStruct("side", { side: Schema.Literals(["ours", "theirs"]) }),
  Schema.TaggedStruct("delete", {}),
  /** Stages the working copy as it is. */
  Schema.TaggedStruct("workingCopy", {}),
]);
export type MergeConflictResolution = typeof MergeConflictResolution.Type;

export const MergeConflictResolveInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: RepositoryPath,
  expected: MergeConflictExpected,
  resolution: MergeConflictResolution,
});
export type MergeConflictResolveInput = typeof MergeConflictResolveInput.Type;

export const MergeConflictReopenInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: RepositoryPath,
});
export type MergeConflictReopenInput = typeof MergeConflictReopenInput.Type;

export const MergeConflictMutationResult = Schema.Struct({
  path: RepositoryPath,
  /** Unmerged paths left in the repository after the mutation. */
  remaining: NonNegativeInt,
});
export type MergeConflictMutationResult = typeof MergeConflictMutationResult.Type;

export const MergeConflictAutoResolveInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Defaults to every unmerged path. */
  paths: Schema.optional(Schema.Array(RepositoryPath)),
});
export type MergeConflictAutoResolveInput = typeof MergeConflictAutoResolveInput.Type;

export const MergeConflictAutoResolveResult = Schema.Struct({
  resolved: Schema.Array(RepositoryPath),
  skipped: Schema.Array(
    Schema.Struct({ path: RepositoryPath, reason: MergeConflictAutoResolveSkipReason }),
  ),
  remaining: NonNegativeInt,
});
export type MergeConflictAutoResolveResult = typeof MergeConflictAutoResolveResult.Type;

export const MergeConflictOperationRunInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: Schema.Literals(["continue", "abort"]),
});
export type MergeConflictOperationRunInput = typeof MergeConflictOperationRunInput.Type;

export const MergeConflictOperationRunResult = Schema.Struct({
  /**
   * - `completed`: the operation finished.
   * - `conflicts`: continuing stopped on the next step (a rebase) with new conflicts.
   * - `paused`: still in progress with nothing to resolve, such as a rebase `edit` stop.
   * - `aborted`: the operation was abandoned.
   */
  outcome: Schema.Literals(["completed", "conflicts", "paused", "aborted"]),
});
export type MergeConflictOperationRunResult = typeof MergeConflictOperationRunResult.Type;

export const MergeConflictStartLocalMergeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
});
export type MergeConflictStartLocalMergeInput = typeof MergeConflictStartLocalMergeInput.Type;

export const MergeConflictStartLocalMergeResult = Schema.Struct({
  outcome: Schema.Literals(["up-to-date", "merged", "conflicts"]),
  /** The ref that was merged in, after fetching the base. */
  mergedRef: Schema.String,
});
export type MergeConflictStartLocalMergeResult = typeof MergeConflictStartLocalMergeResult.Type;

export class MergeConflictError extends Schema.TaggedError<MergeConflictError>()(
  "MergeConflictError",
  {
    reason: Schema.Literals([
      "no-operation",
      "not-unmerged",
      "not-reopenable",
      "conflicts-remain",
      "dirty-working-tree",
      "operation-in-progress",
      "file-level-only",
      "content-too-large",
      "operation-failed",
    ]),
    path: Schema.optional(Schema.String),
    /** User-facing; for `operation-failed` it carries bounded git output (hooks, signing). */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The stages or working copy changed since the client read them; read the file again. */
export class MergeConflictStaleError extends Schema.TaggedError<MergeConflictStaleError>()(
  "MergeConflictStaleError",
  {
    path: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const MergeConflictRpcError = Schema.Union([
  MergeConflictError,
  MergeConflictStaleError,
  GitCommandError,
  VcsError,
]);
export type MergeConflictRpcError = typeof MergeConflictRpcError.Type;
