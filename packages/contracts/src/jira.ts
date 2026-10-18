import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A Jira issue key such as `ABC-123`: a project key, a dash, and the issue number. */
export const JiraIssueKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]+-[1-9]\d*$/),
);
export type JiraIssueKey = typeof JiraIssueKey.Type;

export const JiraIssueInput = Schema.Struct({ key: JiraIssueKey });
export type JiraIssueInput = typeof JiraIssueInput.Type;

/** Jira's own status categories: to do, in progress, and done. */
export const JiraIssueStatusCategory = Schema.Literals(["new", "indeterminate", "done", "unknown"]);
export type JiraIssueStatusCategory = typeof JiraIssueStatusCategory.Type;

export const JiraIssue = Schema.Struct({
  key: JiraIssueKey,
  url: Schema.String,
  summary: Schema.String,
  status: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      category: JiraIssueStatusCategory,
    }),
  ),
  issueType: Schema.NullOr(Schema.String),
  assignee: Schema.NullOr(Schema.String),
});
export type JiraIssue = typeof JiraIssue.Type;

export class JiraError extends Schema.TaggedError<JiraError>()("JiraError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
