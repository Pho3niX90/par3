import {
  isSidekickCandidateModel,
  sidekickDriverTraits,
  sidekickModelLabel,
  sidekickSelectionProblem,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

export type SidekickPickerModel = {
  readonly key: string;
  readonly label: string;
  readonly selection: ModelSelection;
};

export type SidekickPickerGroup = {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly billingHint: string | null;
  readonly models: ReadonlyArray<SidekickPickerModel>;
};

export type SidekickRowPresentation = {
  readonly value: string;
  /** Why the current selection will not be used; null when it is fine or off. */
  readonly problem: string | null;
};

type SidekickInput = {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly lead: ModelSelection;
  /** Project-level enablement the server also enforces. */
  readonly isInstanceEnabled: (instanceId: ProviderInstanceId) => boolean;
};

function providerLabel(provider: Pick<ServerProvider, "displayName" | "instanceId">): string {
  return provider.displayName ?? provider.instanceId;
}

function leadProblem(input: SidekickInput): string | null {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.lead.instanceId,
  );
  if (!provider) return "The lead provider is not configured.";
  const canLead = provider.sidekickLead ?? sidekickDriverTraits(provider.driver).sidekickLead;
  return canLead ? null : `${providerLabel(provider)} cannot lead a sidekick.`;
}

/**
 * The Sidekick row in thread settings, or null when it should be hidden. A set
 * selection stays visible even when it can no longer be used, so it can be cleared.
 */
export function resolveSidekickRow(
  input: SidekickInput & {
    readonly supported: boolean;
    readonly sidekick: ModelSelection | null;
  },
): SidekickRowPresentation | null {
  if (!input.supported) return null;
  const lead = leadProblem(input);
  const sidekick = input.sidekick;
  if (sidekick === null) return lead === null ? { value: "Off", problem: null } : null;
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === sidekick.instanceId,
  );
  const problem =
    lead ??
    sidekickSelectionProblem({ lead: input.lead, sidekick, providers: input.providers }) ??
    (input.isInstanceEnabled(sidekick.instanceId)
      ? null
      : `${provider ? providerLabel(provider) : sidekick.instanceId} is turned off for this project.`);
  return { value: sidekickModelLabel(sidekick, provider), problem };
}

export function sidekickBillingHint(provider: ServerProvider): string | null {
  const billing = provider.billingModel ?? sidekickDriverTraits(provider.driver).billingModel;
  return billing === "per_request" ? "Billed per request: the lead batches work." : null;
}

/** Models the lead may hand work to, grouped by provider instance. */
export function sidekickPickerGroups(input: SidekickInput): ReadonlyArray<SidekickPickerGroup> {
  return input.providers.flatMap((provider) => {
    if (!input.isInstanceEnabled(provider.instanceId)) return [];
    const models = provider.models
      .filter((model) => isSidekickCandidateModel(provider, model.slug, input.lead))
      .map((model) => ({
        key: `${provider.instanceId}:${model.slug}`,
        label: model.name,
        selection: { instanceId: provider.instanceId, model: model.slug },
      }));
    if (models.length === 0) return [];
    return [
      {
        instanceId: provider.instanceId,
        driver: provider.driver,
        iconUrl: provider.iconUrl,
        label: providerLabel(provider),
        billingHint: sidekickBillingHint(provider),
        models,
      },
    ];
  });
}
