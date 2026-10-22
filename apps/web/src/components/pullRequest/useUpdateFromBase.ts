import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestDetail, ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { readProject, readThreadShell, useServerConfigs } from "~/state/entities";
import { mergeConflictEnvironment } from "~/state/mergeConflicts";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";

import { toastManager } from "../ui/toast";
import { updateFromBaseFailureTitle, updateFromBaseToast } from "./updateFromBase.logic";
import type { PreparedPullRequestCheckout } from "./usePullRequestActions";

type UpdateFromBaseDetail = Pick<PullRequestDetail, "headBranch" | "baseBranch">;

/**
 * "Update from base locally": merges the pull request's base branch into its head branch in a
 * checkout of the user's own, so conflicts are resolved by hand instead of handed to an agent.
 * The thread's own folder is used when it is already on the head branch; otherwise the pull
 * request is checked out first, without sending a task.
 */
export function useUpdateFromBase(input: {
  readonly environmentId: EnvironmentId;
  readonly detail: UpdateFromBaseDetail | null;
  /** The thread the action is taken from, if any. */
  readonly threadRef: ScopedThreadRef | null;
  /** Checks the pull request out with a thread on it and says where; null when that failed. */
  readonly prepareCheckout: () => Promise<PreparedPullRequestCheckout | null>;
}) {
  const { environmentId, detail, threadRef } = input;
  const serverConfigs = useServerConfigs();
  // A server without the resolver has no `vcs.mergeBase`, so the action must not appear.
  const supported =
    serverConfigs.get(environmentId)?.environment.capabilities.mergeConflicts === true;
  const permitted = useAtomValue(mergeConflictEnvironment.mergeBase.permissionAtom(environmentId));
  const mergeBase = useAtomCommand(mergeConflictEnvironment.mergeBase, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  /** The current thread's folder, when it sits on the pull request's head branch. */
  const currentCheckout = async (head: string) => {
    if (threadRef === null) return null;
    // A thread opened on a checkout is a draft until its first message.
    const thread =
      readThreadShell(threadRef) ?? useComposerDraftStore.getState().getDraftThreadByRef(threadRef);
    if (thread === null) return null;
    const project = readProject({
      environmentId: thread.environmentId,
      projectId: thread.projectId,
    });
    const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
    if (cwd === null) return null;
    const status = await refreshStatus({ environmentId, input: { cwd } });
    return status._tag === "Success" && status.value.refName === head ? { cwd, threadRef } : null;
  };

  const run = async () => {
    if (detail === null || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    const outcome = await updateFromBase(detail);
    pendingRef.current = false;
    setPending(false);
    return outcome;
  };

  const updateFromBase = async (pr: UpdateFromBaseDetail) => {
    let target = await currentCheckout(pr.headBranch);
    if (target === null) {
      const prepared = await input.prepareCheckout();
      if (prepared === null) return;
      // A checkout that keeps local work is still on the head branch, which is all this needs.
      if (prepared.cwd === null) return;
      target = { cwd: prepared.cwd, threadRef: prepared.threadRef };
    }
    const result = await mergeBase({
      environmentId,
      input: { cwd: target.cwd, baseRefName: pr.baseBranch },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: updateFromBaseFailureTitle(isMergeConflictError(error) ? error.reason : undefined),
        // The server words these for the person reading them (dirty tree, operation in progress).
        description: error instanceof Error ? error.message : undefined,
      });
      return;
    }
    if (result.value.outcome === "conflicts") {
      useRightPanelStore.getState().open(target.threadRef, "merge");
    }
    toastManager.add(updateFromBaseToast(result.value, pr.headBranch));
  };

  return { available: supported && permitted, pending, run };
}

const isMergeConflictError = (error: unknown): error is { _tag: string; reason: string } =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "MergeConflictError" &&
  "reason" in error &&
  typeof error.reason === "string";
