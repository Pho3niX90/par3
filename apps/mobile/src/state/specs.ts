import { useAtomValue } from "@effect/atom-react";
import {
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type SpecRole,
  type SpecQueryInput,
  type SpecQueryResult,
  type SpecMutationInput,
} from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { uuidv4 } from "../lib/uuid";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export const specEnvironment = {
  query: serverEnvironment.specsQuery,
  subscribe: serverEnvironment.specsLive,
  mutate: serverEnvironment.specsMutate,
};

export const SPEC_ROLE_SUPPORTED_DRIVERS: Readonly<Record<SpecRole, readonly string[]>> = {
  requirements: ["codex", "claudeAgent", "claude"],
  implementation: ["codex", "claudeAgent", "claude", "cursor", "grok", "opencode", "antigravity"],
  test: ["codex", "claudeAgent", "claude", "cursor", "grok", "opencode", "antigravity"],
  researcher: ["codex", "claudeAgent", "claude"],
  verifier: ["codex", "claudeAgent", "claude"],
};

export function isSpecRoleSupported(driver: string | null | undefined, role: SpecRole): boolean {
  if (!driver) return false;
  if (typeof (Contracts as { specRoleSupported?: unknown }).specRoleSupported === "function") {
    return (
      Contracts as { specRoleSupported: (d: string, r: SpecRole) => boolean }
    ).specRoleSupported(driver, role);
  }
  const supported = SPEC_ROLE_SUPPORTED_DRIVERS[role];
  return supported ? supported.includes(driver) : false;
}

export function explainSpecRoleSupport(
  driver: string | null | undefined,
  role: SpecRole,
): string | null {
  if (isSpecRoleSupported(driver, role)) {
    return null;
  }
  const normalized = driver ? driver : "Selected provider";
  if (role === "requirements" || role === "researcher" || role === "verifier") {
    return `${normalized} does not support the "${role}" role. Spec mode requires Codex or Claude for ${role}.`;
  }
  return `${normalized} does not support the "${role}" role. Spec mode requires Codex, Claude, Cursor, Grok, OpenCode, or Antigravity for ${role}.`;
}

export function useSpecPermissions(environmentId: EnvironmentId | null) {
  const canOperate = useAtomValue(
    environmentId !== null
      ? specEnvironment.mutate.permissionAtom(environmentId)
      : specEnvironment.mutate.permissionAtom("" as EnvironmentId),
  );
  return {
    canMutate: environmentId !== null && canOperate,
  };
}

export function useProjectSpecs(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  threadId?: ThreadId,
) {
  const input = useMemo<SpecQueryInput | null>(() => {
    if (!projectId) return null;
    return {
      projectId,
      ...(threadId ? { threadId } : {}),
    };
  }, [projectId, threadId]);

  const result = useAtomValue(
    environmentId && input
      ? specEnvironment.query({ environmentId, input })
      : specEnvironment.query({
          environmentId: "" as EnvironmentId,
          input: { projectId: "" as ProjectId },
        }),
  );

  const queryValue = Option.getOrNull(AsyncResult.value(result)) as SpecQueryResult | null;
  const isPending = AsyncResult.isWaiting(result);
  const error = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;

  return {
    specs: queryValue?.specs ?? [],
    isPending,
    error,
  };
}

export function useSpecDetail(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  slug: string | null,
  threadId?: ThreadId,
) {
  const input = useMemo<SpecQueryInput | null>(() => {
    if (!projectId || !slug) return null;
    return {
      projectId,
      slug,
      ...(threadId ? { threadId } : {}),
    };
  }, [projectId, slug, threadId]);

  const result = useAtomValue(
    environmentId && input
      ? specEnvironment.query({ environmentId, input })
      : specEnvironment.query({
          environmentId: "" as EnvironmentId,
          input: { projectId: "" as ProjectId },
        }),
  );

  const queryValue = Option.getOrNull(AsyncResult.value(result)) as SpecQueryResult | null;
  const isPending = AsyncResult.isWaiting(result);
  const error = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;

  return {
    detail: queryValue?.detail ?? null,
    isPending,
    error,
  };
}

/**
 * Query current thread with no slug returns detail of its spec binding if any.
 * threadId selects its checkout.
 */
export function useThreadBoundSpec(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  threadId: ThreadId | null,
) {
  const input = useMemo<SpecQueryInput | null>(() => {
    if (!projectId || !threadId) return null;
    return {
      projectId,
      threadId,
    };
  }, [projectId, threadId]);

  const result = useAtomValue(
    environmentId && input
      ? specEnvironment.query({ environmentId, input })
      : specEnvironment.query({
          environmentId: "" as EnvironmentId,
          input: { projectId: "" as ProjectId },
        }),
  );

  const queryValue = Option.getOrNull(AsyncResult.value(result)) as SpecQueryResult | null;
  const isPending = AsyncResult.isWaiting(result);
  const error = AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;

  return {
    boundSpec: queryValue?.detail ?? null,
    isPending,
    error,
  };
}

export function useSpecMutations(environmentId: EnvironmentId | null, projectId: ProjectId | null) {
  const mutate = useAtomCommand(specEnvironment.mutate, {
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
