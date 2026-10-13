import type { EnvironmentId, JiraIssueKey, ProjectId, ServerSettings } from "@t3tools/contracts";
import { findJiraIssueKeys, jiraIssueUrl, normalizeJiraBaseUrl } from "@t3tools/shared/jira";
import { useMemo } from "react";
import { Alert, Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { jiraEnvironment } from "../../../state/jira";
import { useEnvironmentQuery } from "../../../state/query";
import { SheetListRow } from "./gitSheetComponents";

/** Jira issues named in the thread's branch, mirroring the web thread details panel. */
export function JiraIssueRows(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings | null;
  readonly branch: string | null;
  readonly pullRequestTitle: string | null;
}) {
  const baseUrl = normalizeJiraBaseUrl(props.settings?.jira.baseUrl ?? "");
  const projectKeys =
    (props.projectId === null
      ? undefined
      : props.settings?.projectSettingsOverrides[props.projectId]?.jiraProjectKeys) ??
    props.settings?.jiraProjectKeys;
  const keys = useMemo(
    () =>
      baseUrl
        ? findJiraIssueKeys({
            branch: props.branch,
            texts: [props.pullRequestTitle],
            projectKeys: projectKeys ?? [],
          })
        : [],
    [baseUrl, projectKeys, props.branch, props.pullRequestTitle],
  );
  if (!baseUrl || keys.length === 0) return null;

  return (
    <View className="gap-2">
      <Text className="px-1 text-xs font-t3-bold text-foreground-muted">Jira</Text>
      <View className="overflow-hidden bg-card android:rounded-[20px] ios:rounded-2xl ios:border ios:border-border ios:px-3 ios:py-1">
        {keys.map((key, index) => (
          <View key={key}>
            {index > 0 && Platform.OS !== "android" ? (
              <View className="ml-12 h-px bg-border" />
            ) : null}
            <JiraIssueRow
              environmentId={props.environmentId}
              issueKey={key}
              url={jiraIssueUrl(baseUrl, key)}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

function JiraIssueRow(props: {
  readonly environmentId: EnvironmentId;
  readonly issueKey: JiraIssueKey;
  readonly url: string;
}) {
  const query = useEnvironmentQuery(
    jiraEnvironment.issue({ environmentId: props.environmentId, input: { key: props.issueKey } }),
  );
  const issue = query.data;
  return (
    <SheetListRow
      icon="ticket"
      title={issue?.summary ? `${props.issueKey} ${issue.summary}` : props.issueKey}
      subtitle={
        issue
          ? [issue.status?.name, issue.issueType, issue.assignee].filter(Boolean).join(" · ")
          : query.isPending
            ? "Status pending"
            : "Open in Jira"
      }
      onPress={() => {
        void tryOpenExternalUrl(props.url, "jira-issue").then((opened) => {
          if (!opened) Alert.alert("Unable to open issue", "The Jira issue could not be opened.");
        });
      }}
    />
  );
}
