import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { MAX_MENTIONED_JIRA_ISSUES, mentionedJiraIssueKeys } from "./jira.ts";

const message = (
  text: string,
  overrides: Partial<Pick<OrchestrationV2ConversationMessage, "role" | "streaming">> = {},
) => ({ text, role: "user", streaming: false, ...overrides }) as OrchestrationV2ConversationMessage;

describe("mentionedJiraIssueKeys", () => {
  it("lists configured issues from finished chat messages, latest first", () => {
    expect(
      mentionedJiraIssueKeys(
        [
          message("Did we start ipstmake-1234?"),
          message("Yes, IPSTMAKE-1234 and IPSTMAKE-7 are open. UTF-8 OPS-1", { role: "assistant" }),
          message("IPSTMAKE-99 is still being written", { role: "assistant", streaming: true }),
          message("IPSTMAKE-5", { role: "system" }),
        ],
        ["IPSTMAKE"],
      ),
    ).toEqual(["IPSTMAKE-1234", "IPSTMAKE-7"]);
  });

  it("keeps only the most recent few issues", () => {
    const messages = Array.from({ length: 8 }, (_, index) => message(`ABC-${index + 1}`));
    expect(mentionedJiraIssueKeys(messages, ["ABC"])).toEqual(
      ["ABC-8", "ABC-7", "ABC-6", "ABC-5", "ABC-4"].slice(0, MAX_MENTIONED_JIRA_ISSUES),
    );
  });

  it("finds nothing without project keys", () => {
    expect(mentionedJiraIssueKeys([message("ABC-1")], [])).toEqual([]);
  });
});
