import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";

import { useEnvironmentSupportsSpecMode } from "../../specs/state";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function SpecModeSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { target } = useSettingsScope();
  const supported = useEnvironmentSupportsSpecMode(target?.environmentId ?? null);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["specModeEnabled"]);
  const navigate = useNavigate();
  if (!supported || !target) return null;
  const { environmentId, projectId } = target;

  return (
    <SettingsSection title={gt("Spec mode")}>
      <SettingsRow
        serverScoped
        settingKeys={["specModeEnabled"]}
        mixed={mixed}
        {...searchableSetting("spec-mode")}
        description={gt(
          "Offer Spec in the composer for requirements a person approves before agents implement them. Only threads bound to a spec are affected. Existing specs stay viewable when this is off.",
        )}
        resetAction={
          settings.specModeEnabled !== DEFAULT_SERVER_SETTINGS.specModeEnabled ? (
            <SettingResetButton
              ariaLabel={gt("Reset Spec mode to default")}
              onClick={() =>
                updateSettings({ specModeEnabled: DEFAULT_SERVER_SETTINGS.specModeEnabled })
              }
            />
          ) : null
        }
        control={
          <Switch
            aria-label={gt("Spec mode")}
            mixed={mixed}
            checked={mixed ? false : settings.specModeEnabled}
            onCheckedChange={(enabled) => updateSettings({ specModeEnabled: enabled })}
          />
        }
      />
      {projectId ? (
        <SettingsRow
          title={gt("Specs")}
          description={gt("Review and approve this project's specs.")}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: "/specs",
                  search: { environment: environmentId, project: projectId },
                })
              }
            >
              <T>Open specs</T>
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
