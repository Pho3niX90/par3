import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type SpecIntakeInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { specIntakeRequestsAtom } from "./spec-intake-state";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const NO_PERMISSION_ATOM = Atom.make(false).pipe(Atom.withLabel("mobile-spec-intake-permission"));

export function useSpecIntakeRequested(draftKey: string | null): boolean {
  const requests = useAtomValue(specIntakeRequestsAtom);
  return draftKey !== null && requests[draftKey] === true;
}

export function useSpecIntakePermission(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NO_PERMISSION_ATOM
      : serverEnvironment.specsIntake.permissionAtom(environmentId),
  );
}

export type SpecIntakeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function useRunSpecIntake() {
  const run = useAtomCommand(serverEnvironment.specsIntake, { reportFailure: false });
  return useCallback(
    async (environmentId: EnvironmentId, input: SpecIntakeInput): Promise<SpecIntakeOutcome> => {
      const result = await run({ environmentId, input });
      if (!AsyncResult.isFailure(result)) return { ok: true };
      const error = Cause.squash(result.cause);
      return {
        ok: false,
        message: error instanceof Error ? error.message : "The spec request failed.",
      };
    },
    [run],
  );
}
