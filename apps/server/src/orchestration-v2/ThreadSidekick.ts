import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProjectId,
  type ProviderBillingModel,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  sidekickDriverTraits,
  sidekickModelLabel,
  sidekickSelectionProblem,
} from "@t3tools/contracts";
import type { T3SidekickLeadState } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { invalidOptionSelections } from "../provider/providerOptionSelections.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

export class ThreadSidekickInvalidError extends Schema.TaggedError<ThreadSidekickInvalidError>()(
  "ThreadSidekickInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `This sidekick cannot be used: ${this.reason}`;
  }
}

export interface ThreadSidekickStatus {
  readonly selection: ModelSelection;
  readonly label: string;
  readonly billingModel: ProviderBillingModel;
  /** Why the pairing does nothing right now, or null when delegations use it. */
  readonly inactiveReason: string | null;
}

export class ThreadSidekick extends Context.Service<
  ThreadSidekick,
  {
    /** Checks a selection before it is stored on a thread. */
    readonly validate: (input: {
      readonly projectId: ProjectId;
      readonly lead: ModelSelection;
      readonly sidekick: ModelSelection;
    }) => Effect.Effect<void, ThreadSidekickInvalidError>;
    readonly status: (
      thread: Pick<
        OrchestrationV2AppThread,
        "projectId" | "modelSelection" | "sidekickModelSelection"
      >,
    ) => Effect.Effect<ThreadSidekickStatus | null>;
    /** What the lead's provider is told this turn; null while off or inactive. */
    readonly leadStateForTurn: (
      thread: Pick<
        OrchestrationV2AppThread,
        "projectId" | "modelSelection" | "sidekickModelSelection"
      >,
    ) => Effect.Effect<T3SidekickLeadState | null>;
  }
>()("t3/orchestration-v2/ThreadSidekick") {}

const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const problem = Effect.fn("ThreadSidekick.problem")(function* (input: {
    readonly projectId: ProjectId;
    readonly lead: ModelSelection;
    readonly sidekick: ModelSelection;
    readonly providers: ReadonlyArray<ServerProvider>;
  }) {
    const leadProvider = input.providers.find(
      (provider) => provider.instanceId === input.lead.instanceId,
    );
    if (
      leadProvider !== undefined &&
      !(leadProvider.sidekickLead ?? sidekickDriverTraits(leadProvider.driver).sidekickLead)
    ) {
      return `${leadProvider.displayName ?? leadProvider.instanceId} cannot lead with a sidekick.`;
    }
    const shared = sidekickSelectionProblem(input);
    if (shared !== null) return shared;
    const registered = yield* providerAdapters.list();
    if (!registered.includes(input.sidekick.instanceId)) {
      return `${input.sidekick.instanceId} cannot run delegated tasks.`;
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
    if (
      !resolveProjectProviderInstanceEnabled(settings, input.projectId, input.sidekick.instanceId)
    ) {
      return `${input.sidekick.instanceId} is disabled for this project.`;
    }
    const descriptors = input.providers
      .find((provider) => provider.instanceId === input.sidekick.instanceId)
      ?.models.find((model) => model.slug === input.sidekick.model)
      ?.capabilities?.optionDescriptors;
    const invalidOptions = invalidOptionSelections(input.sidekick.options ?? [], descriptors);
    return invalidOptions.length > 0 ? invalidOptions.join(" ") : null;
  });

  const status = Effect.fn("ThreadSidekick.status")(function* (
    thread: Parameters<ThreadSidekick["Service"]["status"]>[0],
  ) {
    const sidekick = thread.sidekickModelSelection;
    if (sidekick == null) return null;
    const providers = yield* providerRegistry.getProviders;
    const provider = providers.find((candidate) => candidate.instanceId === sidekick.instanceId);
    return {
      selection: sidekick,
      label: sidekickModelLabel(sidekick, provider),
      billingModel:
        provider?.billingModel ??
        (provider === undefined ? "per_token" : sidekickDriverTraits(provider.driver).billingModel),
      inactiveReason: yield* problem({
        projectId: thread.projectId,
        lead: thread.modelSelection,
        sidekick,
        providers,
      }),
    };
  });

  return ThreadSidekick.of({
    validate: Effect.fn("ThreadSidekick.validate")(function* (input) {
      const reason = yield* problem({ ...input, providers: yield* providerRegistry.getProviders });
      if (reason !== null) return yield* new ThreadSidekickInvalidError({ reason });
    }),
    status,
    leadStateForTurn: Effect.fn("ThreadSidekick.leadStateForTurn")(function* (thread) {
      const current = yield* status(thread);
      return current === null || current.inactiveReason !== null
        ? null
        : { label: current.label, billingModel: current.billingModel };
    }),
  });
});

export const layer = Layer.effect(ThreadSidekick, make);
