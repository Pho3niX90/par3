/**
 * Reads one Jira issue's summary and status over the v2 REST API (Cloud, Server and Data Center).
 * Cloud uses email + API token (basic auth); Server/DC take a PAT as bearer; no token goes anonymous.
 * Reads are cached briefly, and a settings change drops the cache.
 */
import {
  JiraError,
  type JiraIssue,
  type JiraIssueInput,
  type JiraIssueStatusCategory,
  type JiraSettings,
} from "@t3tools/contracts";
import { jiraIssueUrl, normalizeJiraBaseUrl } from "@t3tools/shared/jira";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as Settings from "../serverSettings.ts";

const ISSUE_CACHE_TTL = Duration.minutes(1);

const JiraIssueResponse = Schema.Struct({
  key: Schema.String,
  fields: Schema.Struct({
    summary: Schema.optional(Schema.NullOr(Schema.String)),
    status: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: Schema.String,
          statusCategory: Schema.optional(Schema.NullOr(Schema.Struct({ key: Schema.String }))),
        }),
      ),
    ),
    issuetype: Schema.optional(Schema.NullOr(Schema.Struct({ name: Schema.String }))),
    assignee: Schema.optional(Schema.NullOr(Schema.Struct({ displayName: Schema.String }))),
  }),
});
const decodeJiraIssueResponse = Schema.decodeUnknownEffect(JiraIssueResponse);

function statusCategory(key: string | undefined): JiraIssueStatusCategory {
  return key === "new" || key === "indeterminate" || key === "done" ? key : "unknown";
}

/** The `Authorization` header for the configured credentials, or null to ask anonymously. */
function jiraAuthorization(settings: JiraSettings): string | null {
  if (settings.apiToken.length === 0) return null;
  if (settings.email.length === 0) return `Bearer ${settings.apiToken}`;
  return `Basic ${Buffer.from(`${settings.email}:${settings.apiToken}`, "utf8").toString("base64")}`;
}

function failureDetail(status: number): string {
  if (status === 401) return "Jira rejected the credentials.";
  if (status === 403) return "The Jira account cannot see this issue.";
  if (status === 404) return "Jira has no issue with this key, or it is hidden from this account.";
  return `Jira answered with HTTP ${status}.`;
}

export class JiraIssues extends Context.Service<
  JiraIssues,
  {
    readonly issue: (input: JiraIssueInput) => Effect.Effect<JiraIssue, JiraError>;
  }
>()("t3/jira/JiraIssues") {}

/** @public */
export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settingsService = yield* Settings.ServerSettingsService;

  const readIssue = Effect.fn("JiraIssues.readIssue")(function* (key: string) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new JiraError({ detail: "Could not read the Jira settings." })),
    );
    const jira = settings.jira;
    if (jira.baseUrl.length === 0) {
      return yield* new JiraError({ detail: "No Jira site is configured." });
    }
    const baseUrl = normalizeJiraBaseUrl(jira.baseUrl);
    if (baseUrl === null) {
      return yield* new JiraError({ detail: "The Jira site URL is not valid." });
    }
    const url = `${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,assignee`;
    const authorization = jiraAuthorization(jira);
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.acceptJson,
      authorization === null
        ? (request) => request
        : HttpClientRequest.setHeader("Authorization", authorization),
    );
    const response = yield* client.execute(request).pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError(() => new JiraError({ detail: "Could not reach the Jira site." })),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new JiraError({ detail: failureDetail(response.status) });
    }
    const body = yield* response.json.pipe(
      Effect.flatMap(decodeJiraIssueResponse),
      Effect.mapError(() => new JiraError({ detail: "Jira sent an issue this app cannot read." })),
    );
    return {
      key: body.key as JiraIssue["key"],
      url: jiraIssueUrl(baseUrl, body.key),
      summary: body.fields.summary ?? "",
      status: body.fields.status
        ? {
            name: body.fields.status.name,
            category: statusCategory(body.fields.status.statusCategory?.key),
          }
        : null,
      issueType: body.fields.issuetype?.name ?? null,
      assignee: body.fields.assignee?.displayName ?? null,
    } satisfies JiraIssue;
  });

  const cache = yield* Cache.makeWith(readIssue, {
    capacity: 256,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? ISSUE_CACHE_TTL : Duration.zero),
  });

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.jira),
    Stream.changesWith(
      (left, right) =>
        left.baseUrl === right.baseUrl &&
        left.email === right.email &&
        left.apiToken === right.apiToken,
    ),
    Stream.runForEach(() => Cache.invalidateAll(cache)),
    Effect.forkScoped,
  );

  return {
    issue: (input) => Cache.get(cache, input.key),
  } satisfies JiraIssues["Service"];
});

export const layer = Layer.effect(JiraIssues, make);
