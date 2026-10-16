import type { JiraSettings as JiraSettingsValue, ServerSettingsPatch } from "@t3tools/contracts";
import { normalizeJiraProjectKeys } from "@t3tools/shared/jira";
import { useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";

const INPUT_CLASS = "min-h-10 rounded-xl px-3 py-2 text-base text-foreground";

/**
 * The Jira site, credentials, and project keys, matching the web Integrations settings. `jira` and
 * `projectKeys` are null when the selected targets disagree.
 */
export function JiraSettings(props: {
  jira: JiraSettingsValue | null;
  projectKeys: ReadonlyArray<string> | null;
  siteDisabled: boolean;
  projectKeysDisabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const edited = useRef(new Set<string>());
  const jira = props.jira;
  const hasToken = jira !== null && jira.apiToken.length > 0;

  const field = (input: {
    field: "baseUrl" | "email";
    label: string;
    placeholder: string;
    keyboardType: "url" | "email-address";
  }) => (
    <AppTextInput
      key={`${input.field}:${jira?.[input.field] ?? "mixed"}`}
      accessibilityLabel={input.label}
      defaultValue={jira?.[input.field] ?? ""}
      placeholder={jira === null ? "Mixed" : input.placeholder}
      editable={!props.siteDisabled}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={input.keyboardType}
      className={INPUT_CLASS}
      onChangeText={() => edited.current.add(input.field)}
      onEndEditing={(event) => {
        const value = event.nativeEvent.text.trim();
        if (
          !props.siteDisabled &&
          edited.current.has(input.field) &&
          (jira === null || value !== jira[input.field])
        ) {
          props.onChange({ jira: { [input.field]: value } });
        }
        edited.current.delete(input.field);
      }}
    />
  );

  return (
    <SettingsSection title="Jira">
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          Issue keys in a thread's branch name link to this site. Leave empty to turn Jira off.
        </Text>
        {field({
          field: "baseUrl",
          label: "Jira site URL",
          placeholder: "https://company.atlassian.net",
          keyboardType: "url",
        })}
      </View>
      {jira === null || jira.baseUrl ? (
        <>
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm text-foreground-muted">
              Account email for Jira Cloud. Leave empty to use a personal access token on Jira
              Server or Data Center.
            </Text>
            {field({
              field: "email",
              label: "Jira account email",
              placeholder: "you@company.test",
              keyboardType: "email-address",
            })}
          </View>
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm text-foreground-muted">
              {hasToken
                ? "A token is saved. Enter a new one to replace it, or a single space to remove it."
                : "An API token shows each issue's summary and status."}
            </Text>
            <AppTextInput
              key={`token:${hasToken}`}
              accessibilityLabel="Jira API token"
              defaultValue=""
              placeholder={hasToken ? "Saved" : "API token"}
              editable={!props.siteDisabled}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              className={INPUT_CLASS}
              onEndEditing={(event) => {
                const raw = event.nativeEvent.text;
                if (props.siteDisabled || raw.length === 0) return;
                // Trimmed to empty removes the saved token.
                props.onChange({ jira: { apiToken: raw.trim() } });
              }}
            />
          </View>
          <View className="gap-2 px-4 py-3">
            <Text className="text-sm text-foreground-muted">
              Project keys, such as ABC, OPS. Only these count, in any case and in pull request
              titles too. Leave empty to match any uppercase key in branch names.
            </Text>
            <AppTextInput
              key={`keys:${props.projectKeys?.join(",") ?? "mixed"}`}
              accessibilityLabel="Jira project keys"
              defaultValue={props.projectKeys?.join(", ") ?? ""}
              placeholder={props.projectKeys === null ? "Mixed" : "ABC, OPS"}
              editable={!props.projectKeysDisabled}
              autoCapitalize="characters"
              autoCorrect={false}
              className={INPUT_CLASS}
              onChangeText={() => edited.current.add("jiraProjectKeys")}
              onEndEditing={(event) => {
                const keys = normalizeJiraProjectKeys(event.nativeEvent.text.split(/[\s,]+/));
                if (
                  !props.projectKeysDisabled &&
                  edited.current.has("jiraProjectKeys") &&
                  (props.projectKeys === null || keys.join(",") !== props.projectKeys.join(","))
                ) {
                  props.onChange({ jiraProjectKeys: keys });
                }
                edited.current.delete("jiraProjectKeys");
              }}
            />
          </View>
        </>
      ) : null}
    </SettingsSection>
  );
}
