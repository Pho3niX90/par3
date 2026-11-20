import { mergeOperationNoun } from "@t3tools/client-runtime/state/merge-conflict-state";
import type {
  MergeConflictListEntry,
  MergeConflictOperationRunResult,
  MergeConflictResolution,
  VcsConflictKind,
  VcsOperationKind,
} from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export interface ConflictChoice {
  readonly label: string;
  readonly resolution: MergeConflictResolution;
}

const KIND_LABELS: Record<VcsConflictKind, string> = {
  "both-modified": msg("Both modified"),
  "both-added": msg("Both added"),
  "both-deleted": msg("Both deleted"),
  "added-by-us": msg("Added by us"),
  "added-by-them": msg("Added by them"),
  "deleted-by-us": msg("Deleted by us"),
  "deleted-by-them": msg("Deleted by them"),
};

export const conflictKindLabel = (kind: VcsConflictKind, resolve: MessageResolver = m) =>
  resolve(KIND_LABELS[kind]);

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
  resolve: MessageResolver = m,
): ReadonlyArray<ConflictChoice> {
  const ours: ConflictChoice = {
    label: OURS_MISSING.has(entry.kind)
      ? resolve(msg("Accept ours (delete)"))
      : resolve(msg("Accept ours")),
    resolution: { _tag: "side", side: "ours" },
  };
  const theirs: ConflictChoice = {
    label: THEIRS_MISSING.has(entry.kind)
      ? resolve(msg("Accept theirs (delete)"))
      : resolve(msg("Accept theirs")),
    resolution: { _tag: "side", side: "theirs" },
  };
  if (entry.rerereResolved === true && entry.fileLevelReason === undefined) {
    return [
      {
        label: resolve(msg("Use git's recorded resolution")),
        resolution: { _tag: "workingCopy" },
      },
      ours,
      theirs,
    ];
  }
  return [ours, theirs];
}

const operationNoun = (operation: VcsOperationKind | null, resolve: MessageResolver) =>
  operation === null ? resolve(msg("operation")) : mergeOperationNoun(operation, resolve);

export function abortCopy(operation: VcsOperationKind | null, resolve: MessageResolver = m) {
  const noun = operationNoun(operation, resolve);
  return {
    title: resolve(msg("Abort the {noun}?"), { noun }),
    message: resolve(
      msg(
        "Git returns the repository to how it was before the {noun} started. Resolutions you made so far are lost, and if the {noun} was started outside Par3, uncommitted edits that existed beforehand can be discarded too.",
      ),
      { noun },
    ),
    confirmText: resolve(msg("Abort {noun}"), { noun }),
  };
}

export function operationOutcomeMessage(
  operation: VcsOperationKind | null,
  outcome: MergeConflictOperationRunResult["outcome"],
  resolve: MessageResolver = m,
): string {
  const noun = operationNoun(operation, resolve);
  switch (outcome) {
    case "completed":
      return resolve(msg("The {noun} is complete."), { noun });
    case "conflicts":
      return resolve(msg("The next step has conflicts to resolve."));
    case "paused":
      return resolve(msg("The {noun} paused for you to review."), { noun });
    case "aborted":
      return resolve(msg("The {noun} was aborted."), { noun });
  }
}
