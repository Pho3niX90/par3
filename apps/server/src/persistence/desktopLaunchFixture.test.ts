import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { OrchestrationV2AppThreadJson } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BUILD_MIGRATION_HEAD } from "./databaseMigrationHead.ts";
import { runMigrations } from "./Migrations.ts";

const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);

// Release jobs open this snapshot in the packaged app, and only they would otherwise notice a
// history this build refuses: an upstream copy of it records upstream's migration ids.
it.effect("the desktop launch fixture migrates forward and its threads still decode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launch-fixture-" });
    const filename = path.join(directory, "statev2.sqlite");
    yield* fs.copyFile(
      path.join(import.meta.dirname, "../../../../scripts/fixtures/desktop-launch/statev2.sqlite"),
      filename,
    );
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const [head] = yield* sql<{
        readonly id: number;
      }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
      assert.equal(head?.id, BUILD_MIGRATION_HEAD);
      const rows = yield* sql<{
        readonly payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads`;
      const threads = yield* Effect.forEach(rows, (row) => decodeThread(row.payload_json));
      assert.include(
        threads.map((thread) => thread.title),
        "Release launch check",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
