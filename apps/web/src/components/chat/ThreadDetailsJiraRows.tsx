/**
 * The thread details panel's Jira rows: one per issue key found in the branch name and, once the
 * project keys are configured, the pull request title and the latest issues the chat mentions. Each row opens the issue on the Jira site
 * and, when the environment can read the issue, shows its summary and status. Markdown files in
 * the workspace named after an issue, e.g. `docs/ABC-123-plan.md`, are listed under it.
 */
import type {
  EnvironmentId,
  JiraIssue,
  JiraIssueKey,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  findJiraIssueKeys,
  jiraIssueMarkdownFiles,
  jiraIssueUrl,
  normalizeJiraBaseUrl,
} from "@t3tools/shared/jira";
import { useAtomValue } from "@effect/atom-react";
import { FileTextIcon } from "lucide-react";
import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { jiraEnvironment, threadJiraMentions } from "~/state/jira";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useRightPanelStore } from "~/rightPanelStore";

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
/** Keeps the floating card short; the rest are a click away in the Files panel. */
const MAX_FILES_PER_ISSUE = 3;
// The search is fuzzy, so ask for enough results that the exact key matches are among them.
const FILE_SEARCH_LIMIT = 50;

export function ThreadDetailsJiraRows({
  environmentId,
  projectId,
  threadRef,
  branch,
  pullRequestTitle,
  cwd,
  turnCompletedAt,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  threadRef: ScopedThreadRef | undefined;
  branch: string | null;
  pullRequestTitle: string | null;
  /** The thread's workspace, searched for each issue's Markdown files. */
  cwd: string | null;
  /** Changes when a turn finishes, so files the turn wrote show up. */
  turnCompletedAt: string | null;
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
  const keys = baseUrl
    ? [
        ...new Set([
          ...findJiraIssueKeys({ branch, texts: [pullRequestTitle], projectKeys }),
          ...mentionedKeys,
        ]),
      ]
    : [];
  const openLink = useOpenLink(threadRef);
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
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
      files={
        threadRef && cwd && canReadFiles ? (
          <ThreadDetailsJiraFiles
            environmentId={environmentId}
            threadRef={threadRef}
            cwd={cwd}
            issueKey={key}
            projectKeys={projectKeys}
            turnCompletedAt={turnCompletedAt}
          />
        ) : null
      }
    />
  ));
}

function ThreadDetailsJiraRow({
  environmentId,
  issueKey,
  url,
  onOpen,
  files,
}: {
  environmentId: EnvironmentId;
  issueKey: JiraIssueKey;
  url: string;
  onOpen: (event: ReactMouseEvent<HTMLElement>, url: string) => void;
  files: ReactNode;
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

  if (!issue) {
    return (
      <>
        {row}
        {files}
      </>
    );
  }
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
      {files}
    </div>
  );
}

/**
 * Markdown files whose path names the issue, found with the workspace search so files from any
 * thread or turn count. The search index skips Git-ignored paths.
 */
function ThreadDetailsJiraFiles({
  environmentId,
  threadRef,
  cwd,
  issueKey,
  projectKeys,
  turnCompletedAt,
}: {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  issueKey: JiraIssueKey;
  projectKeys: ReadonlyArray<string>;
  turnCompletedAt: string | null;
}) {
  const query = useEnvironmentQuery(
    projectEnvironment.searchEntries({
      environmentId,
      input: { cwd, query: issueKey, limit: FILE_SEARCH_LIMIT, kind: "file" },
    }),
  );
  const { refresh } = query;
  const seenTurn = useRef(turnCompletedAt);
  useEffect(() => {
    if (seenTurn.current === turnCompletedAt) return;
    seenTurn.current = turnCompletedAt;
    refresh();
  }, [refresh, turnCompletedAt]);
  const entries = query.data?.entries;
  const files = jiraIssueMarkdownFiles(
    (entries ?? []).map((entry) => entry.path),
    issueKey,
    projectKeys,
  );
  if (files.length === 0) return null;

  const openFile = (path: string) => useRightPanelStore.getState().openFile(threadRef, path);
  const hidden = files.length - MAX_FILES_PER_ISSUE;
  return (
    // Indented so each file's icon lines up with the issue summary above it.
    <div className="flex flex-col ps-6.5">
      {files.slice(0, MAX_FILES_PER_ISSUE).map((path) => (
        <Tooltip key={path}>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Open ${path}`}
                onClick={() => openFile(path)}
              />
            }
          >
            <FileTextIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span
              className={cn("min-w-0 flex-1 truncate text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}
            >
              {path.slice(path.lastIndexOf("/") + 1)}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">{path}</TooltipPopup>
        </Tooltip>
      ))}
      {hidden > 0 ? (
        <ThreadDetailsControl
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${hidden} more ${issueKey} files. Open the Files panel`}
          onClick={() => openFile(".")}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left text-muted-foreground",
              THREAD_DETAILS_PANEL_LABEL_CLASS,
            )}
          >
            +{hidden} more
          </span>
        </ThreadDetailsControl>
      ) : null}
    </div>
  );
}
