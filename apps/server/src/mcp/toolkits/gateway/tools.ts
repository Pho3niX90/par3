import {
  McpCapabilityUnavailableError,
  McpGatewayError,
  McpGatewayServerStatus,
  McpGatewayTool,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpGateway from "../../../mcpGateway/McpGateway.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  McpGateway.McpGateway,
];

const failure = Schema.Union([
  McpGatewayError,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
]);

const ServerName = TrimmedNonEmptyString.annotate({
  description: "The server's name, as mcp_servers lists it.",
});

const McpServersTool = Tool.make("mcp_servers", {
  description:
    "List the MCP servers (such as Linear, Sentry, or internal tools) that Par3's settings share with every agent, with their status. Pass server to list that server's tools and their input schemas, then call one with mcp_call. Use these servers before asking the user to set one up in your own MCP config.",
  parameters: Schema.Struct({ server: Schema.optional(ServerName) }),
  success: Schema.Struct({
    servers: Schema.optional(Schema.Array(McpGatewayServerStatus)),
    server: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Array(McpGatewayTool)),
  }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List shared MCP servers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

// Not read-only: what a call does depends on the upstream tool, so the gateway checks each call.
export const McpCallTool = Tool.make("mcp_call", {
  description:
    "Call a tool on an MCP server shared through Par3. List servers and tool schemas with mcp_servers first. The tool's own result is returned unchanged.",
  parameters: Schema.Struct({
    server: ServerName,
    tool: TrimmedNonEmptyString.annotate({ description: "The upstream tool's name." }),
    arguments: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "Arguments matching the tool's input schema.",
      }),
    ),
  }),
  success: Schema.Struct({
    content: Schema.Array(Schema.Unknown),
    structuredContent: Schema.optionalKey(Schema.Unknown),
    isError: Schema.optionalKey(Schema.Boolean),
  }),
  failure,
  dependencies,
})
  .annotate(Tool.Title, "Call a shared MCP tool")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const McpServersToolkit = Toolkit.make(McpServersTool);

export const McpCallToolkit = Toolkit.make(McpCallTool);

export const GatewayToolkit = Toolkit.make(McpServersTool, McpCallTool);
