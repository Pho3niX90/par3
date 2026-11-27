import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { hasRelayTracingConfig } from "../../cloud/publicConfig";
import { isHostedStaticApp } from "../../hostedPairing";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { managedTelemetryOffMessage } from "../../state/managedPolicy";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { Switch } from "../ui/switch";
import { isConnectedWithConfig } from "./scopedSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useSettingsScope } from "./SettingsScopeContext";

export function TelemetrySettingsPanel() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        {gt(
          "Control what anonymous usage data and connection diagnostics Par3 sends. Everything here is off until you turn it on.",
        )}
      </p>
      <UsageDataSettings />
    </SettingsPageContainer>
  );
}

function UsageDataSettings() {
  const gt = useGT();
  const { environments: scopedEnvironments } = useSettingsScope();
  const { environments: allEnvironments } = useEnvironments();
  const showDeviceRow = isHostedStaticApp() && hasRelayTracingConfig();
  const showEnvironmentTitle = scopedEnvironments.length > 1;

  return (
    <>
      <SettingsSection title={gt("Usage data")} id="usage-data">
        {scopedEnvironments.length > 0 ? (
          scopedEnvironments.map((environment) => (
            <ServerUsageDataRow
              key={environment.environmentId}
              environment={environment}
              environmentLabel={settingsScopeEnvironmentLabel(environment, allEnvironments)}
              showEnvironmentTitle={showEnvironmentTitle}
            />
          ))
        ) : (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            {gt("Connect an environment to configure its usage data setting.")}
          </p>
        )}
      </SettingsSection>
      {showDeviceRow ? (
        <SettingsSection title={gt("This device")} id="usage-data-device-section">
          <DeviceRelayDiagnosticsRow />
        </SettingsSection>
      ) : null}
    </>
  );
}

function ServerUsageDataRow({
  environment,
  environmentLabel,
  showEnvironmentTitle,
}: {
  readonly environment: EnvironmentPresentation;
  readonly environmentLabel: string;
  readonly showEnvironmentTitle: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const [saving, setSaving] = useState(false);
  const environmentId = environment.environmentId;
  const canEdit = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const connected = isConnectedWithConfig(environment);
  const serverConfig = connected ? environment.serverConfig : null;

  const title = showEnvironmentTitle ? environmentLabel : gt("Send usage data");
  const description = showEnvironmentTitle
    ? gt(
        "Send usage data: anonymous product usage events and connection diagnostics from this server and the apps opened from it. Never includes prompts, responses, or file contents.",
      )
    : gt(
        "Send anonymous product usage events and connection diagnostics from this server and the apps opened from it. Never includes prompts, responses, or file contents.",
      );
  const rowId = showEnvironmentTitle ? `usage-data-server-${environmentId}` : "usage-data-server";

  if (serverConfig === null) {
    return (
      <SettingsRow
        id={rowId}
        aria-disabled="true"
        title={title}
        description={description}
        status={<span>{gt("Reconnect to change this setting.")}</span>}
        control={<span className="text-xs text-muted-foreground">{gt("Offline")}</span>}
      />
    );
  }

  const managedDenial = managedTelemetryOffMessage(serverConfig.managedPolicy, messages);
  const observability = serverConfig.observability;
  if (observability === undefined && managedDenial === undefined) {
    return (
      <SettingsRow
        id={rowId}
        aria-disabled="true"
        title={title}
        description={description}
        status={<span>{gt("Update this server to change usage data settings here.")}</span>}
      />
    );
  }
  const olderServer = observability !== undefined && observability.telemetrySource === undefined;
  const envForced = observability?.telemetrySource === "environment";
  const envVariable = observability?.telemetryVariable ?? "T3CODE_TELEMETRY_ENABLED";
  const envForcedValue = observability?.telemetryEnabled === true;

  const effectiveChecked =
    managedDenial !== undefined
      ? false
      : olderServer
        ? observability.relayTracingAllowed !== false
        : envForced
          ? envForcedValue
          : serverConfig.settings.telemetryEnabled;
  const disabled = managedDenial !== undefined || olderServer || envForced || !canEdit || saving;

  const status =
    managedDenial !== undefined ? (
      <span>{managedDenial}</span>
    ) : olderServer ? (
      <span>{gt("Update this server to change usage data settings here.")}</span>
    ) : envForced ? (
      <div className="flex flex-wrap items-center gap-1.5">
        <ConnectionStatusDot
          dotClassName={envForcedValue ? "bg-success" : "bg-muted-foreground/40"}
        />
        <span>
          <T>
            Set by environment ·{" "}
            <code className="font-mono">
              <Var>{envVariable}</Var>
            </code>
          </T>
        </span>
      </div>
    ) : !canEdit ? (
      <span>
        {gt("This connection lacks permission to change settings on {environment}.", {
          environment: environmentLabel,
        })}
      </span>
    ) : undefined;

  const switchLabel = showEnvironmentTitle
    ? gt("Send usage data on {environment}", { environment: environmentLabel })
    : gt("Send usage data");

  return (
    <SettingsRow
      id={rowId}
      title={title}
      description={description}
      status={status}
      managed={managedDenial}
      control={
        <Switch
          aria-label={switchLabel}
          checked={effectiveChecked}
          disabled={disabled}
          onCheckedChange={async (checked) => {
            if (disabled) return;
            setSaving(true);
            await updateSettings({
              environmentId,
              input: { patch: { telemetryEnabled: checked } },
            });
            setSaving(false);
          }}
        />
      }
    />
  );
}

function DeviceRelayDiagnosticsRow() {
  const gt = useGT();
  const enabled = useClientSettings((settings) => settings.relayDiagnosticsEnabled);

  return (
    <SettingsRow
      id="usage-data-device"
      title={gt("Send connection diagnostics from this device")}
      description={gt(
        "Send connection timing traces from this browser to help diagnose Parity Connect issues.",
      )}
      devicePreference
      control={
        <Switch
          aria-label={gt("Send connection diagnostics from this device")}
          checked={enabled}
          onCheckedChange={(checked) => {
            void updateClientSettings({ relayDiagnosticsEnabled: checked });
          }}
        />
      }
    />
  );
}
