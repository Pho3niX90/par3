import { useAtomValue } from "@effect/atom-react";
import type { SyncConflict } from "@t3tools/client-runtime/sync/plan";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { serverEnvironment, primaryServerKeybindingsAtom } from "../../state/server";
import { describeCommandFailure, useApplySyncMerge, useSyncPlan } from "../../state/sync";
import { useAtomCommand } from "../../state/use-atom-command";
import type { MergeInput } from "../mergeConflicts/mergeSession";
import { ThreeWayMergeView, type MergeApplyOutcome } from "../mergeConflicts/ThreeWayMergeView";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { syncMergeSides } from "./syncSettings.logic";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly basis: SyncConflict; readonly input: MergeInput };

/** Merges the two versions of a synced file in the three-pane merge view. */
export function SyncMergeDialog(props: {
  /** The conflict to merge; null closes the dialog. */
  readonly conflictKey: string | null;
  readonly title: string;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={props.conflictKey !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        aria-label={`Merge ${props.title}`}
        className="h-[85vh] max-w-[min(96vw,1600px)] overflow-hidden"
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        {props.conflictKey === null ? null : (
          <SyncMergeBody
            conflictKey={props.conflictKey}
            labelOf={props.labelOf}
            onClose={props.onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function SyncMergeBody(props: {
  readonly conflictKey: string;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly onClose: () => void;
}) {
  const plan = useSyncPlan();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const readCommand = useAtomCommand(serverEnvironment.syncRead, { reportFailure: false });
  const applyMerge = useApplySyncMerge();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const conflict = plan.conflicts.find(({ key }) => key === props.conflictKey);
  const sides = conflict === undefined ? null : syncMergeSides(conflict);

  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reads the versions the plan shows when opened or reloaded; a newer version mid-merge surfaces as stale on apply instead of discarding edits.
    if (conflict === undefined || sides === null) return;
    let cancelled = false;
    void Promise.all(
      sides.map((side) =>
        readCommand({ environmentId: side.environmentIds[0]!, input: { key: conflict.key } }),
      ),
    ).then(([left, right]) => {
      if (cancelled) return;
      if (left?._tag !== "Success" || right?._tag !== "Success") {
        const failed = [left, right].find((result) => result?._tag !== "Success");
        setLoad({
          status: "error",
          message: failed ? describeCommandFailure(failed) : "Could not read both versions.",
        });
        return;
      }
      if (left.value.hash !== sides[0].hash || right.value.hash !== sides[1].hash) {
        setLoad({ status: "error", message: "A machine changed this item while it was read." });
        return;
      }
      const sideLabel = (environmentIds: ReadonlyArray<EnvironmentId>) =>
        environmentIds.map(props.labelOf).join(", ");
      setLoad({
        status: "ready",
        basis: conflict,
        input: {
          key: ["sync", conflict.key, sides[0].hash, sides[1].hash].join("\0"),
          path: conflict.name,
          labels: {
            ours: sideLabel(sides[0].environmentIds),
            theirs: sideLabel(sides[1].environmentIds),
          },
          base: null,
          ours: left.value.contents,
          theirs: right.value.contents,
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [props.conflictKey, attempt]);

  const reload = () => {
    setLoad({ status: "loading" });
    setAttempt((current) => current + 1);
  };

  const apply = async (contents: string): Promise<MergeApplyOutcome> => {
    if (load.status !== "ready") return { status: "failed" };
    const result = await applyMerge(load.basis, contents);
    if (result === "stale" || result.stale > 0) {
      return {
        status: "stale",
        message:
          "This item changed on a machine since you opened it. Reload to merge the current versions; your edits here will be discarded.",
      };
    }
    if (result.failed + result.rejected > 0) {
      toastManager.add({
        type: "error",
        title: "Could not apply the merge everywhere",
        description: "A machine refused the change or could not be reached.",
      });
      return { status: "failed" };
    }
    props.onClose();
    return { status: "applied" };
  };

  if (load.status !== "ready" && sides === null) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>Nothing to merge</EmptyTitle>
          <EmptyDescription>This item is no longer two versions of a file.</EmptyDescription>
        </EmptyHeader>
        <Button size="xs" variant="outline" onClick={props.onClose}>
          Close
        </Button>
      </Empty>
    );
  }
  if (load.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" />
        Reading both versions…
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>Could not open the merge</EmptyTitle>
          <EmptyDescription>{load.message}</EmptyDescription>
        </EmptyHeader>
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={props.onClose}>
            Close
          </Button>
          <Button size="xs" onClick={reload}>
            Try again
          </Button>
        </div>
      </Empty>
    );
  }
  return (
    <ThreeWayMergeView
      key={attempt}
      input={load.input}
      keybindings={keybindings}
      onApply={apply}
      onCancel={props.onClose}
      onReload={reload}
    />
  );
}
