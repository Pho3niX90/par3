import { createFileRoute } from "@tanstack/react-router";
import { TelemetrySettingsPanel } from "../components/settings/UsageDataSettings";

export const Route = createFileRoute("/_chat/settings/telemetry")({
  component: TelemetrySettingsPanel,
});
