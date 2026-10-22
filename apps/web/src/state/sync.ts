import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  planConflictResolution,
  planSync,
  runSyncPlan,
  type PlannedOp,
  type SyncEnvironmentView,
  type SyncRunResult,
  type SyncTransport,
} from "@t3tools/client-runtime/sync/plan";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useRef } from "react";
import { create } from "zustand";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

/**
 * Connected environments this client can sync: the server offers sync and the connection may
 * write provider homes there. Only these are subscribed, so an environment the user cannot sync
 * costs nothing.
 */
const syncEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const ids: EnvironmentId[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected") continue;
    if (presentation.serverConfig?.environment.capabilities.sync !== true) continue;
    if (!get(serverEnvironment.syncApply.permissionAtom(environmentId))) continue;
    ids.push(environmentId);
  }
  return ids;
}).pipe(Atom.withLabel("web-sync-environment-ids"));

const syncViewsAtom = Atom.make((get): ReadonlyArray<SyncEnvironmentView> => {
  const views: SyncEnvironmentView[] = [];
  for (const environmentId of get(syncEnvironmentIdsAtom)) {
    const snapshot = Option.getOrNull(
      AsyncResult.value(get(serverEnvironment.syncLive({ environmentId, input: {} }))),
    );
    if (snapshot !== null) views.push({ environmentId, snapshot });
  }
  return views;
}).pipe(Atom.withLabel("web-sync-views"));

const syncPlanAtom = Atom.make((get) => planSync(get(syncViewsAtom))).pipe(
  Atom.withLabel("web-sync-plan"),
);

export function isSyncParticipating(view: SyncEnvironmentView): boolean {
  return view.snapshot.participation?.enabled === true;
}

interface SyncRunnerState {
  readonly running: boolean;
  readonly lastErrorByEnvironment: Readonly<Record<string, string>>;
  /** Bumped to retry a plan that failed the same way last time. */
  readonly retryNonce: number;
}

export const useSyncRunnerStore = create<SyncRunnerState>(() => ({
  running: false,
  lastErrorByEnvironment: {},
  retryNonce: 0,
}));

export function retrySync() {
  useSyncRunnerStore.setState((state) => ({ retryNonce: state.retryNonce + 1 }));
}

export function describeCommandFailure(result: AtomCommandResult<unknown, unknown>): string {
  if (isAtomCommandInterrupted(result)) return "The request was cancelled.";
  const error = result._tag === "Failure" ? squashAtomCommandFailure(result) : null;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

/** A transport over the sync commands that remembers the first failure per environment. */
function makeTransport(registry: AtomRegistry.AtomRegistry) {
  const errors = new Map<EnvironmentId, string>();
  const note = (environmentId: EnvironmentId, message: string) => {
    if (!errors.has(environmentId)) errors.set(environmentId, message);
  };
  const transport: SyncTransport = {
    read: async (environmentId, key) => {
      const result = await runAtomCommand(
        registry,
        serverEnvironment.syncRead,
        { environmentId, input: { key } },
        { reportFailure: false },
      );
      if (result._tag === "Success") return result.value;
      const message = describeCommandFailure(result);
      note(environmentId, message);
      throw new Error(message);
    },
    apply: async (environmentId, ops) => {
      const result = await runAtomCommand(
        registry,
        serverEnvironment.syncApply,
        { environmentId, input: { ops: [...ops] } },
        { reportFailure: false },
      );
      if (result._tag === "Success") {
        const rejected = result.value.results.find((outcome) => outcome.status === "rejected");
        if (rejected) note(environmentId, rejected.message ?? `${rejected.key} was refused.`);
        return result.value;
      }
      const message = describeCommandFailure(result);
      note(environmentId, message);
      throw new Error(message);
    },
  };
  return { transport, errors };
}

async function runWithTransport(
  registry: AtomRegistry.AtomRegistry,
  opsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<PlannedOp>>,
  environmentIds: ReadonlyArray<EnvironmentId>,
): Promise<SyncRunResult> {
  const { transport, errors } = makeTransport(registry);
  const result = await runSyncPlan(opsByEnvironment, transport);
  useSyncRunnerStore.setState((state) => {
    const next = { ...state.lastErrorByEnvironment };
    for (const environmentId of environmentIds) delete next[environmentId];
    for (const [environmentId, message] of errors) next[environmentId] = message;
    return { lastErrorByEnvironment: next };
  });
  return result;
}

function planSignature(opsByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<PlannedOp>>) {
  return JSON.stringify(
    [...opsByEnvironment].map(([environmentId, ops]) => [
      environmentId,
      ops.map((op) => [op.key, op.expectedHash, op.action._tag, op.baseline.hash, op.baseline.rev]),
    ]),
  );
}

/**
 * Carries changes between connected environments whenever one of them reports a new snapshot.
 * Servers never talk to each other, so this only runs while the client is connected to both.
 */
export function useSyncRunner() {
  const registry = useContext(RegistryContext);
  const views = useAtomValue(syncViewsAtom);
  const retryNonce = useSyncRunnerStore((state) => state.retryNonce);
  const runner = useRef({ running: false, again: false, lastSignature: null as string | null });

  const run = useEffectEvent(async () => {
    const state = runner.current;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    useSyncRunnerStore.setState({ running: true });
    try {
      do {
        state.again = false;
        // Read at each pass, since snapshots keep arriving while a run awaits the servers.
        const current = registry.get(syncViewsAtom);
        if (current.filter(isSyncParticipating).length < 2) continue;
        const plan = planSync(current);
        if (plan.opsByEnvironment.size === 0) {
          state.lastSignature = null;
          continue;
        }
        // Ops a server refuses come back in the next plan unchanged; retrying them on every
        // snapshot would loop, so an identical plan waits for a change or an explicit retry.
        const signature = planSignature(plan.opsByEnvironment);
        if (signature === state.lastSignature) continue;
        state.lastSignature = signature;
        await runWithTransport(
          registry,
          plan.opsByEnvironment,
          current.map((view) => view.environmentId),
        );
      } while (state.again);
    } finally {
      state.running = false;
      useSyncRunnerStore.setState({ running: false });
    }
  });

  const seqKey = views.map((view) => `${view.environmentId}:${view.snapshot.seq}`).join(",");
  useEffect(() => {
    if (seqKey !== "") void run();
  }, [seqKey]);
  useEffect(() => {
    if (retryNonce === 0) return;
    runner.current.lastSignature = null;
    void run();
  }, [retryNonce]);
}

export function useResolveSyncConflict() {
  const registry = useContext(RegistryContext);
  return async (key: string, winner: EnvironmentId | "delete"): Promise<SyncRunResult> => {
    const views = registry.get(syncViewsAtom);
    const ops = planConflictResolution(views, key, winner);
    return runWithTransport(registry, ops, [...ops.keys()]);
  };
}

export function useSyncViews() {
  return useAtomValue(syncViewsAtom);
}

export function useSyncPlan() {
  return useAtomValue(syncPlanAtom);
}
