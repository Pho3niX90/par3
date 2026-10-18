import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceEnvironment } from "./providerInstance.ts";

/** What agents type to reach the server, so it stays short and shell- and JSON-friendly. */
export const McpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/),
);
export type McpServerName = typeof McpServerName.Type;

const McpServerStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});

const McpServerHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  url: TrimmedNonEmptyString,
});

const McpServerTransport = Schema.Union([McpServerStdioTransport, McpServerHttpTransport]);

/** Same shape as a provider instance's environment variables, so `sensitive` values share its secret handling. */
export const McpServerHeader = Schema.Struct({
  name: TrimmedNonEmptyString.check(
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/),
  ),
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type McpServerHeader = typeof McpServerHeader.Type;

/**
 * `tools` applies only in `allow` mode; it is kept in `all` mode so switching back restores the
 * list. A read-only MCP client may call only tools whose upstream annotations set `readOnlyHint`.
 */
export const McpServerToolPolicy = Schema.Struct({
  mode: Schema.Literals(["all", "allow"]).pipe(Schema.withDecodingDefault(Effect.succeed("all"))),
  tools: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  readOnlyClientsMayCall: Schema.Literal("readOnlyHint").pipe(
    Schema.withDecodingDefault(Effect.succeed("readOnlyHint" as const)),
  ),
});
export type McpServerToolPolicy = typeof McpServerToolPolicy.Type;

/**
 * A third-party MCP server that Par3 connects to itself and shares with every agent through the
 * `mcp_servers` and `mcp_call` tools. A stdio server runs as a command on the environment host,
 * so only settings writers can configure one.
 */
export const McpServerConfig = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: McpServerName,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  description: Schema.optionalKey(TrimmedString),
  transport: McpServerTransport,
  environment: ProviderInstanceEnvironment.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  headers: Schema.Array(McpServerHeader).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  toolPolicy: McpServerToolPolicy.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type McpServerConfig = typeof McpServerConfig.Type;

export const McpServerConfigs = Schema.Array(McpServerConfig);

/** Whether Par3 can reach an MCP server at this URL over HTTP. */
export function isMcpServerHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const firstDuplicate = (values: ReadonlyArray<string>) =>
  values.find((value, index) => values.indexOf(value) !== index);

/**
 * What a save may write. Stored settings decode without these checks, so an entry written before
 * them cannot stop the whole settings file from loading; the gateway reports it on that server.
 */
export const McpServerConfigsPatch = McpServerConfigs.check(
  Schema.makeFilter((servers) => {
    const id = firstDuplicate(servers.map((server) => server.id));
    if (id !== undefined) return `Two MCP servers share the id "${id}".`;
    const name = firstDuplicate(servers.map((server) => server.name));
    if (name !== undefined) return `Two MCP servers share the name "${name}".`;
    const badUrl = servers.find(
      (server) => server.transport.type === "http" && !isMcpServerHttpUrl(server.transport.url),
    );
    return badUrl === undefined
      ? true
      : `The MCP server "${badUrl.name}" needs an http or https URL.`;
  }),
);

const McpGatewayToolAnnotations = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  readOnlyHint: Schema.optionalKey(Schema.Boolean),
  destructiveHint: Schema.optionalKey(Schema.Boolean),
  idempotentHint: Schema.optionalKey(Schema.Boolean),
  openWorldHint: Schema.optionalKey(Schema.Boolean),
});

export const McpGatewayTool = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  inputSchema: Schema.optionalKey(Schema.Unknown),
  annotations: Schema.optionalKey(McpGatewayToolAnnotations),
  /** False when the server's tool policy hides the tool from agents. */
  allowed: Schema.Boolean,
});
export type McpGatewayTool = typeof McpGatewayTool.Type;

/** `idle` has no open connection yet; the gateway connects on first use. */
const McpGatewayServerState = Schema.Literals(["idle", "connected", "error", "disabled"]);

export const McpGatewayServerStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  state: McpGatewayServerState,
  error: Schema.optionalKey(Schema.String),
  /** Present once the tool list has been read. Counts the tools agents may call. */
  toolCount: Schema.optionalKey(Schema.Int),
});
export type McpGatewayServerStatus = typeof McpGatewayServerStatus.Type;

export const McpGatewayStatusResult = Schema.Struct({
  servers: Schema.Array(McpGatewayServerStatus),
});
export type McpGatewayStatusResult = typeof McpGatewayStatusResult.Type;

export const McpGatewayTestInput = Schema.Struct({ serverId: TrimmedNonEmptyString });
export type McpGatewayTestInput = typeof McpGatewayTestInput.Type;

export const McpGatewayTestResult = Schema.Struct({
  server: McpGatewayServerStatus,
  tools: Schema.Array(McpGatewayTool),
});
export type McpGatewayTestResult = typeof McpGatewayTestResult.Type;

const McpGatewayErrorReason = Schema.Literals([
  "server_not_found",
  "server_disabled",
  "tool_not_found",
  "tool_not_allowed",
  "read_only",
  "connection_failed",
  "timeout",
  "upstream_error",
]);

export class McpGatewayError extends Schema.TaggedError<McpGatewayError>()("McpGatewayError", {
  reason: McpGatewayErrorReason,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
