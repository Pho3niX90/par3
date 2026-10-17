import { jiraIssueKeyPattern } from "@t3tools/shared/jira";
import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";
import { remarkJiraIssueLinks } from "./jiraMarkdown";

describe("remarkJiraIssueLinks", () => {
  it("links keys in prose and leaves code and authored links alone", () => {
    const authored: MarkdownNode = {
      type: "link",
      url: "https://x.test",
      children: [{ type: "text", value: "IPSTMAKE-2" }],
    };
    const tree: MarkdownNode = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Did we start ipstmake-1234? See " },
            { type: "inlineCode", value: "IPSTMAKE-1" },
            authored,
          ],
        },
      ],
    };
    remarkJiraIssueLinks({
      baseUrl: "https://company.atlassian.net",
      pattern: jiraIssueKeyPattern(["IPSTMAKE"])!,
    })(tree);
    expect(tree.children![0]!.children).toEqual([
      { type: "text", value: "Did we start " },
      {
        type: "link",
        url: "https://company.atlassian.net/browse/IPSTMAKE-1234",
        children: [{ type: "text", value: "ipstmake-1234" }],
      },
      { type: "text", value: "? See " },
      { type: "inlineCode", value: "IPSTMAKE-1" },
      authored,
    ]);
  });
});
