/**
 * GitHub Copilot status probe and version checking.
 *
 * The probe only runs `copilot --version`. Opening an ACP session can start MCP servers
 * or hooks, so the probe never does. Models the CLI advertises are learned from sessions that
 * start for real (see `modelDiscovery.ts`) and merged in by `applyAdvertisedCopilotModels`;
 * until then only the CLI default and custom model settings are listed.
 *
 * @module provider-copilot/server/status
 */
import type {
  CustomModelSetting,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import type { CopilotSettings } from "../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { COPILOT_DEFAULT_MODEL_SLUG, COPILOT_SUPPORTED_RUNTIME_MODES } from "./acpSupport.ts";
import {
  copilotUsagePageUrl,
  isEnterpriseHost,
  normalizeEnterpriseHost,
} from "./enterpriseHost.ts";
import type { CopilotAdvertisedModel } from "./modelDiscovery.ts";

const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: COPILOT_SUPPORTED_RUNTIME_MODES,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;

/**
 * Only the CLI's own default model is built in. Valid model ids depend on the user's plan and
 * change with the CLI, so other models come from what a live session advertises or from custom
 * models, never from a list guessed here.
 */
const COPILOT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: COPILOT_DEFAULT_MODEL_SLUG,
    name: "Copilot Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const COPILOT_SLASH_COMMANDS = [COMPACT_SLASH_COMMAND];

function copilotModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  advertisedModels: ReadonlyArray<CopilotAdvertisedModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [
      ...COPILOT_BUILT_IN_MODELS,
      ...advertisedModels.map((model): ServerProviderModel => ({
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      })),
    ],
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

/** Lists the CLI default, then advertised models, then custom models not already listed. */
export function applyAdvertisedCopilotModels<
  Snapshot extends { readonly models: ReadonlyArray<ServerProviderModel> },
>(
  snapshot: Snapshot,
  advertisedModels: ReadonlyArray<CopilotAdvertisedModel>,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): Snapshot {
  return advertisedModels.length === 0
    ? snapshot
    : { ...snapshot, models: copilotModelsFromSettings(customModels, advertisedModels) };
}

export const buildInitialCopilotProviderSnapshot = Effect.fn(
  "CopilotProviderStatus.buildInitialCopilotProviderSnapshot",
)(function* (copilotSettings: CopilotSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = copilotModelsFromSettings(copilotSettings.customModels);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot CLI availability...",
    },
  });
});

const runCopilotCliCommand = Effect.fn("CopilotProviderStatus.runCopilotCliCommand")(function* (
  copilotSettings: CopilotSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = copilotSettings.binaryPath || "copilot";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  copilotSettings: CopilotSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = copilotModelsFromSettings(copilotSettings.customModels);

  if (!copilotSettings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const host = normalizeEnterpriseHost(copilotSettings.enterpriseUrl);

  const versionResult = yield* runCopilotCliCommand(
    copilotSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Copilot CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Copilot CLI (`copilot`) is not installed or not on PATH."
          : "Failed to execute Copilot CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Copilot CLI is installed but timed out while running `copilot --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: copilotSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Copilot CLI exited with code ${versionOutput.code}.`,
      },
    });
  }

  // Nothing here can tell whether a token or login is valid without opening a session, so
  // auth stays "unknown" and the message says which credential the instance will use.
  const hasToken = Boolean(copilotSettings.enterpriseToken?.trim());
  const target = isEnterpriseHost(host) ? ` Targeting ${host}.` : "";
  const credential = hasToken
    ? " Using the access token from settings."
    : " Run `copilot login` if prompts fail to authenticate.";

  // GitHub shows credits used and the allowance on the account's Copilot settings page, and
  // nothing the CLI exposes reports them, so usage is a link rather than a bar.
  const usageUrl = copilotUsagePageUrl(copilotSettings.enterpriseUrl);

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: copilotSettings.enabled,
    checkedAt,
    models,
    slashCommands: COPILOT_SLASH_COMMANDS,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message: `GitHub Copilot CLI ${version ?? "available"}.${target}${credential} Copilot Free and Student plans use automatic model selection.`,
      ...(usageUrl === undefined
        ? {}
        : {
            usageLimits: {
              checkedAt,
              windows: [],
              unavailable: {
                reason: "unsupported" as const,
                message:
                  "GitHub tracks Copilot usage on your account. Open your Copilot settings to see your credits used and your allowance.",
              },
              externalUsage: { label: "GitHub Copilot usage", url: usageUrl },
            },
          }),
    },
  });
});

export const enrichCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}): Effect.Effect<
  void,
  never,
  HttpClient.HttpClient | ProviderLatestVersions.ProviderLatestVersions
> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)));
};
