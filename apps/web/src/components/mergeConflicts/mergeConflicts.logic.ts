import type {
  MergeConflictListEntry,
  MergeConflictOperation,
  MergeConflictOperationRunResult,
  VcsConflictKind,
  VcsOperationKind,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";

export type ConflictSide = "ours" | "theirs";

const KIND_LABELS: Record<VcsConflictKind, string> = {
  "both-modified": msg("Both modified"),
  "both-added": msg("Both added"),
  "both-deleted": msg("Both deleted"),
  "added-by-us": msg("Added by us"),
  "added-by-them": msg("Added by them"),
  "deleted-by-us": msg("Deleted by us"),
  "deleted-by-them": msg("Deleted by them"),
};

export function conflictKindLabel(kind: VcsConflictKind): string {
  return m(KIND_LABELS[kind]);
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
  const sideLabel = (side: ConflictSide) => {
    const deletes = sideOutcome(entry.kind, side) === "delete";
    if (side === "ours") return m(deletes ? msg("Accept ours (delete)") : msg("Accept ours"));
    return m(deletes ? msg("Accept theirs (delete)") : msg("Accept theirs"));
  };
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
      return m(msg("Binary file"));
    case "too-large":
      return m(msg("Too large to merge here"));
    case "filter":
      return m(msg("Filtered file (such as Git LFS)"));
    case "special-file":
      return m(msg("Symlink or submodule"));
  }
}

const OPERATION_TITLES: Record<VcsOperationKind, string> = {
  merge: msg("Merge"),
  rebase: msg("Rebase"),
  "cherry-pick": msg("Cherry-pick"),
  revert: msg("Revert"),
};

export function operationTitle(operation: VcsOperationKind | null): string {
  return operation === null ? m(msg("Conflicts")) : m(OPERATION_TITLES[operation]);
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
    return {
      ours: m(msg("Upstream, being rebased onto")),
      theirs: m(msg("Your commit being replayed")),
    };
  }
  if (operation === "merge") {
    return { ours: m(msg("Current branch")), theirs: m(msg("Incoming branch")) };
  }
  if (operation === "cherry-pick") {
    return { ours: m(msg("Current branch")), theirs: m(msg("Picked commit")) };
  }
  if (operation === "revert") {
    return { ours: m(msg("Current branch")), theirs: m(msg("Before the reverted commit")) };
  }
  return { ours: m(msg("Current")), theirs: m(msg("Incoming")) };
}

export function rebaseStepLabel(step: MergeConflictOperation["step"]): string | null {
  return step === undefined
    ? null
    : m(msg("Step {current} of {total}", { current: step.current, total: step.total }));
}

export function continueLabel(operation: VcsOperationKind | null): string {
  return operation === null ? m(msg("Continue")) : m(msg("Continue {operation}", { operation }));
}

export function abortConfirmation(operation: VcsOperationKind | null) {
  const noun = operation ?? "operation";
  return {
    title: m(msg("Abort the {noun}?", { noun })),
    description: m(
      msg(
        "Git returns the repository to how it was before the {noun} started. Resolutions you made so far are lost, and if the {noun} was started outside Par3, uncommitted edits that existed beforehand can be discarded too.",
        { noun },
      ),
    ),
    confirmLabel: m(msg("Abort {noun}", { noun })),
  };
}

export function continueOutcomeToast(
  operation: VcsOperationKind | null,
  outcome: MergeConflictOperationRunResult["outcome"],
): { readonly type: "success" | "info"; readonly title: string; readonly description?: string } {
  const noun = operation ?? "operation";
  switch (outcome) {
    case "completed":
      return { type: "success", title: m(msg("The {noun} is complete", { noun })) };
    case "conflicts":
      return {
        type: "info",
        title: m(msg("Next step has conflicts")),
        description: m(msg("Resolve them to keep going.")),
      };
    case "paused":
      return {
        type: "info",
        title: m(msg("The {noun} paused", { noun })),
        description: m(msg("Git stopped for you to review before continuing.")),
      };
    case "aborted":
      return { type: "success", title: m(msg("The {noun} was aborted", { noun })) };
  }
}

/** Why mutations are off, or null when they are available. */
export function mutationBlockedReason(input: {
  readonly canWriteSourceControl: boolean;
  readonly turnRunningInRepository: boolean;
}): string | null {
  if (!input.canWriteSourceControl) return m(msg("This connection cannot change source control."));
  if (input.turnRunningInRepository) {
    return m(
      msg("An agent is working in this repository. Wait for it to finish, or stop it first."),
    );
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
