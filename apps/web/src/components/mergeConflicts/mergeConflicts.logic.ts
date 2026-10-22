import type {
  MergeConflictListEntry,
  MergeConflictOperation,
  MergeConflictOperationRunResult,
  VcsConflictKind,
  VcsOperationKind,
} from "@t3tools/contracts";

export type ConflictSide = "ours" | "theirs";

const KIND_LABELS: Record<VcsConflictKind, string> = {
  "both-modified": "Both modified",
  "both-added": "Both added",
  "both-deleted": "Both deleted",
  "added-by-us": "Added by us",
  "added-by-them": "Added by them",
  "deleted-by-us": "Deleted by us",
  "deleted-by-them": "Deleted by them",
};

export function conflictKindLabel(kind: VcsConflictKind): string {
  return KIND_LABELS[kind];
}

/** Whether choosing `side` keeps the file or removes it, which is what the button should say. */
export function sideOutcome(kind: VcsConflictKind, side: ConflictSide): "keep" | "delete" {
  const missing: ReadonlyArray<VcsConflictKind> =
    side === "ours"
      ? ["deleted-by-us", "added-by-them", "both-deleted"]
      : ["deleted-by-them", "added-by-us", "both-deleted"];
  return missing.includes(kind) ? "delete" : "keep";
}

export interface ConflictRowActions {
  readonly ours: { readonly label: string };
  readonly theirs: { readonly label: string };
  /** Opens the file for merging; only text files with both sides present can be merged. */
  readonly canMerge: boolean;
  readonly canUseRecordedResolution: boolean;
}

export function conflictRowActions(
  entry: Pick<MergeConflictListEntry, "kind" | "fileLevelReason" | "rerereResolved">,
): ConflictRowActions {
  const sideLabel = (side: ConflictSide) =>
    `Accept ${side}${sideOutcome(entry.kind, side) === "delete" ? " (delete)" : ""}`;
  const fileLevelOnly = entry.fileLevelReason !== undefined;
  return {
    ours: { label: sideLabel("ours") },
    theirs: { label: sideLabel("theirs") },
    canMerge: !fileLevelOnly && (entry.kind === "both-modified" || entry.kind === "both-added"),
    canUseRecordedResolution: !fileLevelOnly && entry.rerereResolved === true,
  };
}

export function fileLevelReasonLabel(
  reason: NonNullable<MergeConflictListEntry["fileLevelReason"]>,
) {
  switch (reason) {
    case "binary":
      return "Binary file";
    case "too-large":
      return "Too large to merge here";
    case "filter":
      return "Filtered file (such as Git LFS)";
    case "special-file":
      return "Symlink or submodule";
  }
}

const OPERATION_TITLES: Record<VcsOperationKind, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

export function operationTitle(operation: VcsOperationKind | null): string {
  return operation === null ? "Conflicts" : OPERATION_TITLES[operation];
}

/**
 * Where the sides come from. During a rebase git swaps them, so the banner says which branch
 * each label is, instead of leaving "ours" to be read as the user's own work.
 */
export function sideDescriptions(operation: VcsOperationKind | null): {
  readonly ours: string;
  readonly theirs: string;
} {
  if (operation === "rebase") {
    return { ours: "Upstream, being rebased onto", theirs: "Your commit being replayed" };
  }
  if (operation === "merge") return { ours: "Current branch", theirs: "Incoming branch" };
  if (operation === "cherry-pick") return { ours: "Current branch", theirs: "Picked commit" };
  if (operation === "revert")
    return { ours: "Current branch", theirs: "Before the reverted commit" };
  return { ours: "Current", theirs: "Incoming" };
}

export function rebaseStepLabel(step: MergeConflictOperation["step"]): string | null {
  return step === undefined ? null : `Step ${step.current} of ${step.total}`;
}

export function continueLabel(operation: VcsOperationKind | null): string {
  return operation === null ? "Continue" : `Continue ${operation}`;
}

export function abortConfirmation(operation: VcsOperationKind | null) {
  const noun = operation ?? "operation";
  return {
    title: `Abort the ${noun}?`,
    description: `Git returns the repository to how it was before the ${noun} started. Resolutions you made so far are lost, and if the ${noun} was started outside Par3, uncommitted edits that existed beforehand can be discarded too.`,
    confirmLabel: `Abort ${noun}`,
  };
}

export function continueOutcomeToast(
  operation: VcsOperationKind | null,
  outcome: MergeConflictOperationRunResult["outcome"],
): { readonly type: "success" | "info"; readonly title: string; readonly description?: string } {
  const noun = operation ?? "operation";
  switch (outcome) {
    case "completed":
      return { type: "success", title: `The ${noun} is complete` };
    case "conflicts":
      return {
        type: "info",
        title: "Next step has conflicts",
        description: "Resolve them to keep going.",
      };
    case "paused":
      return {
        type: "info",
        title: `The ${noun} paused`,
        description: "Git stopped for you to review before continuing.",
      };
    case "aborted":
      return { type: "success", title: `The ${noun} was aborted` };
  }
}

/** Why mutations are off, or null when they are available. */
export function mutationBlockedReason(input: {
  readonly canWriteSourceControl: boolean;
  readonly turnRunningInRepository: boolean;
}): string | null {
  if (!input.canWriteSourceControl) return "This connection cannot change source control.";
  if (input.turnRunningInRepository) {
    return "An agent is working in this repository. Wait for it to finish, or stop it first.";
  }
  return null;
}

export interface ResolvedInOperation {
  /** Identifies the operation step the paths were resolved in. */
  readonly signature: string;
  readonly paths: ReadonlyArray<string>;
}

export const EMPTY_RESOLVED_IN_OPERATION: ResolvedInOperation = { signature: "", paths: [] };

export function operationSignature(
  operation: Pick<MergeConflictOperation, "kind" | "step"> | undefined,
): string {
  return operation === undefined ? "" : `${operation.kind}:${operation.step?.current ?? 0}`;
}

/**
 * Git keeps what Reopen needs only for the current step, so the list restarts when the operation
 * (or the rebase step) changes or ends.
 */
export function recordResolved(
  state: ResolvedInOperation,
  signature: string,
  path: string,
): ResolvedInOperation {
  const paths = state.signature === signature ? state.paths : [];
  return paths.includes(path) ? { signature, paths } : { signature, paths: [...paths, path] };
}

export function forgetResolved(state: ResolvedInOperation, path: string): ResolvedInOperation {
  return { signature: state.signature, paths: state.paths.filter((entry) => entry !== path) };
}

/** The resolved paths still worth offering Reopen for: same step, and not conflicted again. */
export function visibleResolved(
  state: ResolvedInOperation,
  signature: string,
  conflictedPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (signature === "" || state.signature !== signature) return [];
  return state.paths.filter((path) => !conflictedPaths.includes(path));
}

/**
 * The file's path relative to the thread's workspace root, which is what the file preview takes.
 * Null when the repository sits outside that root, so the preview cannot show it.
 */
export function fileMergePreviewPath(
  workspaceRoot: string | undefined,
  cwd: string,
  path: string,
): string | null {
  if (workspaceRoot === undefined) return null;
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const repository = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  if (repository === root) return path;
  return repository.startsWith(`${root}/`) ? `${repository.slice(root.length + 1)}/${path}` : null;
}
