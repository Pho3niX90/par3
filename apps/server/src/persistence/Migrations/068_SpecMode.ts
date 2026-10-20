import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE spec_documents (
    project_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    document_json TEXT NOT NULL,
    pending_files_json TEXT,
    PRIMARY KEY (workspace_path, slug)
  )`;
  yield* sql`CREATE TABLE spec_mutations (
    command_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    result_json TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE spec_bindings (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    role TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX spec_bindings_spec ON spec_bindings(workspace_path, slug)`;
  yield* sql`CREATE TABLE spec_run_bindings (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    role TEXT NOT NULL,
    requirements_hash TEXT NOT NULL,
    revision INTEGER NOT NULL
  )`;
});
