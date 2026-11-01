// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "@alchemy.run/axiom";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Drizzle from "@alchemy.run/drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Planetscale from "@alchemy.run/planetscale";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import {
  MobileSourceMapsUploadCredentials,
  relayAxiomEnabled,
  RelayObservability,
} from "./src/observability.ts";
import { isPreviewStage } from "./src/previewStages.ts";
import { PreviewTunnelSweep, PreviewTunnelSweepProvider } from "./src/previewTunnelSweep.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    // Providers resolve their credentials up front, so a self-hosted deploy without
    // Axiom or PlanetScale must leave those providers out entirely.
    providers: Layer.mergeAll(
      Cloudflare.providers(),
      Drizzle.providers(),
      ...(process.env.RELAY_AXIOM_ENABLED === "false" ? [] : [Axiom.providers()]),
      ...(process.env.RELAY_DB_HOST ? [] : [Planetscale.providers()]),
      PreviewTunnelSweepProvider(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const selfHostedDb = yield* RelayDb.RelaySelfHostedDatabase;
    const db = Option.isSome(selfHostedDb) ? undefined : yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = (yield* relayAxiomEnabled) ? yield* RelayObservability : undefined;
    const mobileSourceMapsUploadCredentials = observability
      ? yield* MobileSourceMapsUploadCredentials
      : undefined;
    const api = yield* RelayWorker.Api;
    const tracing = observability
      ? {
          mobileTracingUrl: observability.traces.otelTracesEndpoint,
          mobileTracingDataset: observability.traces.name,
          mobileTracingToken: observability.mobileIngestToken.token,
          clientTracingUrl: observability.traces.otelTracesEndpoint,
          clientTracingDataset: observability.traces.name,
          clientTracingToken: observability.clientIngestToken.token,
        }
      : {
          mobileTracingUrl: "",
          mobileTracingDataset: "",
          mobileTracingToken: Redacted.make(""),
          clientTracingUrl: "",
          clientTracingDataset: "",
          clientTracingToken: Redacted.make(""),
        };
    if (isPreviewStage(stage)) {
      const { managedEndpointZoneName } = yield* RelayDeploymentConfig;
      yield* PreviewTunnelSweep("PreviewTunnelSweep", {
        stage,
        tunnelZoneName: managedEndpointZoneName,
        workerName: api.workerName,
      });
    }
    yield* PublishClientConfig({
      url: api.url,
      ...tracing,
      tokenDigest: observability
        ? Output.map(
            Output.all(
              observability.mobileIngestToken.token,
              observability.clientIngestToken.token,
            ),
            tokenDigest,
          )
        : "tracing-disabled",
    });

    return {
      databaseName: db
        ? db.database.name
        : Option.match(selfHostedDb, { onNone: () => "", onSome: (self) => self.database }),
      databaseBranchName: db?.branch?.name ?? "main",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      ...tracing,
      ...(observability && mobileSourceMapsUploadCredentials
        ? {
            mobileLogsDataset: observability.mobileLogs.name,
            mobileMetricsDataset: observability.mobileMetrics.name,
            mobileSourceMapsBucket: observability.mobileSourceMaps.bucketName,
            // The MOBILE_SOURCEMAPS_R2 secret for GitHub Actions and EAS Build.
            mobileSourceMapsUploadCredentials,
          }
        : {}),
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
