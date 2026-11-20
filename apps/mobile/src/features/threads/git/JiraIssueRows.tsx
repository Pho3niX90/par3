import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  JiraIssueKey,
  ProjectId,
  ScopedThreadRef,
  ServerSettings,
} from "@t3tools/contracts";
import { findJiraIssueKeys, jiraIssueUrl, normalizeJiraBaseUrl } from "@t3tools/shared/jira";
import { useGT } from "gt-react-native";
import { useMemo } from "react";
import { Alert } from "react-native";

import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { jiraEnvironment, threadJiraMentions } from "../../../state/jira";
import { useEnvironmentQuery } from "../../../state/query";

/** Jira issues named in the thread's branch or chat, mirroring the web thread details panel. */
export function JiraIssueRows(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadRef: ScopedThreadRef;
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
  const mentionedKeys = useAtomValue(
    threadJiraMentions.mentionsAtom(baseUrl ? props.threadRef : null, projectKeys ?? []),
  );
  const keys = useMemo(
    () =>
      baseUrl
        ? [
            ...new Set([
              ...findJiraIssueKeys({
                branch: props.branch,
                texts: [props.pullRequestTitle],
                projectKeys: projectKeys ?? [],
              }),
              ...mentionedKeys,
            ]),
          ]
        : [],
    [baseUrl, mentionedKeys, projectKeys, props.branch, props.pullRequestTitle],
  );
  if (!baseUrl || keys.length === 0) return null;

  return (
    // oxlint-disable-next-line t3code/no-untranslated-copy -- Jira is a product name
    <ListSection title="Jira">
      {keys.map((key) => (
        <JiraIssueRow
          key={key}
          environmentId={props.environmentId}
          issueKey={key}
          url={jiraIssueUrl(baseUrl, key)}
        />
      ))}
    </ListSection>
  );
}

function JiraIssueRow(props: {
  readonly environmentId: EnvironmentId;
  readonly issueKey: JiraIssueKey;
  readonly url: string;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    jiraEnvironment.issue({ environmentId: props.environmentId, input: { key: props.issueKey } }),
  );
  const issue = query.data;
  return (
    <ListRow
      icon="ticket"
      label={issue?.summary ? `${props.issueKey} ${issue.summary}` : props.issueKey}
      description={
        issue
          ? [issue.status?.name, issue.issueType, issue.assignee].filter(Boolean).join(" · ")
          : query.isPending
            ? gt("Status pending")
            : gt("Open in Jira")
      }
      onPress={() => {
        void tryOpenExternalUrl(props.url, "jira-issue").then((opened) => {
          if (!opened)
            Alert.alert(gt("Unable to open issue"), gt("The Jira issue could not be opened."));
        });
      }}
    />
  );
}
