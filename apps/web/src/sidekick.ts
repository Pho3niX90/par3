import {
  isSidekickCandidateModel,
  sidekickDriverTraits,
  sidekickModelLabel,
  sidekickSelectionProblem,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "./providerInstances";

type ModelRef = Pick<ModelSelection, "instanceId" | "model">;

interface SidekickModelOptionSource {
  readonly slug: string;
  readonly name: string;
  readonly isUnavailable?: boolean | undefined;
}

export const SIDEKICK_PER_REQUEST_HINT = "Billed per request: the lead batches work.";

export function providerCanLeadSidekick(provider: ServerProvider | null | undefined): boolean {
  if (!provider) return false;
  return provider.sidekickLead ?? sidekickDriverTraits(provider.driver).sidekickLead;
}

function providerBillsPerRequest(provider: ServerProvider): boolean {
  return (
    (provider.billingModel ?? sidekickDriverTraits(provider.driver).billingModel) === "per_request"
  );
}

export interface SidekickOption {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly name: string;
}

export interface SidekickOptionGroup {
  readonly entry: ProviderInstanceEntry;
  readonly perRequest: boolean;
  readonly options: ReadonlyArray<SidekickOption>;
}

/**
 * Models a thread led by `lead` may delegate to, grouped by provider instance.
 * `modelOptionsByInstance` carries the user's visible models (hidden ones
 * removed, custom ones added); instances without an entry fall back to the
 * provider's own list.
 */
export function sidekickOptionGroups(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance?: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<SidekickModelOptionSource>
  >;
  readonly lead: ModelRef;
}): ReadonlyArray<SidekickOptionGroup> {
  const groups: SidekickOptionGroup[] = [];
  for (const entry of input.entries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    const models: ReadonlyArray<SidekickModelOptionSource> =
      input.modelOptionsByInstance?.get(entry.instanceId) ?? entry.models;
    const options = models.flatMap((model) =>
      model.isUnavailable === true ||
      !isSidekickCandidateModel(entry.snapshot, model.slug, input.lead)
        ? []
        : [{ instanceId: entry.instanceId, model: model.slug, name: model.name }],
    );
    if (options.length === 0) continue;
    groups.push({ entry, perRequest: providerBillsPerRequest(entry.snapshot), options });
  }
  return groups;
}

export interface SidekickPairing {
  readonly selection: ModelSelection;
  readonly label: string;
  /** Why delegations ignore this sidekick right now, or null while it is active. */
  readonly problem: string | null;
  readonly perRequest: boolean;
}

export function resolveSidekickPairing(input: {
  readonly selection: ModelSelection | null | undefined;
  readonly lead: ModelRef;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
}): SidekickPairing | null {
  const { selection } = input;
  if (selection == null) return null;
  const entry = input.entries.find((candidate) => candidate.instanceId === selection.instanceId);
  const leadEntry = input.entries.find(
    (candidate) => candidate.instanceId === input.lead.instanceId,
  );
  const problem =
    leadEntry !== undefined && !providerCanLeadSidekick(leadEntry.snapshot)
      ? `${leadEntry.displayName} cannot lead with a sidekick.`
      : (sidekickSelectionProblem({
          lead: input.lead,
          sidekick: selection,
          providers: input.entries.map((candidate) => candidate.snapshot),
        }) ??
        (entry !== undefined && !entry.enabled
          ? `${entry.displayName} is disabled for this project.`
          : null));
  return {
    selection,
    label: sidekickModelLabel(
      selection,
      entry ? { displayName: entry.displayName, models: entry.models } : undefined,
    ),
    problem,
    perRequest: entry !== undefined && providerBillsPerRequest(entry.snapshot),
  };
}

export function sidekickOptionKey(selection: ModelRef): string {
  return `${selection.instanceId}\u0000${selection.model}`;
}
