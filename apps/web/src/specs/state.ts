import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  NonNegativeInt,
  SpecSlug,
  type EnvironmentId,
  type ProjectId,
  type SpecDocument,
  type SpecMutationInput,
  type SpecQueryInput,
  type SpecQueryResult,
  type SpecRole,
  type SpecStatus,
  type SpecSummary,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { Atom } from "effect/reactivity";

import { randomUUID } from "../lib/utils";
import { useEnvironmentQuery } from "../state/query";
import {
  serverEnvironment,
  specsLive,
  specsMutate,
  specsQuery,
} from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const FALSE_ATOM = Atom.make(false).pipe(Atom.withLabel("web-specs-false"));

export function useEnvironmentSupportsSpecMode(environmentId: EnvironmentId | null): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  return config?.environment.capabilities.specMode === true;
}

function useSpecMutatePermission(
  environmentId: EnvironmentId | null,
  input?: SpecMutationInput,
): boolean {
  const atom =
    environmentId === null ? FALSE_ATOM : specsMutate.permissionAtom(environmentId, input);
  return useAtomValue(atom);
}

export function useProjectSpecModeState(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): {
  readonly capabilitiesSupported: boolean;
  readonly specModeEnabled: boolean;
  readonly canMutate: boolean;
} {
  const capabilitiesSupported = useEnvironmentSupportsSpecMode(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const projectSettings = config
    ? resolveProjectSettings(config.settings, projectId).settings
    : null;
  const canMutate = useSpecMutatePermission(environmentId);
  return {
    capabilitiesSupported,
    specModeEnabled: capabilitiesSupported && projectSettings?.specModeEnabled === true,
    canMutate,
  };
}

export interface SpecsDataView {
  readonly data: SpecQueryResult | null;
  readonly specs: ReadonlyArray<SpecSummary>;
  readonly detail: SpecDocument | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

const EMPTY_SPECS_ARRAY: ReadonlyArray<SpecSummary> = [];

export function useSpecsData(
  environmentId: EnvironmentId | null,
  input: SpecQueryInput | null,
  enabled = true,
): SpecsDataView {
  const capabilitiesSupported = useEnvironmentSupportsSpecMode(environmentId);
  const active = enabled && capabilitiesSupported && environmentId !== null && input !== null;
  const target = active ? { environmentId, input } : null;

  const liveView = useEnvironmentQuery(target !== null ? specsLive(target) : null);
  const queryView = useEnvironmentQuery(target !== null ? specsQuery(target) : null);

  const liveUpdatedAt = liveView.dataUpdatedAt;
  const queryUpdatedAt = queryView.dataUpdatedAt;
  const data =
    liveView.data !== null && liveUpdatedAt >= queryUpdatedAt
      ? liveView.data
      : (queryView.data ?? liveView.data);

  return {
    data,
    specs: data?.specs ?? EMPTY_SPECS_ARRAY,
    detail: data?.detail ?? null,
    isPending: active && data === null && (liveView.isPending || queryView.isPending),
    error: queryView.error ?? liveView.error,
    refresh: () => {
      queryView.refresh();
      liveView.refresh();
    },
  };
}

export interface ThreadSpecBindingView {
  readonly specs: ReadonlyArray<SpecSummary>;
  readonly boundSpec: SpecDocument | null;
  readonly boundRole: SpecRole | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useThreadSpecBinding(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  threadId: ThreadId | null,
  enabled = true,
): ThreadSpecBindingView {
  const queryInput: SpecQueryInput | null =
    projectId !== null && threadId !== null
      ? {
          projectId,
          threadId,
        }
      : null;
  const view = useSpecsData(environmentId, queryInput, enabled);
  const detail = view.detail;
  const binding =
    detail !== null && threadId !== null
      ? (detail.bindings.find((entry) => entry.threadId === threadId) ?? null)
      : null;

  return {
    specs: view.specs,
    boundSpec: detail,
    boundRole: binding?.role ?? null,
    isPending: view.isPending,
    error: view.error,
    refresh: view.refresh,
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SpecMutationPayload = DistributiveOmit<SpecMutationInput, "commandId"> & {
  readonly commandId?: CommandId;
};

function withSpecMutationCommandId(payload: SpecMutationPayload): SpecMutationInput {
  const commandId = payload.commandId ?? CommandId.make(`spec-cmd-${randomUUID()}`);
  return {
    ...payload,
    commandId,
  } as SpecMutationInput;
}

export type SpecMutationOutcome =
  | { readonly ok: true; readonly document: SpecDocument }
  | { readonly ok: false; readonly message: string };

export function describeSpecFailure(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "The spec request failed.";
}

export function useRunSpecMutation() {
  const runMutate = useAtomCommand(specsMutate, { reportFailure: false });
  return async (
    environmentId: EnvironmentId,
    payload: SpecMutationPayload,
  ): Promise<SpecMutationOutcome> => {
    const result = await runMutate({
      environmentId,
      input: withSpecMutationCommandId(payload),
    });
    if (result._tag === "Success") return { ok: true, document: result.value };
    if (isAtomCommandInterrupted(result))
      return { ok: false, message: "The request was cancelled." };
    return { ok: false, message: describeSpecFailure(squashAtomCommandFailure(result)) };
  };
}

export function slugifySpecTitle(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return normalized;
}

export function isValidSpecSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

export function parseSpecSlugOrNull(raw: string): SpecSlug | null {
  const candidate = slugifySpecTitle(raw);
  if (!isValidSpecSlug(candidate)) {
    return null;
  }
  return SpecSlug.make(candidate);
}

export function makeSpecRevision(revision: number): typeof NonNegativeInt.Type {
  return NonNegativeInt.make(Math.max(0, Math.trunc(revision)));
}

export function formatSpecStatusLabel(status: SpecStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "review":
      return "In review";
    case "approved":
      return "Approved";
    case "in-progress":
      return "In progress";
    case "implemented":
      return "Implemented";
    case "done":
      return "Done";
    case "blocked":
      return "Blocked";
    case "rejected":
      return "Rejected";
  }
}

export function formatSpecStatusBadgeVariant(
  status: SpecStatus,
): "default" | "secondary" | "outline" | "destructive" | "success" | "warning" | "info" {
  switch (status) {
    case "approved":
    case "done":
    case "implemented":
      return "success";
    case "review":
    case "in-progress":
      return "info";
    case "blocked":
      return "warning";
    case "rejected":
      return "destructive";
    case "draft":
      return "secondary";
  }
}

export function formatSpecRoleLabel(role: SpecRole): string {
  switch (role) {
    case "requirements":
      return "Requirements";
    case "implementation":
      return "Implementation";
    case "test":
      return "Test";
    case "researcher":
      return "Researcher";
    case "verifier":
      return "Verifier";
  }
}

export const ALL_SPEC_ROLES: ReadonlyArray<SpecRole> = [
  "requirements",
  "implementation",
  "test",
  "researcher",
  "verifier",
];
