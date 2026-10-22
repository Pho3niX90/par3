import type { MergeConflictStartLocalMergeResult } from "@t3tools/contracts";

export interface UpdateFromBaseToast {
  readonly type: "success" | "info";
  readonly title: string;
  readonly description: string;
}

/** What to tell the user once the base branch was merged (or was not needed). */
export function updateFromBaseToast(
  result: MergeConflictStartLocalMergeResult,
  headBranch: string,
): UpdateFromBaseToast {
  switch (result.outcome) {
    case "conflicts":
      return {
        type: "info",
        title: `Merging ${result.mergedRef} left conflicts`,
        description: "Resolve them in the Conflicts panel.",
      };
    case "merged":
      return {
        type: "success",
        title: `Merged ${result.mergedRef} into ${headBranch}`,
        description: "The merge commit is ready to push.",
      };
    case "up-to-date":
      return {
        type: "info",
        title: "Already up to date",
        description: `${headBranch} already contains ${result.mergedRef}.`,
      };
  }
}

/** The title for a refused update; the server words the description for the reader. */
export function updateFromBaseFailureTitle(reason: string | undefined): string {
  switch (reason) {
    case "dirty-working-tree":
      return "Commit or stash your changes first";
    case "operation-in-progress":
      return "Finish the operation in progress first";
    default:
      return "Could not update from the base branch";
  }
}
