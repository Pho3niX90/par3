import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type SpecDocument,
  type SpecRole,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";

import {
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
} from "../providerInstances";
import { newThreadId } from "../lib/utils";
import { useProject } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { specRoleRefusal } from "./specs.logic";
import { describeSpecFailure, makeSpecRevision, useRunSpecMutation } from "./state";
import type { ProjectId } from "@t3tools/contracts";

export type StartSpecThreadOutcome =
  | { readonly ok: true; readonly threadId: ThreadId }
  | { readonly ok: false; readonly message: string };

/** Creates a normal thread in the project, binds it to the spec before any turn runs, then opens it. */
export function useStartSpecThread(environmentId: EnvironmentId, projectId: ProjectId) {
  const navigate = useNavigate();
  const project = useProject(scopeProjectRef(environmentId, projectId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const createThread = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const runMutation = useRunSpecMutation();

  return async (spec: SpecDocument, role: SpecRole): Promise<StartSpecThreadOutcome> => {
    if (project === null || config === null) {
      return { ok: false, message: "Connect to the environment and try again." };
    }
    const settings = resolveProjectSettings(
      config.settings ?? DEFAULT_SERVER_SETTINGS,
      projectId,
      project,
    ).settings;
    const modelSelection = resolveDefaultProviderModelSelection(
      config.providers,
      settings.defaultModelSelection,
    );
    if (modelSelection === null) {
      return { ok: false, message: "No provider is available to run the implementation thread." };
    }
    const driver =
      deriveProviderInstanceEntries(config.providers).find(
        (entry) => entry.instanceId === modelSelection.instanceId,
      )?.driverKind ?? null;
    const refusal = specRoleRefusal(driver, role);
    if (refusal !== null) return { ok: false, message: refusal };

    const threadId = newThreadId();
    const created = await createThread({
      environmentId,
      input: {
        threadId,
        projectId,
        title: role === "requirements" ? `Requirements: ${spec.title}` : `Implement ${spec.title}`,
        modelSelection,
        runtimeMode: settings.defaultRuntimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      },
    });
    if (created._tag === "Failure") {
      return { ok: false, message: describeSpecFailure(squashAtomCommandFailure(created)) };
    }
    const bound = await runMutation(environmentId, {
      action: "bind",
      projectId,
      threadId,
      slug: spec.slug,
      expectedRevision: makeSpecRevision(spec.revision),
      role,
    });
    if (!bound.ok) {
      return {
        ok: false,
        message: `The thread was created but could not be bound to the spec: ${bound.message}`,
      };
    }
    await navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
    return { ok: true, threadId };
  };
}
