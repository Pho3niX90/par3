import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Planetscale from "alchemy/Planetscale";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { relayDatabaseMode } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

export const PlanetscaleDatabase = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const schema = yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });

  const mode = relayDatabaseMode(stage);
  const database =
    mode === "shared-database"
      ? yield* Planetscale.PostgresDatabase("RelayPostgresDatabase", {
          name: "t3coderelay",
          region: { slug: "us-west" },
          clusterSize: "PS_80",
          migrations: { dir: schema.out, table: "relay_migrations" },
          replicas: 2,
        }).pipe(RemovalPolicy.retain())
      : yield* Planetscale.PostgresDatabase.ref("RelayPostgresDatabase", {
          stage: "prod",
        });
  const branch =
    mode === "stage-branch"
      ? yield* Planetscale.PostgresBranch("RelayPostgresBranch", {
          database,
          migrations: { dir: schema.out, table: "relay_migrations" },
        })
      : undefined;

  const runtimeRole = yield* Planetscale.PostgresRole("RelayPostgresRuntimeRole", {
    database,
    ...(branch ? { branch } : {}),
    inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  });

  return { branch, database, runtimeRole };
});

/**
 * A self-hosted Postgres behind a Cloudflare Access protected tunnel, used instead of
 * PlanetScale when RELAY_DB_HOST is set. Its migrations are applied by the deploy
 * workflow, not by Alchemy.
 */
export const RelaySelfHostedDatabase = Effect.gen(function* () {
  const host = yield* Config.String("RELAY_DB_HOST").pipe(Config.option);
  if (Option.isNone(host)) return Option.none();
  return Option.some({
    scheme: "postgres" as const,
    host: host.value,
    database: yield* Config.String("RELAY_DB_NAME"),
    user: yield* Config.String("RELAY_DB_USER"),
    password: yield* Config.Redacted("RELAY_DB_PASSWORD"),
    accessClientId: yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_ID"),
    accessClientSecret: yield* Config.Redacted("RELAY_DB_ACCESS_CLIENT_SECRET"),
  });
});

export const RelayHyperdrive = Effect.gen(function* () {
  const selfHosted = yield* RelaySelfHostedDatabase;
  const origin = Option.isSome(selfHosted)
    ? selfHosted.value
    : (yield* PlanetscaleDatabase).runtimeRole.origin;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    origin,
    caching: {
      disabled: true,
    },
    // 40 is sized for upstream's PlanetScale cluster. Cloudflare caps the limit at 20 on
    // plans without a raised Hyperdrive quota and rejects the deploy above it.
    originConnectionLimit: Option.isSome(selfHosted) ? 20 : 40,
    // Alchemy resolves the local-dev origin on every deploy and throws for an
    // Access-protected origin unless one is given. Locally, reach the database through
    // `cloudflared access tcp --url 127.0.0.1:15432`, as the deploy workflow does.
    ...(Option.isSome(selfHosted)
      ? {
          dev: {
            scheme: selfHosted.value.scheme,
            host: "127.0.0.1",
            port: 15432,
            database: selfHosted.value.database,
            user: selfHosted.value.user,
            password: selfHosted.value.password,
            sslmode: "disable" as const,
          },
        }
      : {}),
  });
});
