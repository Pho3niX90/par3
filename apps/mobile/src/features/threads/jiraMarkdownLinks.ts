import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import { jiraIssueKeyPattern, jiraIssueUrl, normalizeJiraBaseUrl } from "@t3tools/shared/jira";
import { linkMarkdownProse } from "@t3tools/shared/markdownProseLinks";
import { createContext, use, useMemo } from "react";

interface JiraMarkdownLinks {
  readonly baseUrl: string;
  readonly pattern: RegExp;
}

/** The Jira site and issue key pattern for the thread on screen, or null when linking is off. */
export const JiraMarkdownLinksContext = createContext<JiraMarkdownLinks | null>(null);

/** Linking needs both a Jira site and project keys; the project's own keys win. */
export function useJiraMarkdownLinksValue(
  settings: ServerSettings | null | undefined,
  projectId: ProjectId | null,
): JiraMarkdownLinks | null {
  return useMemo(() => {
    const baseUrl = normalizeJiraBaseUrl(settings?.jira.baseUrl ?? "");
    if (!settings || !baseUrl) return null;
    const pattern = jiraIssueKeyPattern(
      (projectId ? settings.projectSettingsOverrides[projectId]?.jiraProjectKeys : undefined) ??
        settings.jiraProjectKeys,
    );
    return pattern ? { baseUrl, pattern } : null;
  }, [projectId, settings]);
}

/** `markdown` with Jira issue keys in prose linked to their issues. */
export function useJiraIssueLinks(markdown: string): string {
  const jira = use(JiraMarkdownLinksContext);
  return useMemo(
    () =>
      jira === null || markdown.search(jira.pattern) === -1
        ? markdown
        : linkMarkdownProse(markdown, jira.pattern, (match) =>
            jiraIssueUrl(jira.baseUrl, match[0].toUpperCase()),
          ),
    [jira, markdown],
  );
}
