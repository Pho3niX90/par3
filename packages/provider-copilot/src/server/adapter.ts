/**
 * GitHub Copilot adapter implementation for Orchestration V2.
 *
 * @module provider-copilot/server/adapter
 */
import { ProviderDriverKind, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { CopilotSettings } from "../settings.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  applyCopilotAcpModelSelection,
  copilotApprovalOptions,
  makeCopilotAcpRuntime,
  resolveCopilotAcpBaseModelId,
} from "./acpSupport.ts";
import {
  copilotClientCapabilitiesMeta,
  extractCopilotSubagentUpdate,
  isCopilotLostSessionError,
  makeCopilotNoticeFilter,
  makeCopilotSubagentRouting,
} from "@t3tools/provider-acp/server/copilotAcp";
import { copilotPromptFailure } from "./copilotFailure.ts";
import { copilotModelsFromSessionSetup, type CopilotAdvertisedModel } from "./modelDiscovery.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { type ProviderAdapterDriverCreateInput } from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { copilotLaunchEnvironment } from "./enterpriseHost.ts";
import { discoverCopilotSkills, rewriteCopilotSkillMentions } from "./skills.ts";

const COPILOT_PROVIDER = ProviderDriverKind.make("copilot");

// In-session model switching is negotiated per session from the agent's advertised
// config options, so it is not claimed here.
const CopilotProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: false,
    canForkFromTurn: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

interface CopilotAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CopilotSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  /** Receives the models a started session advertises, so the model picker can list them. */
  readonly onModelsAdvertised?: (
    models: ReadonlyArray<CopilotAdvertisedModel>,
  ) => Effect.Effect<void>;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

function makeCopilotAcpAdapterFlavor(
  options: CopilotAdapterV2Options,
  services: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path },
): AcpAdapterV2Flavor {
  const routing = makeCopilotSubagentRouting();
  // An empty advertisement means the session offered no model list, not that there are no models.
  const advertiseModels = (models: ReadonlyArray<CopilotAdvertisedModel>): Effect.Effect<void> =>
    options.onModelsAdvertised === undefined || models.length === 0
      ? Effect.void
      : options.onModelsAdvertised(models);

  return {
    driver: COPILOT_PROVIDER,
    capabilities: CopilotProviderCapabilitiesV2,
    // Copilot rejects client-supplied stdio MCP servers.
    mcpOverHttp: true,
    promptFailure: copilotPromptFailure,
    clientCapabilitiesMeta: copilotClientCapabilitiesMeta,
    registerExtensions: routing.registerExtensions,
    normalizeSessionUpdate: routing.normalizeSessionUpdate,
    ...makeCopilotNoticeFilter(),
    extractSubagentUpdate: extractCopilotSubagentUpdate,
    restartRuntimeAfterPromptError: isCopilotLostSessionError,
    // Skills are looked up again only for a prompt that names one, so other `$` text stays.
    rewriteUserText: (text, turnInput) =>
      /\p{Sc}/u.test(text)
        ? discoverCopilotSkills(turnInput.runtimePolicy.cwd ?? undefined, options.environment).pipe(
            Effect.map((skills) => rewriteCopilotSkillMentions(text, skills)),
            Effect.provideService(FileSystem.FileSystem, services.fileSystem),
            Effect.provideService(Path.Path, services.path),
          )
        : Effect.succeed(text),
    approvalOptions: copilotApprovalOptions,
    resolveModelId: (selection) => resolveCopilotAcpBaseModelId(selection.model),
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      advertiseModels(copilotModelsFromSessionSetup(startResult.sessionSetupResult)).pipe(
        Effect.andThen(
          applyCopilotAcpModelSelection({
            runtime,
            sessionSetupResult: startResult.sessionSetupResult,
            requestedModelId: resolveCopilotAcpBaseModelId(modelSelection.model),
          }),
        ),
      ),
    onSessionConfigurationUpdate: (configOptions) =>
      advertiseModels(copilotModelsFromSessionSetup({ configOptions })),
    makeRuntime:
      options.makeRuntime ??
      ((input) =>
        makeCopilotAcpRuntime({
          ...input,
          copilotSettings: options.settings,
          environment: options.environment,
        })),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeCopilotAdapterV2 = Effect.fn("makeCopilotAdapterV2")(function* (
  options: CopilotAdapterV2Options,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCopilotAcpAdapterFlavor(options, { fileSystem, path }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type CopilotAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers;

/**
 * Builds one instance's adapter from driver input. The driver passes `onModelsAdvertised` so the
 * models a started session reports reach that instance's snapshot.
 */
export const makeCopilotAdapterV2ForInstance = Effect.fn("makeCopilotAdapterV2ForInstance")(
  function* (
    input: ProviderAdapterDriverCreateInput<CopilotSettings>,
    extras?: Pick<CopilotAdapterV2Options, "onModelsAdvertised">,
  ) {
    const hostEnvironment = yield* HostProcess.Environment;
    const processEnv = yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment);
    const selfInvocation = yield* resolveSelfInvocation();
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();

    return yield* makeCopilotAdapterV2({
      instanceId: input.instanceId,
      settings: { ...input.config, enabled: input.enabled },
      environment: copilotLaunchEnvironment(input.config, processEnv),
      selfInvocation,
      continuationRequests,
      ...(extras?.onModelsAdvertised === undefined
        ? {}
        : { onModelsAdvertised: extras.onModelsAdvertised }),
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: COPILOT_PROVIDER,
          threadId,
        }),
    });
  },
);
