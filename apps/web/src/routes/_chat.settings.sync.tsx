import { createFileRoute } from "@tanstack/react-router";

import { VaultSyncSettingsPanel } from "../components/settings/SyncSettings";

export const Route = createFileRoute("/_chat/settings/sync")({
  component: VaultSyncSettingsPanel,
});
