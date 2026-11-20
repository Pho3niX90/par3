import { normalizeJiraBaseUrl, normalizeJiraProjectKeys } from "@t3tools/shared/jira";
import { useGT } from "gt-react";
import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function parseProjectKeys(value: string): string[] {
  return normalizeJiraProjectKeys(value.split(/[\s,]+/));
}

/**
 * The Jira site that issue keys in branch names link to, and which project keys count. The site
 * and credentials belong to the environment; the project keys can differ per project.
 */
export function JiraSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const updateSettings = useUpdateScopedSettings();
  const jiraMixed = useScopedSettingsMixed(["jira"]);
  const keysMixed = useScopedSettingsMixed(["jiraProjectKeys"]);
  const edited = useRef(new Set<string>());
  const jira = settings.jira;
  const hasToken = !jiraMixed && jira.apiToken.length > 0;

  const textInput = (input: {
    field: "baseUrl" | "email";
    label: string;
    placeholder: string;
    type?: string;
  }) => (
    <Input
      key={`${scopeKey}:${jiraMixed}:${jira[input.field]}`}
      aria-label={input.label}
      type={input.type ?? "text"}
      autoCapitalize="none"
      spellCheck={false}
      placeholder={
        jiraMixed ? gt("Mixed", { $context: "values differ across targets" }) : input.placeholder
      }
      defaultValue={jiraMixed ? "" : jira[input.field]}
      onChange={() => edited.current.add(input.field)}
      onBlur={(event) => {
        const value = event.target.value.trim();
        if (edited.current.has(input.field) && (jiraMixed || value !== jira[input.field])) {
          updateSettings({ jira: { [input.field]: value } });
        }
        edited.current.delete(input.field);
      }}
    />
  );

  return (
    <SettingsSection id="jira" title={gt("Jira")}>
      <SettingsRow
        serverScoped
        settingKeys={["jira"]}
        {...searchableSetting("jira-site")}
        description={gt(
          "Issue keys in a thread's branch name link to this site. Leave empty to turn Jira off.",
        )}
        status={
          !jiraMixed && jira.baseUrl && normalizeJiraBaseUrl(jira.baseUrl) === null
            ? gt("This is not an http or https address, so issues will not link.")
            : undefined
        }
        resetAction={
          jira.baseUrl ? (
            <SettingResetButton
              ariaLabel={gt("Reset Jira site to default")}
              onClick={() => updateSettings({ jira: { baseUrl: "", email: "", apiToken: "" } })}
            />
          ) : null
        }
        control={textInput({
          field: "baseUrl",
          label: gt("Jira site URL"),
          placeholder: "https://company.atlassian.net",
          type: "url",
        })}
      />
      {jira.baseUrl || jiraMixed ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["jira"]}
            title={gt("Jira account email")}
            description={gt(
              "For Jira Cloud. Leave empty to use a personal access token on Jira Server or Data Center.",
            )}
            control={textInput({
              field: "email",
              label: gt("Jira account email"),
              placeholder: "you@company.test",
              type: "email",
            })}
          />
          <SettingsRow
            serverScoped
            settingKeys={["jira"]}
            title={gt("Jira API token")}
            description={gt(
              "Lets the thread panel show each issue's summary and status. Without it, issues only link to Jira.",
            )}
            status={hasToken ? gt("A token is saved on this environment.") : undefined}
            resetAction={
              hasToken ? (
                <SettingResetButton
                  ariaLabel={gt("Reset Jira API token to default")}
                  tooltip={gt("Remove the saved token")}
                  onClick={() => updateSettings({ jira: { apiToken: "" } })}
                />
              ) : null
            }
            control={
              <Input
                key={`${scopeKey}:${jiraMixed}:${hasToken}`}
                aria-label={gt("Jira API token")}
                type="password"
                autoComplete="off"
                placeholder={
                  hasToken ? gt("Saved; enter a new token to replace it") : gt("API token")
                }
                defaultValue=""
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  if (value.length > 0) updateSettings({ jira: { apiToken: value } });
                  event.target.value = "";
                }}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["jiraProjectKeys"]}
            {...searchableSetting("jira-project-keys")}
            description={gt(
              "Only these projects count as Jira issues, matched in any case and also in pull request titles. Leave empty to match any uppercase key in branch names.",
            )}
            resetAction={
              keysMixed || settings.jiraProjectKeys.length > 0 ? (
                <SettingResetButton
                  ariaLabel={gt("Reset Jira project keys to default")}
                  onClick={() => updateSettings({ jiraProjectKeys: [] })}
                />
              ) : null
            }
            control={
              <Input
                key={`${scopeKey}:${keysMixed}:${settings.jiraProjectKeys.join(",")}`}
                aria-label={gt("Jira project keys")}
                autoCapitalize="characters"
                spellCheck={false}
                placeholder={
                  keysMixed
                    ? gt("Mixed", { $context: "values differ across targets" })
                    : // oxlint-disable-next-line t3code/no-untranslated-copy -- example project keys
                      "ABC, OPS"
                }
                defaultValue={keysMixed ? "" : settings.jiraProjectKeys.join(", ")}
                onChange={() => edited.current.add("jiraProjectKeys")}
                onBlur={(event) => {
                  const keys = parseProjectKeys(event.target.value);
                  if (
                    edited.current.has("jiraProjectKeys") &&
                    (keysMixed || keys.join(",") !== settings.jiraProjectKeys.join(","))
                  ) {
                    updateSettings({ jiraProjectKeys: keys });
                  }
                  edited.current.delete("jiraProjectKeys");
                }}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
