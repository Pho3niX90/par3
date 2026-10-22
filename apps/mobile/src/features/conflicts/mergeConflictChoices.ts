import type {
  MergeConflictListEntry,
  MergeConflictOperationRunResult,
  MergeConflictResolution,
  VcsConflictKind,
  VcsOperationKind,
} from "@t3tools/contracts";

export interface ConflictChoice {
  readonly label: string;
  readonly resolution: MergeConflictResolution;
}

const KIND_LABELS: Record<VcsConflictKind, string> = {
  "both-modified": "Both modified",
  "both-added": "Both added",
  "both-deleted": "Both deleted",
  "added-by-us": "Added by us",
  "added-by-them": "Added by them",
  "deleted-by-us": "Deleted by us",
  "deleted-by-them": "Deleted by them",
};

export const conflictKindLabel = (kind: VcsConflictKind) => KIND_LABELS[kind];

const OURS_MISSING: ReadonlySet<VcsConflictKind> = new Set([
  "deleted-by-us",
  "added-by-them",
  "both-deleted",
]);
const THEIRS_MISSING: ReadonlySet<VcsConflictKind> = new Set([
  "deleted-by-them",
  "added-by-us",
  "both-deleted",
]);

/**
 * What a tap on a file can do without ever downloading it. At most three, because an Android
 * alert holds three buttons; git's recorded resolution replaces nothing it needs, since
 * Cancel is a tap outside.
 */
export function conflictChoices(
  entry: Pick<MergeConflictListEntry, "kind" | "rerereResolved" | "fileLevelReason">,
): ReadonlyArray<ConflictChoice> {
  const ours: ConflictChoice = {
    label: OURS_MISSING.has(entry.kind) ? "Accept ours (delete)" : "Accept ours",
    resolution: { _tag: "side", side: "ours" },
  };
  const theirs: ConflictChoice = {
    label: THEIRS_MISSING.has(entry.kind) ? "Accept theirs (delete)" : "Accept theirs",
    resolution: { _tag: "side", side: "theirs" },
  };
  if (entry.rerereResolved === true && entry.fileLevelReason === undefined) {
    return [
      { label: "Use git's recorded resolution", resolution: { _tag: "workingCopy" } },
      ours,
      theirs,
    ];
  }
  return [ours, theirs];
}

export function abortCopy(operation: VcsOperationKind | null) {
  const noun = operation ?? "operation";
  return {
    title: `Abort the ${noun}?`,
    message: `Git returns the repository to how it was before the ${noun} started. Resolutions you made so far are lost, and if the ${noun} was started outside Par3, uncommitted edits that existed beforehand can be discarded too.`,
    confirmText: `Abort ${noun}`,
  };
}

export function operationOutcomeMessage(
  operation: VcsOperationKind | null,
  outcome: MergeConflictOperationRunResult["outcome"],
): string {
  const noun = operation ?? "operation";
  switch (outcome) {
    case "completed":
      return `The ${noun} is complete.`;
    case "conflicts":
      return "The next step has conflicts to resolve.";
    case "paused":
      return `The ${noun} paused for you to review.`;
    case "aborted":
      return `The ${noun} was aborted.`;
  }
}
