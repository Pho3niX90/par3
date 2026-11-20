import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { mergeOperationNoun } from "@t3tools/client-runtime/state/merge-conflict-state";

import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "../ui/button";
import {
  useRepositoriesConflictState,
  useThreadConflictRepositories,
} from "./useThreadConflictRepositories";

/** A diff of a half-merged tree is misleading, so the diff points at the resolver first. */
export function DiffPanelConflictLink(props: { readonly threadRef: ScopedThreadRef | null }) {
  const gt = useGT();
  const m = useMessages();
  const { environmentId, repositories } = useThreadConflictRepositories(props.threadRef);
  const state = useRepositoriesConflictState(environmentId, repositories);
  const threadRef = props.threadRef;
  if (!state.needsResolution || threadRef === null) return null;
  const noun = mergeOperationNoun(state.operation, m);
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {state.canContinue
          ? gt("A {noun} is ready to continue.", { noun })
          : gt(
              "{count, plural, one {A {noun} is in progress with {count} conflict.} other {A {noun} is in progress with {count} conflicts.}}",
              { noun, count: state.conflictCount },
            )}
      </span>
      <Button
        size="xs"
        variant="link"
        onClick={() => useRightPanelStore.getState().open(threadRef, "merge")}
      >
        {state.canContinue ? gt("Continue {noun}", { noun }) : gt("Resolve conflicts")}
      </Button>
    </div>
  );
}
