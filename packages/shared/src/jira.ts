import type { JiraIssueKey } from "@t3tools/contracts";

const ANY_KEY = /(?<![A-Za-z0-9])([A-Z][A-Z0-9_]+)-([1-9]\d*)(?![A-Za-z0-9])/g;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/** Uppercased, deduplicated project keys, dropping entries Jira could never issue. */
export function normalizeJiraProjectKeys(keys: ReadonlyArray<string>): string[] {
  return [
    ...new Set(keys.map((key) => key.trim().toUpperCase()).filter((key) => PROJECT_KEY.test(key))),
  ];
}

/**
 * The Jira site as an origin-and-path URL without a trailing slash, or null when it is empty or
 * not http(s). A bare host such as `company.atlassian.net` is read as https.
 */
export function normalizeJiraBaseUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * A global, case-insensitive pattern for issue keys of the given projects, or null without any.
 * Group 1 is the project key and group 2 the issue number, as typed; uppercase the project key
 * for the canonical issue key.
 */
export function jiraIssueKeyPattern(projectKeys: ReadonlyArray<string>): RegExp | null {
  // Valid project keys are letters, digits, and underscores only, so they need no escaping.
  const keys = normalizeJiraProjectKeys(projectKeys);
  if (keys.length === 0) return null;
  return new RegExp(`(?<![A-Za-z0-9])(${keys.join("|")})-([1-9]\\d*)(?![A-Za-z0-9])`, "gi");
}

/**
 * Jira issue keys mentioned in a branch name and, when the project keys are known, in other text
 * such as a pull request title, in order of first appearance and without repeats.
 *
 * With `projectKeys` set, only those projects count and matching ignores case, so
 * `feature/abc-123-login` finds `ABC-123`. Without them any uppercase key counts, but only in the
 * branch name: titles mention `UTF-8` and `SHA-256` far more often than branches do.
 */
export function findJiraIssueKeys(input: {
  readonly branch: string | null | undefined;
  readonly texts?: ReadonlyArray<string | null | undefined>;
  readonly projectKeys: ReadonlyArray<string>;
}): JiraIssueKey[] {
  const projectPattern = jiraIssueKeyPattern(input.projectKeys);
  const pattern = projectPattern ?? ANY_KEY;
  const sources = projectPattern ? [input.branch, ...(input.texts ?? [])] : [input.branch];
  const keys: JiraIssueKey[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const match of source.matchAll(pattern)) {
      const key = `${match[1]!.toUpperCase()}-${match[2]}` as JiraIssueKey;
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * The Markdown files among `paths` that name the issue. Paths are read like branch names, so
 * `docs/abc-123-plan.md` names `ABC-123` only once project keys are configured, and
 * `ABC-1234.md` never does.
 */
export function jiraIssueMarkdownFiles(
  paths: ReadonlyArray<string>,
  issueKey: string,
  projectKeys: ReadonlyArray<string>,
): string[] {
  return paths.filter(
    (path) =>
      /\.md$/i.test(path) &&
      findJiraIssueKeys({ branch: path, projectKeys }).some((key) => key === issueKey),
  );
}

/** The issue's page on the Jira site, e.g. `https://company.atlassian.net/browse/ABC-123`. */
export function jiraIssueUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/browse/${encodeURIComponent(key)}`;
}
