import { useAtomValue } from "@effect/atom-react";
import {
  selectMergeConflictState,
  sumMergeConflictStates,
  type MergeConflictState,
} from "@t3tools/client-runtime/state/merge-conflict-state";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentQuery } from "~/state/query";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { vcsEnvironment } from "~/state/vcs";

export interface ConflictRepository {
  readonly cwd: string;
  /** Path relative to the thread's folder when it holds several repositories; null for the only one. */
  readonly label: string | null;
}

const NO_REPOSITORIES: ReadonlyArray<ConflictRepository> = [];

/**
 * The repositories a thread works in: its own folder, or when that folder is not a repository,
 * the child repositories it edited (gap in the plan: threads can span several).
 */
export function useThreadConflictRepositories(threadRef: ScopedThreadRef | null): {
  readonly environmentId: EnvironmentId | null;
  readonly repositories: ReadonlyArray<ConflictRepository>;
} {
  const thread = useQuietThreadShell(threadRef);
  // A thread opened on a prepared checkout is a draft until its first message, and can already
  // have a merge to resolve.
  const draft = useComposerDraftStore((store) =>
    threadRef === null ? null : store.getDraftThreadByRef(threadRef),
  );
  const project = useProject(
    thread
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : draft
        ? { environmentId: draft.environmentId, projectId: draft.projectId }
        : null,
  );
  const environmentId = thread?.environmentId ?? draft?.environmentId ?? null;
  const threadCwd = (thread ?? draft)?.worktreePath ?? project?.workspaceRoot ?? null;
  const statusQuery = useEnvironmentQuery(
    environmentId !== null && threadCwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: threadCwd } })
      : null,
  );
  const threadCwdIsRepo = statusQuery.data?.isRepo;
  const childrenQuery = useEnvironmentQuery(
    thread && threadCwdIsRepo === false
      ? vcsEnvironment.threadRepositories({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        })
      : null,
  );
  if (environmentId === null) return { environmentId: null, repositories: NO_REPOSITORIES };
  if (threadCwdIsRepo === false) {
    return {
      environmentId,
      repositories: (childrenQuery.data?.repositories ?? []).map((repository) => ({
        cwd: repository.cwd,
        label: repository.relativePath,
      })),
    };
  }
  return {
    environmentId,
    repositories: threadCwd === null ? NO_REPOSITORIES : [{ cwd: threadCwd, label: null }],
  };
}

const conflictSummaryAtom = Atom.family((key: string) => {
  const [environmentId, cwds] = JSON.parse(key) as [EnvironmentId, ReadonlyArray<string>];
  return Atom.make((get) =>
    sumMergeConflictStates(
      cwds.map((cwd) =>
        selectMergeConflictState(
          Option.getOrNull(
            AsyncResult.value(get(vcsEnvironment.status({ environmentId, input: { cwd } }))),
          ),
        ),
      ),
    ),
  );
});

/** Conflicts and operation summed over the given repositories, from live status. */
export function useRepositoriesConflictState(
  environmentId: EnvironmentId | null,
  repositories: ReadonlyArray<ConflictRepository>,
): MergeConflictState {
  return useAtomValue(
    conflictSummaryAtom(
      JSON.stringify([environmentId, environmentId === null ? [] : repositories.map((r) => r.cwd)]),
    ),
  );
}
