import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as Settings from "../serverSettings.ts";
import * as JiraIssues from "./JiraIssues.ts";

function fixture(jira: { baseUrl?: string; email?: string; apiToken?: string }, status = 200) {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          {
            key: "ABC-12",
            fields: {
              summary: "Log in with SSO",
              status: { name: "In Review", statusCategory: { key: "indeterminate" } },
              issuetype: { name: "Story" },
              assignee: null,
            },
          },
          { status },
        ),
      );
    }),
  );
  const layer = JiraIssues.layer.pipe(
    Layer.provide(Settings.layerTest({ jira })),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { requests, layer };
}

describe("JiraIssues", () => {
  it.effect("reads an issue from Jira Cloud with basic auth and caches it", () => {
    const { requests, layer } = fixture({
      baseUrl: "https://company.atlassian.net/",
      email: "dev@company.test",
      apiToken: "token",
    });
    return Effect.gen(function* () {
      const jira = yield* JiraIssues.JiraIssues;
      const issue = yield* jira.issue({ key: "ABC-12" as never });
      yield* jira.issue({ key: "ABC-12" as never });
      expect(issue).toEqual({
        key: "ABC-12",
        url: "https://company.atlassian.net/browse/ABC-12",
        summary: "Log in with SSO",
        status: { name: "In Review", category: "indeterminate" },
        issueType: "Story",
        assignee: null,
      });
      expect(requests).toEqual([
        {
          url: "https://company.atlassian.net/rest/api/2/issue/ABC-12?fields=summary,status,issuetype,assignee",
          authorization: `Basic ${Buffer.from("dev@company.test:token").toString("base64")}`,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("uses a bearer token when no email is set", () => {
    const { requests, layer } = fixture({ baseUrl: "https://jira.company.test", apiToken: "pat" });
    return Effect.gen(function* () {
      const jira = yield* JiraIssues.JiraIssues;
      yield* jira.issue({ key: "ABC-12" as never });
      expect(requests[0]?.authorization).toBe("Bearer pat");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports rejected credentials and an unconfigured site", () =>
    Effect.gen(function* () {
      const rejected = fixture({ baseUrl: "https://jira.company.test", apiToken: "bad" }, 401);
      const failure = yield* JiraIssues.JiraIssues.pipe(
        Effect.flatMap((jira) => jira.issue({ key: "ABC-12" as never })),
        Effect.flip,
        Effect.provide(rejected.layer),
      );
      expect(failure.detail).toBe("Jira rejected the credentials.");

      const unconfigured = fixture({});
      const missing = yield* JiraIssues.JiraIssues.pipe(
        Effect.flatMap((jira) => jira.issue({ key: "ABC-12" as never })),
        Effect.flip,
        Effect.provide(unconfigured.layer),
      );
      expect(missing.detail).toBe("No Jira site is configured.");
      expect(unconfigured.requests).toEqual([]);
    }),
  );
});
