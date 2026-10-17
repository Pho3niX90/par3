// Applies the relay migrations to a self-hosted Postgres (RELAY_DB_HOST). PlanetScale
// deploys apply them through Alchemy instead. deploy-relay.yml runs this through the
// database tunnel with RELAY_DB_MIGRATION_URL pointing at the local tunnel end.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./migrations/postgres",
  dbCredentials: { url: process.env.RELAY_DB_MIGRATION_URL ?? "" },
  migrations: { table: "relay_migrations" },
});
