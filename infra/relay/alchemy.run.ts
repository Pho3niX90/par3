// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Planetscale from "alchemy/Planetscale";

import { PublishClientConfig, tokenDigest } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { relayAxiomEnabled, RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Drizzle.providers(),
      Planetscale.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const selfHostedDb = yield* RelayDb.RelaySelfHostedDatabase;
    const db = Option.isSome(selfHostedDb) ? undefined : yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = (yield* relayAxiomEnabled) ? yield* RelayObservability : undefined;
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
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
