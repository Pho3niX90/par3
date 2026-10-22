import { useAtomValue } from "@effect/atom-react";
import {
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type SpecMutationInput,
  type SpecQueryInput,
  type SpecRole,
  type ThreadId,
  specRoleSupported,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { uuidv4 } from "../lib/uuid";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const NO_PERMISSION_ATOM = Atom.make(false).pipe(Atom.withLabel("mobile-specs-no-permission"));

export function isSpecRoleSupported(driver: string | null | undefined, role: SpecRole): boolean {
  return Boolean(driver) && specRoleSupported(driver!, role);
}

export function explainSpecRoleSupport(
  driver: string | null | undefined,
  role: SpecRole,
): string | null {
  if (isSpecRoleSupported(driver, role)) return null;
  const provider = driver || "This provider";
  return role === "requirements" || role === "researcher" || role === "verifier"
    ? `${provider} can't run the ${role} role. It needs Codex or Claude.`
    : `${provider} can't run the ${role} role in Spec mode.`;
}

export function useSpecPermissions(environmentId: EnvironmentId | null) {
  const canMutate = useAtomValue(
    environmentId === null
      ? NO_PERMISSION_ATOM
      : serverEnvironment.specsMutate.permissionAtom(environmentId),
  );
  return { canMutate };
}

// The subscription's first value is the current state, so one live query serves
// both the initial load and later changes.
function useSpecs(environmentId: EnvironmentId | null, input: SpecQueryInput | null) {
  return useEnvironmentQuery(
    environmentId !== null && input !== null
      ? serverEnvironment.specsLive({ environmentId, input })
      : null,
  );
}

export function useProjectSpecs(environmentId: EnvironmentId | null, projectId: ProjectId | null) {
  const view = useSpecs(environmentId, projectId === null ? null : { projectId });
  return {
    specs: view.data?.specs ?? [],
    layout: view.data?.layout ?? "par3",
    isPending: view.isPending,
    error: view.error,
    refresh: view.refresh,
  };
}

export function useSpecDetail(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  slug: string | null,
) {
  const view = useSpecs(
    environmentId,
    projectId === null || slug === null ? null : { projectId, slug, limit: 1 },
  );
  return { detail: view.data?.detail ?? null, isPending: view.isPending, error: view.error };
}

/** With a thread and no slug, the server returns the thread's bound spec as the detail. */
export function useThreadBoundSpec(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  threadId: ThreadId | null,
) {
  const view = useSpecs(
    environmentId,
    projectId === null || threadId === null ? null : { projectId, threadId, limit: 1 },
  );
  return { boundSpec: view.data?.detail ?? null, isPending: view.isPending, error: view.error };
}

export function useSpecMutations(environmentId: EnvironmentId | null, projectId: ProjectId | null) {
  const mutate = useAtomCommand(serverEnvironment.specsMutate, {
    label: "spec mutation",
    reportFailure: true,
  });

  const runMutation = useCallback(
    async (
      slug: string,
      expectedRevision: number,
      actionPayload: Record<string, unknown> & { action: string },
      threadId?: ThreadId,
    ) => {
      if (!environmentId || !projectId) {
        throw new Error("Missing environment or project for spec mutation");
      }
      return mutate({
        environmentId,
        input: {
          ...actionPayload,
          projectId,
          slug,
          expectedRevision,
          commandId: uuidv4() as CommandId,
          ...(threadId ? { threadId } : {}),
        } as SpecMutationInput,
      });
    },
    [environmentId, projectId, mutate],
  );

  return { runMutation };
}
