import { create } from "zustand";

import {
  EMPTY_RESOLVED_IN_OPERATION,
  forgetResolved,
  recordResolved,
  type ResolvedInOperation,
} from "./mergeConflicts.logic";

interface MergeConflictSessionState {
  /** Per environment and repository; session-only, so it is gone after a reload. */
  readonly resolvedByRepository: Readonly<Record<string, ResolvedInOperation>>;
  readonly markResolved: (key: string, signature: string, path: string) => void;
  readonly markReopened: (key: string, path: string) => void;
}

export const repositoryKey = (environmentId: string, cwd: string) => `${environmentId}\u0000${cwd}`;

export const useMergeConflictSessionStore = create<MergeConflictSessionState>()((set) => ({
  resolvedByRepository: {},
  markResolved: (key, signature, path) =>
    set((state) => ({
      resolvedByRepository: {
        ...state.resolvedByRepository,
        [key]: recordResolved(
          state.resolvedByRepository[key] ?? EMPTY_RESOLVED_IN_OPERATION,
          signature,
          path,
        ),
      },
    })),
  markReopened: (key, path) =>
    set((state) => ({
      resolvedByRepository: {
        ...state.resolvedByRepository,
        [key]: forgetResolved(state.resolvedByRepository[key] ?? EMPTY_RESOLVED_IN_OPERATION, path),
      },
    })),
}));
