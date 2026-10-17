import { linkMarkdownProse } from "./markdownProseLinks.ts";

const reference =
  /(?<![\w/\\])(?:([\w.-]+\/[\w.-]+|[\w-]+)?#([1-9]\d*)|(?:([\w.-]+\/[\w.-]+|[\w-]+)@)?([a-f\d]{7,40})(?![\w])|@([a-z\d](?:[a-z\d-]*[a-z\d])?(?:\/[a-z\d][a-z\d-]*)?))(?![\w])/gi;

export function githubMarkdownLinks(markdown: string, pullRequestUrl: string | null): string {
  if (!pullRequestUrl || !/[#@]|\b[a-f\d]{7,40}\b/i.test(markdown)) return markdown;
  let url: URL;
  try {
    url = new URL(pullRequestUrl);
  } catch {
    return markdown;
  }
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || !/^https?:$/.test(url.protocol)) return markdown;
  const repository = (qualifier: string | undefined) =>
    qualifier?.includes("/") ? qualifier : qualifier ? `${qualifier}/${repo}` : `${owner}/${repo}`;
  return linkMarkdownProse(markdown, reference, (match) => {
    const [, issueRepo, number, commitRepo, sha, mention] = match;
    if (sha && !/[a-f]/i.test(sha)) return null;
    const path = number
      ? `${repository(issueRepo)}/issues/${number}`
      : sha
        ? `${repository(commitRepo)}/commit/${sha}`
        : mention?.includes("/")
          ? `orgs/${mention.split("/")[0]}/teams/${mention.split("/")[1]}`
          : mention;
    return path ? `${url.origin}/${path}` : null;
  });
}
