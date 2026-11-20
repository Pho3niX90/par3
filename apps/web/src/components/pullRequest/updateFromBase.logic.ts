import type { MergeConflictStartLocalMergeResult } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export interface UpdateFromBaseToast {
  readonly type: "success" | "info";
  readonly title: string;
  readonly description: string;
}

/** What to tell the user once the base branch was merged (or was not needed). */
export function updateFromBaseToast(
  result: MergeConflictStartLocalMergeResult,
  headBranch: string,
  resolve: MessageResolver = m,
): UpdateFromBaseToast {
  switch (result.outcome) {
    case "conflicts":
      return {
        type: "info",
        title: resolve(msg("Merging {ref} left conflicts", { ref: result.mergedRef })),
        description: resolve(msg("Resolve them in the Conflicts panel.")),
      };
    case "merged":
      return {
        type: "success",
        title: resolve(
          msg("Merged {ref} into {branch}", { ref: result.mergedRef, branch: headBranch }),
        ),
        description: resolve(msg("The merge commit is ready to push.")),
      };
    case "up-to-date":
      return {
        type: "info",
        title: resolve(msg("Already up to date")),
        description: resolve(
          msg("{branch} already contains {ref}.", { branch: headBranch, ref: result.mergedRef }),
        ),
      };
  }
}

/** The title for a refused update; the server words the description for the reader. */
export function updateFromBaseFailureTitle(
  reason: string | undefined,
  resolve: MessageResolver = m,
): string {
  switch (reason) {
    case "dirty-working-tree":
      return resolve(msg("Commit or stash your changes first"));
    case "operation-in-progress":
      return resolve(msg("Finish the operation in progress first"));
    default:
      return resolve(msg("Could not update from the base branch"));
  }
}
