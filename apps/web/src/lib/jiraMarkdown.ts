import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ServerSettings } from "@t3tools/contracts";
import { jiraIssueKeyPattern, jiraIssueUrl, normalizeJiraBaseUrl } from "@t3tools/shared/jira";
import { Atom } from "effect/reactivity";

import { readThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { findAndReplaceText, type MarkdownNode } from "~/vendor/mdast-find-and-replace";

const IGNORED_TYPES = new Set(["link", "linkReference"]);

/** Links issue keys of the configured Jira projects in prose; code and authored links stay as written. */
export function remarkJiraIssueLinks(options: {
  readonly baseUrl: string;
  readonly pattern: RegExp;
}) {
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      options.pattern,
      (matched) => ({
        type: "link",
        url: jiraIssueUrl(options.baseUrl, matched.toUpperCase()),
        children: [{ type: "text", value: matched }],
      }),
      IGNORED_TYPES,
    );
  };
}

const NO_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null);

/**
 * The remark plugin entry that links Jira issue keys in markdown from this environment, or null
 * when no Jira site or project keys are set. The thread's project can override the keys.
 */
export function useJiraMarkdownLinks(
  environmentId: EnvironmentId | null,
  threadRef: ScopedThreadRef | undefined,
): [typeof remarkJiraIssueLinks, Parameters<typeof remarkJiraIssueLinks>[0]] | null {
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : NO_SETTINGS_ATOM,
  );
  const baseUrl = normalizeJiraBaseUrl(settings?.jira.baseUrl ?? "");
  if (!settings || !baseUrl) return null;
  // A thread's project never changes, so a one-off read avoids re-rendering on shell updates.
  const projectId = threadRef ? readThreadShell(threadRef)?.projectId : undefined;
  const pattern = jiraIssueKeyPattern(
    (projectId ? settings.projectSettingsOverrides[projectId]?.jiraProjectKeys : undefined) ??
      settings.jiraProjectKeys,
  );
  return pattern ? [remarkJiraIssueLinks, { baseUrl, pattern }] : null;
}
