import type { ModelSelection } from "./modelSelection.ts";
import type { ProviderDriverKind } from "./providerInstance.ts";
import type { ProviderBillingModel, ServerProvider } from "./server.ts";

/** Copilot's "default" model resolves server-side to a model Par3 cannot see. */
const COPILOT_DEFAULT_MODEL_SLUG = "default";

/**
 * Pi loads its MCP extension from a static file with no per-thread state, so it
 * cannot receive or drop the lead playbook mid-thread.
 */
const NON_LEAD_DRIVERS: ReadonlySet<string> = new Set(["pi"]);
const PER_REQUEST_DRIVERS: ReadonlySet<string> = new Set(["copilot"]);

export function sidekickDriverTraits(driver: ProviderDriverKind): {
  readonly sidekickLead: boolean;
  readonly billingModel: ProviderBillingModel;
} {
  return {
    sidekickLead: !NON_LEAD_DRIVERS.has(driver),
    billingModel: PER_REQUEST_DRIVERS.has(driver) ? "per_request" : "per_token",
  };
}

export function sameModelSelection(
  left: Pick<ModelSelection, "instanceId" | "model">,
  right: Pick<ModelSelection, "instanceId" | "model">,
): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

export function sidekickModelLabel(
  selection: Pick<ModelSelection, "instanceId" | "model">,
  provider: Pick<ServerProvider, "displayName" | "models"> | undefined,
): string {
  const model =
    provider?.models.find((candidate) => candidate.slug === selection.model)?.name ??
    selection.model;
  return `${model} · ${provider?.displayName ?? selection.instanceId}`;
}

/**
 * Why a sidekick selection cannot be chosen or used, or null when it can. The
 * server adds checks a client cannot see (a registered adapter, project
 * enablement, option descriptors); this covers what both sides share.
 */
export function sidekickSelectionProblem(input: {
  readonly lead: Pick<ModelSelection, "instanceId" | "model">;
  readonly sidekick: Pick<ModelSelection, "instanceId" | "model">;
  readonly providers: ReadonlyArray<ServerProvider>;
}): string | null {
  const { sidekick } = input;
  if (sameModelSelection(input.lead, sidekick)) {
    return "The sidekick is the same model as the lead.";
  }
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === sidekick.instanceId,
  );
  if (provider === undefined) return `Provider ${sidekick.instanceId} is not configured.`;
  return providerSidekickProblem(provider, sidekick.model);
}

function providerHealthProblem(provider: ServerProvider): string | null {
  const name = provider.displayName ?? provider.instanceId;
  if (provider.availability === "unavailable") {
    return provider.unavailableReason ?? `${name} is unavailable.`;
  }
  if (!provider.enabled) return `${name} is disabled.`;
  if (!provider.installed) return `${name} is not installed.`;
  if (provider.auth.status === "unauthenticated") return `${name} is signed out.`;
  if (provider.status === "error" || provider.status === "disabled") {
    return provider.message ?? `${name} is not ready.`;
  }
  return null;
}

function providerSidekickProblem(provider: ServerProvider, model: string): string | null {
  const health = providerHealthProblem(provider);
  if (health !== null) return health;
  if (provider.driver === "copilot" && model === COPILOT_DEFAULT_MODEL_SLUG) {
    return "Copilot Default hides which model runs. Pick a specific model.";
  }
  if (!provider.models.some((candidate) => candidate.slug === model)) {
    return `${provider.displayName ?? provider.instanceId} does not offer ${model}.`;
  }
  return null;
}

/** Whether a client may offer this model as the sidekick for a thread led by `lead`. */
export function isSidekickCandidateModel(
  provider: ServerProvider,
  model: string,
  lead: Pick<ModelSelection, "instanceId" | "model">,
): boolean {
  return (
    !sameModelSelection(lead, { instanceId: provider.instanceId, model }) &&
    providerSidekickProblem(provider, model) === null
  );
}
