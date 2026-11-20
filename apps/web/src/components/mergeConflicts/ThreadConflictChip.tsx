import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { mergeOperationNoun } from "@t3tools/client-runtime/state/merge-conflict-state";

import { useRightPanelStore } from "~/rightPanelStore";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import {
  useRepositoriesConflictState,
  useThreadConflictRepositories,
} from "./useThreadConflictRepositories";

/**
 * Shown in the thread header while a merge, rebase, cherry-pick or revert is waiting on the user,
 * summing the repositories the thread works in.
 */
export function ThreadConflictChip(props: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const m = useMessages();
  const { environmentId, repositories } = useThreadConflictRepositories(props.threadRef);
  const state = useRepositoriesConflictState(environmentId, repositories);
  if (!state.needsResolution) return null;
  const label = state.canContinue
    ? gt("Continue {noun}", { noun: mergeOperationNoun(state.operation, m) })
    : gt("{count, plural, one {{count} conflict} other {{count} conflicts}}", {
        count: state.conflictCount,
      });
  return (
    <Button
      size="xs"
      variant="warning-outline"
      className="shrink-0"
      aria-label={gt("Resolve conflicts: {label}", { label })}
      onClick={() => useRightPanelStore.getState().open(props.threadRef, "merge")}
    >
      <PullRequestGlyph.merged aria-hidden />
      {label}
    </Button>
  );
}
