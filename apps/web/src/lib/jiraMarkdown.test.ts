import { jiraIssueKeyPattern } from "@t3tools/shared/jira";
import { toHtml } from "hast-util-to-html";
import { describe, expect, it } from "vite-plus/test";

import { wordsHast } from "~/markdown/wordsHast";

describe("Jira markdown links", () => {
  it("links keys in prose and leaves code and authored links alone", () => {
    const tree = wordsHast(
      "Did we start ipstmake-1234? See `IPSTMAKE-1` [IPSTMAKE-2](https://x.test)",
      {
        math: false,
        breaks: false,
        escapeHtml: false,
        insights: false,
        jiraLinks: {
          baseUrl: "https://company.atlassian.net",
          pattern: jiraIssueKeyPattern(["IPSTMAKE"])!,
        },
        extensions: {},
      },
    );
    expect(toHtml(tree)).toBe(
      '<p dir="ltr">Did we start <span class="has-[[data-slot=context-chip-label]]:whitespace-nowrap"><a href="https://company.atlassian.net/browse/IPSTMAKE-1234">ipstmake-1234</a>?</span> See <code data-inline-code="" dir="ltr">IPSTMAKE-1</code> <a href="https://x.test">IPSTMAKE-2</a></p>',
    );
  });
});
