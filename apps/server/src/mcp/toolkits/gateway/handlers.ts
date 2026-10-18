import * as Effect from "effect/Effect";

import * as McpGateway from "../../../mcpGateway/McpGateway.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { McpCallToolkit, McpServersToolkit, type GatewayToolkit } from "./tools.ts";

const handlers = {
  // Listing connects to every enabled server, which can start their commands on the host.
  mcp_servers: McpToolAccess.readsAsLiveCaller((input) =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("mcp-gateway");
      const gateway = yield* McpGateway.McpGateway;
      if (input.server !== undefined) {
        return { server: input.server, tools: yield* gateway.listTools(input.server) };
      }
      return { servers: yield* gateway.listServers({ connect: true }) };
    }),
  ),
  mcp_call: McpToolAccess.writesUnlessReadOnly((input, access) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("mcp-gateway");
      const gateway = yield* McpGateway.McpGateway;
      return yield* gateway.callTool({
        server: input.server,
        tool: input.tool,
        arguments: input.arguments ?? {},
        caller: {
          readOnly: access.readOnly,
          ...(scope.thread === undefined
            ? {}
            : {
                threadId: scope.thread.threadId,
                providerInstanceId: scope.thread.providerInstanceId,
              }),
          ...(scope.client === undefined ? {} : { clientLabel: scope.client.label }),
        },
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof GatewayToolkit.tools>;

export const layerServers = McpToolAccess.toLayer(McpServersToolkit, {
  mcp_servers: handlers.mcp_servers,
});

export const layerCall = McpToolAccess.toLayer(McpCallToolkit, {
  mcp_call: handlers.mcp_call,
});
