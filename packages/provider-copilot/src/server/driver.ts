/**
 * GitHub Copilot server driver: lifecycle, health checks, updates, and orchestration.
 *
 * @module provider-copilot/server/driver
 */
import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { CopilotSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeCopilotAdapterV2ForInstance, type CopilotAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  applyAdvertisedCopilotModels,
  buildInitialCopilotProviderSnapshot,
  checkCopilotProviderStatus,
  enrichCopilotSnapshot,
} from "./status.ts";
import type { CopilotAdvertisedModel } from "./modelDiscovery.ts";
import { probeCopilotModels } from "./modelProbe.ts";
import { makeCopilotTextGeneration } from "./textGeneration.ts";
import { makeCopilotAcpRuntime } from "./acpSupport.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { copilotLaunchEnvironment } from "./enterpriseHost.ts";

const decodeCopilotSettings = Schema.decodeSync(CopilotSettings);

const DRIVER_KIND = ProviderDriverKind.make("copilot");
const COPILOT_NPM_PACKAGE = "@github/copilot";

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: COPILOT_NPM_PACKAGE,
  nativeUpdate: { args: ["update"] },
});

export type CopilotDriverEnv =
  | CopilotAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const CopilotDriver: ProviderDriver<CopilotSettings, CopilotDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "GitHub Copilot",
    supportsMultipleInstances: true,
  },
  configSchema: CopilotSettings,
  defaultConfig: (): CopilotSettings => decodeCopilotSettings({}),
  create: Effect.fn("CopilotDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies CopilotSettings;

    const launchEnv = copilotLaunchEnvironment(effectiveConfig, processEnv);

    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: launchEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );

    // Models Copilot advertises, from a one-shot discovery session and from every started
    // session. The version check never opens a session itself.
    const advertisedModels = yield* SubscriptionRef.make<ReadonlyArray<CopilotAdvertisedModel>>([]);

    const textGeneration = yield* makeCopilotTextGeneration(effectiveConfig, launchEnv).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
    );

    const orchestrationAdapter = yield* makeCopilotAdapterV2ForInstance(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: effectiveConfig,
      },
      {
        onModelsAdvertised: (models) =>
          SubscriptionRef.get(advertisedModels).pipe(
            Effect.flatMap((known) =>
              known.length === 0
                ? Effect.logInfo("GitHub Copilot advertised models to a session.", {
                    count: models.length,
                  })
                : Effect.void,
            ),
            Effect.andThen(SubscriptionRef.set(advertisedModels, models)),
          ),
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build GitHub Copilot orchestration adapter.",
            cause,
          }),
      ),
    );

    const checkProvider = checkCopilotProviderStatus(effectiveConfig, launchEnv).pipe(
      Effect.map(stampIdentity),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CopilotSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCopilotProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, getSnapshot, publishSnapshot }) => {
        const { customModels } = settings.provider;
        // Both publishers rebuild the model list from the latest advertisement, so whichever
        // publishes last never drops models the other one added.
        const publishWithAdvertisedModels = (next: ServerProvider) =>
          SubscriptionRef.get(advertisedModels).pipe(
            Effect.flatMap((models) =>
              publishSnapshot(applyAdvertisedCopilotModels(next, models, customModels)),
            ),
          );
        const enrichment = resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichCopilotSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot: publishWithAdvertisedModels,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        );
        // `changes` replays the current value, so a refresh that rebuilt the snapshot from the
        // version probe lists the advertised models again straight away.
        const advertisedModelUpdates = SubscriptionRef.changes(advertisedModels).pipe(
          Stream.filter((models) => models.length > 0),
          Stream.runForEach(() => getSnapshot.pipe(Effect.flatMap(publishWithAdvertisedModels))),
        );
        // Once per driver instance, as soon as the CLI is found working, so the picker has the
        // CLI's models before the first thread. A started session advertises them as well.
        const discoverModels =
          currentSnapshot.installed && currentSnapshot.status === "ready"
            ? SubscriptionRef.get(advertisedModels).pipe(
                Effect.flatMap((known) =>
                  known.length > 0
                    ? Effect.void
                    : probeCopilotModels({
                        makeRuntime: Effect.gen(function* () {
                          const cwd = yield* fileSystem.makeTempDirectoryScoped({
                            prefix: "t3-copilot-models-",
                          });
                          return yield* makeCopilotAcpRuntime({
                            copilotSettings: effectiveConfig,
                            environment: launchEnv,
                            cwd,
                            clientInfo: { name: "t3-code-model-discovery", version: "0.0.0" },
                            clientCapabilities: {
                              fs: { readTextFile: false, writeTextFile: false },
                              terminal: false,
                            },
                            // Never start a login flow from a background check.
                            authenticateOnAuthRequired: false,
                          });
                        }).pipe(
                          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                          Effect.provideService(Crypto.Crypto, crypto),
                        ),
                      }).pipe(
                        Effect.flatMap((models) =>
                          models.length > 0
                            ? Effect.logInfo("GitHub Copilot model discovery found models.", {
                                count: models.length,
                              }).pipe(Effect.andThen(SubscriptionRef.set(advertisedModels, models)))
                            : Effect.void,
                        ),
                      ),
                ),
              )
            : Effect.void;
        return Effect.all([enrichment, advertisedModelUpdates, discoverModels], {
          concurrency: "unbounded",
          discard: true,
        });
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build GitHub Copilot snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration,
    };
  }),
};
