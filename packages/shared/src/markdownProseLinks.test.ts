import { describe, expect, it } from "vite-plus/test";

import { jiraIssueKeyPattern, jiraIssueUrl } from "./jira.ts";
import { linkMarkdownProse } from "./markdownProseLinks.ts";

const site = "https://company.atlassian.net";
const linkJira = (markdown: string) =>
  linkMarkdownProse(markdown, jiraIssueKeyPattern(["ABC"])!, (match) =>
    jiraIssueUrl(site, match[0].toUpperCase()),
  );

describe("linkMarkdownProse", () => {
  it("links Jira keys in prose, keeping the typed label", () => {
    expect(linkJira("Did we start ABC-12 or abc-7 yet?")).toBe(
      `Did we start [ABC-12](${site}/browse/ABC-12) or [abc-7](${site}/browse/ABC-7) yet?`,
    );
  });

  it("leaves code, links, other projects, and keys glued to words alone", () => {
    const text = `\`ABC-1\`\n\n\`\`\`\nABC-2\n\`\`\`\n\n[ABC-3](https://example.com) XABC-4 ABC-5x OPS-6 ${site}/browse/ABC-7`;
    expect(linkJira(text)).toBe(text);
  });
});

describe("jiraIssueKeyPattern", () => {
  it("is null without valid project keys", () => {
    expect(jiraIssueKeyPattern([])).toBeNull();
    expect(jiraIssueKeyPattern(["1ab"])).toBeNull();
  });
});
