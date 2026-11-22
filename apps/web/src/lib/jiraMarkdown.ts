import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ServerSettings } from "@t3tools/contracts";
import { jiraIssueKeyPattern, normalizeJiraBaseUrl } from "@t3tools/shared/jira";
import { Atom } from "effect/reactivity";

import { readThreadShell } from "~/state/entities";
import { serverEnvironment } from "~/state/server";

export interface JiraMarkdownLinks {
  readonly baseUrl: string;
  readonly pattern: RegExp;
}

const NO_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null);

/**
 * The Jira issue-linking config for markdown from this environment, or null
 * when no Jira site or project keys are set. The thread's project can override the keys.
 */
export function useJiraMarkdownLinks(
  environmentId: EnvironmentId | null,
  threadRef: ScopedThreadRef | undefined,
): JiraMarkdownLinks | null {
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
  return pattern ? { baseUrl, pattern } : null;
}
