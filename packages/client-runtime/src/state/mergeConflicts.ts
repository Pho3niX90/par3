import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

/**
 * Merge conflict resolution. The server refreshes and broadcasts repository status after every
 * mutation, so commands need no invalidation here. Mutations share the VCS scheduler so they
 * queue behind other git commands instead of racing them on one index.
 */
export function createMergeConflictEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Every unmerged path, for when status carries only a capped sample. */
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:vcs:conflicts:list",
      tag: WS_METHODS.vcsConflictsList,
    }),
    // Uncached on purpose: a file must be read as it is now, and the result carries the
    // `expected` state a later resolve is checked against.
    read: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:conflicts:read",
      tag: WS_METHODS.vcsConflictsRead,
    }),
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:conflicts:resolve",
      tag: WS_METHODS.vcsConflictsResolve,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    autoResolve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:conflicts:auto-resolve",
      tag: WS_METHODS.vcsConflictsAutoResolve,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    reopen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:conflicts:reopen",
      tag: WS_METHODS.vcsConflictsReopen,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    runOperation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:operation:run",
      tag: WS_METHODS.vcsOperationRun,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    mergeBase: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:vcs:merge-base",
      tag: WS_METHODS.vcsMergeBase,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
  };
}
