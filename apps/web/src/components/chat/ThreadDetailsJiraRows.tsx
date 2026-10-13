/**
 * The thread details panel's Jira rows: one per issue key found in the branch name and, once the
 * project keys are configured, the pull request title and the latest issues the chat mentions. Each row opens the issue on the Jira site
 * and, when the environment can read the issue, shows its summary and status.
 */
import type {
  EnvironmentId,
  JiraIssue,
  JiraIssueKey,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { findJiraIssueKeys, jiraIssueUrl, normalizeJiraBaseUrl } from "@t3tools/shared/jira";
import { useAtomValue } from "@effect/atom-react";
import { useMemo, type MouseEvent as ReactMouseEvent } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { jiraEnvironment, threadJiraMentions } from "~/state/jira";
import { useEnvironmentQuery } from "~/state/query";

import { JiraIcon } from "../Icons";
import { Badge } from "../ui/badge";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

const STATUS_BADGE_VARIANT = {
  new: "secondary",
  indeterminate: "info",
  done: "success",
  unknown: "secondary",
} as const satisfies Record<NonNullable<JiraIssue["status"]>["category"], string>;

const EMPTY_KEYS: ReadonlyArray<string> = [];

export function ThreadDetailsJiraRows({
  environmentId,
  projectId,
  threadRef,
  branch,
  pullRequestTitle,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  threadRef: ScopedThreadRef | undefined;
  branch: string | null;
  pullRequestTitle: string | null;
}) {
  const baseUrl = normalizeJiraBaseUrl(
    useEnvironmentSettings(environmentId, (settings) => settings.jira.baseUrl),
  );
  const projectKeys = useEnvironmentSettings(
    environmentId,
    (settings) =>
      (projectId === null
        ? undefined
        : settings.projectSettingsOverrides[projectId]?.jiraProjectKeys) ??
      settings.jiraProjectKeys ??
      EMPTY_KEYS,
  );
  const mentionedKeys = useAtomValue(
    threadJiraMentions.mentionsAtom(baseUrl ? (threadRef ?? null) : null, projectKeys),
  );
  const keys = useMemo(
    () =>
      baseUrl
        ? [
            ...new Set([
              ...findJiraIssueKeys({ branch, texts: [pullRequestTitle], projectKeys }),
              ...mentionedKeys,
            ]),
          ]
        : [],
    [baseUrl, branch, mentionedKeys, projectKeys, pullRequestTitle],
  );
  const openLink = useOpenLink(threadRef);
  if (!baseUrl || keys.length === 0) return null;

  const open = (event: ReactMouseEvent<HTMLElement>, url: string) => {
    event.stopPropagation();
    void openLink(url, { event }).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open the Jira issue",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  };

  return keys.map((key) => (
    <ThreadDetailsJiraRow
      key={key}
      environmentId={environmentId}
      issueKey={key}
      url={jiraIssueUrl(baseUrl, key)}
      onOpen={open}
    />
  ));
}

function ThreadDetailsJiraRow({
  environmentId,
  issueKey,
  url,
  onOpen,
}: {
  environmentId: EnvironmentId;
  issueKey: JiraIssueKey;
  url: string;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
}) {
  const query = useEnvironmentQuery(
    jiraEnvironment.issue({ environmentId, input: { key: issueKey } }),
  );
  const issue = query.data;

  const row = (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Open ${issueKey} in Jira`}
            onClick={(event) => onOpen(event, url)}
          />
        }
      >
        <JiraIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={cn("min-w-0 flex-1 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          {issue?.summary || issueKey}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80 text-left whitespace-normal">
        {issue ? (
          <div className="grid gap-1 py-0.5 text-xs">
            <span className="font-medium">
              {issue.key}
              {issue.summary ? `: ${issue.summary}` : ""}
            </span>
            <span className="text-muted-foreground">
              {[issue.issueType, issue.status?.name, issue.assignee ?? "Unassigned"]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </div>
        ) : (
          <span>
            Open {issueKey} in Jira
            {query.error ? `. Status unavailable: ${query.error}` : ""}
          </span>
        )}
      </TooltipPopup>
    </Tooltip>
  );

  if (!issue) return row;
  return (
    // Same two-line shape as the pull request row: the summary keeps the full width and the key
    // and status sit underneath, aligned with the summary text.
    <div className="pb-2">
      {row}
      <div className="-mt-1 flex h-6 min-w-0 items-center gap-1.5 ps-9 pe-1 text-xs text-muted-foreground">
        <span className="shrink-0 tabular-nums">{issue.key}</span>
        {issue.status ? (
          <Badge size="sm" variant={STATUS_BADGE_VARIANT[issue.status.category]}>
            {issue.status.name}
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
