import { describe, expect, it } from "vite-plus/test";

import {
  findJiraIssueKeys,
  jiraIssueUrl,
  normalizeJiraBaseUrl,
  normalizeJiraProjectKeys,
} from "./jira.ts";

describe("findJiraIssueKeys", () => {
  it("finds uppercase keys in the branch when no project keys are configured", () => {
    expect(
      findJiraIssueKeys({
        branch: "feature/ABC-123-login",
        texts: ["Move to UTF-8 (ABC-9)"],
        projectKeys: [],
      }),
    ).toEqual(["ABC-123"]);
  });

  it("ignores lowercase keys and numbers glued to words without project keys", () => {
    expect(findJiraIssueKeys({ branch: "release-2/abc-12/XABC-1x", projectKeys: [] })).toEqual([]);
  });

  it("matches configured projects in any case across branch and texts", () => {
    expect(
      findJiraIssueKeys({
        branch: "feature/abc-123-login",
        texts: ["ABC-123 and Ops-7: fix UTF-8 handling", null],
        projectKeys: ["ABC", "ops"],
      }),
    ).toEqual(["ABC-123", "OPS-7"]);
  });

  it("does not match a configured key inside a longer project key", () => {
    expect(findJiraIssueKeys({ branch: "XABC-5", projectKeys: ["ABC"] })).toEqual([]);
  });
});

describe("normalizeJiraProjectKeys", () => {
  it("uppercases, deduplicates, and drops keys Jira could never issue", () => {
    expect(normalizeJiraProjectKeys(["abc", "ABC", " ops ", "1AB", "A", "A-B", ""])).toEqual([
      "ABC",
      "OPS",
    ]);
  });

  it("ignores invalid configured keys when finding issues", () => {
    expect(findJiraIssueKeys({ branch: "1AB-3/ABC-4", projectKeys: ["1ab", "abc"] })).toEqual([
      "ABC-4",
    ]);
  });
});

describe("normalizeJiraBaseUrl", () => {
  it("reads a bare host as https and drops trailing slashes, query, and hash", () => {
    expect(normalizeJiraBaseUrl("company.atlassian.net/")).toBe("https://company.atlassian.net");
    expect(normalizeJiraBaseUrl("http://jira.company.test/jira/?x=1#y")).toBe(
      "http://jira.company.test/jira",
    );
  });

  it("rejects empty and non-http sites", () => {
    expect(normalizeJiraBaseUrl("  ")).toBeNull();
    expect(normalizeJiraBaseUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeJiraBaseUrl("ftp://jira.company.test")).toBeNull();
  });
});

describe("jiraIssueUrl", () => {
  it("links the issue under the normalized site", () => {
    expect(jiraIssueUrl("https://company.atlassian.net", "ABC-1")).toBe(
      "https://company.atlassian.net/browse/ABC-1",
    );
  });
});
