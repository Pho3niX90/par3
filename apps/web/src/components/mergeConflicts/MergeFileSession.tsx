import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MergeConflictReadResult,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { mergeConflictEnvironment } from "~/state/mergeConflicts";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { conflictRowActions, fileLevelReasonLabel } from "./mergeConflicts.logic";
import { useMergeConflictSessionStore, repositoryKey } from "./mergeConflictSessionStore";
import { operationSignature } from "./mergeConflicts.logic";
import { ThreeWayMergeView, type MergeApplyOutcome } from "./ThreeWayMergeView";

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly file: MergeConflictReadResult };

/**
 * Reads one conflicted file and hosts the three-pane view for it, applying the result through
 * the resolve command and moving on to the next file that can be merged here.
 */
export function MergeFileSession(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Opens another file, or null to go back to the list. */
  readonly onOpen: (path: string | null) => void;
}) {
  const { environmentId, cwd, path } = props;
  const readCommand = useAtomCommand(mergeConflictEnvironment.read, { reportFailure: false });
  const resolveCommand = useAtomCommand(mergeConflictEnvironment.resolve, {
    reportFailure: false,
  });
  const list = useEnvironmentQuery(
    mergeConflictEnvironment.list({ environmentId, input: { cwd } }),
  );
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Reads again for another file or an explicit reload; the command's identity is not a trigger.
    void readCommand({ environmentId, input: { cwd, path } }).then((result) => {
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") setLoad({ status: "ready", file: result.value });
      else {
        const error = squashAtomCommandFailure(result);
        setLoad({
          status: "error",
          message: error instanceof Error ? error.message : "Could not read this file.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, cwd, path, attempt]);

  const reload = () => {
    setLoad({ status: "loading" });
    setAttempt((current) => current + 1);
  };

  const mergeable = (list.data?.conflicts ?? [])
    .filter((entry) => conflictRowActions(entry).canMerge)
    .map((entry) => entry.path);
  const next = mergeable.find(
    (candidate, index) => index > mergeable.indexOf(path) && candidate !== path,
  );

  const apply = async (content: string): Promise<MergeApplyOutcome> => {
    if (load.status !== "ready") return { status: "failed" };
    const file = load.file;
    const result = await resolveCommand({
      environmentId,
      input: {
        cwd,
        path,
        expected: file.expected,
        resolution: { _tag: "content", content },
      },
    });
    if (result._tag === "Success") {
      useMergeConflictSessionStore
        .getState()
        .markResolved(repositoryKey(environmentId, cwd), operationSignature(file.operation), path);
      list.refresh();
      props.onOpen(next ?? null);
      return { status: "applied" };
    }
    if (isAtomCommandInterrupted(result)) return { status: "failed" };
    const error = squashAtomCommandFailure(result);
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "MergeConflictStaleError"
    ) {
      return {
        status: "stale",
        message:
          "This file changed on disk or in the repository since you opened it. Reload to merge the current version; your edits here will be discarded.",
      };
    }
    toastManager.add({
      type: "error",
      title: "Could not apply the merge",
      description: error instanceof Error ? error.message : undefined,
    });
    return { status: "failed" };
  };

  if (load.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner size="sm" />
        Reading {path}…
      </div>
    );
  }
  if (load.status === "error") {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>Could not open the file</EmptyTitle>
          <EmptyDescription>{load.message}</EmptyDescription>
        </EmptyHeader>
        <div className="flex gap-2">
          <Button size="xs" variant="outline" onClick={() => props.onOpen(null)}>
            Back to the list
          </Button>
          <Button size="xs" onClick={reload}>
            Try again
          </Button>
        </div>
      </Empty>
    );
  }
  const { file } = load;
  if (file.fileLevelReason !== undefined || file.ours === null || file.theirs === null) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>This file can only be resolved by choosing a side</EmptyTitle>
          <EmptyDescription>
            {file.fileLevelReason
              ? fileLevelReasonLabel(file.fileLevelReason)
              : "One side deleted it."}
          </EmptyDescription>
        </EmptyHeader>
        <Button size="xs" variant="outline" onClick={() => props.onOpen(null)}>
          Back to the list
        </Button>
      </Empty>
    );
  }
  return (
    <ThreeWayMergeView
      key={`${attempt}:${path}`}
      environmentId={environmentId}
      cwd={cwd}
      file={file}
      keybindings={props.keybindings}
      hasNextFile={next !== undefined}
      onApply={apply}
      onCancel={() => props.onOpen(null)}
      onReload={reload}
    />
  );
}
