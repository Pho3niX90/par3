import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A thread that asked for a spec but has no binding yet; the agent's spec_create or a person's
  // cancel is the only way out.
  yield* sql`CREATE TABLE spec_intakes (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
