import { describe, expect, it } from "@effect/vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";
import * as McpGateway from "./McpGateway.ts";

const readOnlyCaller = { readOnly: true, threadId: "thread-1" };
const caller = { readOnly: false, threadId: "thread-1" };

const lookup: Tool = {
  name: "lookup",
  description: "Read an issue.",
  inputSchema: { type: "object", properties: { id: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const write: Tool = {
  name: "write",
  description: "Change an issue.",
  inputSchema: { type: "object" },
};
const fail: Tool = { name: "fail", inputSchema: { type: "object" } };

const server = (overrides: Partial<McpServerConfig> = {}) =>
  ({
    id: "linear-id",
    name: "linear",
    description: "Issues",
    transport: { type: "http", url: "https://mcp.company.test/mcp" },
    ...overrides,
  }) as McpServerConfig;

/** Each connect gets a fresh in-process upstream server sharing one tool list. */
function fixture(servers: ReadonlyArray<McpServerConfig>) {
  const state = { tools: [lookup, write, fail] as Array<Tool> };
  const upstreams: Array<{ readonly server: Server; closed: boolean }> = [];
  const openTransport: McpGateway.OpenTransport = () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const upstream = new Server(
      { name: "upstream", version: "1" },
      { capabilities: { tools: { listChanged: true } } },
    );
    upstream.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: state.tools }));
    upstream.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "fail") throw new Error("upstream exploded");
      return {
        content: [
          {
            type: "text",
            text: `${request.params.name}:${JSON.stringify(request.params.arguments)}`,
          },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      };
    });
    const entry = { server: upstream, closed: false };
    upstream.onclose = () => {
      entry.closed = true;
    };
    upstreams.push(entry);
    void upstream.connect(serverSide);
    return { transport: clientSide, stderrTail: () => "" };
  };
  const layer = Layer.effect(
    McpGateway.McpGateway,
    McpGateway.makeWithTransport(openTransport),
  ).pipe(Layer.provideMerge(Settings.layerTest({ mcpServers: servers })));
  return { state, upstreams, layer };
}

describe("McpGateway", () => {
  it.effect("lists servers and tools, and passes a call's content through", () => {
    const { upstreams, layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      expect(yield* gateway.listServers({ connect: false })).toEqual([
        { id: "linear-id", name: "linear", description: "Issues", state: "idle" },
      ]);
      expect(yield* gateway.listServers({ connect: true })).toEqual([
        {
          id: "linear-id",
          name: "linear",
          description: "Issues",
          state: "connected",
          toolCount: 3,
        },
      ]);
      const tools = yield* gateway.listTools("linear");
      expect(tools.map((tool) => tool.name)).toEqual(["lookup", "write", "fail"]);
      expect(tools[0]).toMatchObject({ annotations: { readOnlyHint: true }, allowed: true });

      const result = yield* gateway.callTool({
        server: "linear",
        tool: "lookup",
        arguments: { id: "ABC-1" },
        caller,
      });
      expect(result.content).toEqual([
        { type: "text", text: 'lookup:{"id":"ABC-1"}' },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ]);
      // One shared connection serves every call.
      expect(upstreams).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses unknown and disabled servers, and lists a disabled one as such", () => {
    const { upstreams, layer } = fixture([server({ enabled: false })]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      expect(yield* gateway.listServers({ connect: true })).toMatchObject([
        { name: "linear", state: "disabled" },
      ]);
      const disabled = yield* gateway
        .callTool({ server: "linear", tool: "lookup", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(disabled.reason).toBe("server_disabled");
      const missing = yield* gateway.listTools("sentry").pipe(Effect.flip);
      expect(missing.reason).toBe("server_not_found");
      expect(upstreams).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("applies the allow-list to listing and calling", () => {
    const { layer } = fixture([
      server({ toolPolicy: { mode: "allow", tools: ["lookup"] } } as never),
    ]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      expect((yield* gateway.listTools("linear")).map((tool) => tool.name)).toEqual(["lookup"]);
      const refused = yield* gateway
        .callTool({ server: "linear", tool: "write", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("tool_not_allowed");
      const unknown = yield* gateway
        .callTool({ server: "linear", tool: "nope", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(unknown.reason).toBe("tool_not_found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets a read-only client call only tools marked readOnlyHint", () => {
    const { layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const read = yield* gateway.callTool({
        server: "linear",
        tool: "lookup",
        arguments: {},
        caller: readOnlyCaller,
      });
      expect(read.content[0]).toMatchObject({ type: "text" });
      const refused = yield* gateway
        .callTool({ server: "linear", tool: "write", arguments: {}, caller: readOnlyCaller })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("read_only");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reconnects when the server's settings change", () => {
    const { upstreams, layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const settings = yield* Settings.ServerSettingsService;
      yield* gateway.callTool({ server: "linear", tool: "lookup", arguments: {}, caller });
      yield* settings.updateSettings({
        mcpServers: [
          server({
            headers: [{ name: "Authorization", value: "Bearer rotated", sensitive: true }],
          }),
        ],
      });
      yield* gateway.callTool({ server: "linear", tool: "lookup", arguments: {}, caller });
      expect(upstreams).toHaveLength(2);
      expect(upstreams[0]?.closed).toBe(true);
      expect(upstreams[1]?.closed).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes the cached tool list on tools/list_changed", () => {
    const { state, upstreams, layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      expect(yield* gateway.listTools("linear")).toHaveLength(3);
      state.tools = [...state.tools, { name: "search", inputSchema: { type: "object" } }];
      // Still cached: nothing told the gateway the list changed.
      expect(yield* gateway.listTools("linear")).toHaveLength(3);
      yield* Effect.promise(() => upstreams[0]!.server.sendToolListChanged());
      // The client runs notification handlers a microtask after delivery.
      yield* Effect.promise(() => Promise.resolve());
      expect((yield* gateway.listTools("linear")).map((tool) => tool.name)).toContain("search");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps an upstream error to a typed failure", () => {
    const { layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const error = yield* gateway
        .callTool({ server: "linear", tool: "fail", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(error.reason).toBe("upstream_error");
      expect(error.message).toContain("upstream exploded");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a server that cannot start instead of listing it as empty", () =>
    Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const [status] = yield* gateway.listServers({ connect: true });
      expect(status).toMatchObject({ name: "broken", state: "error" });
      expect(status?.error).toContain("Could not connect");
      const tested = yield* gateway.test("broken-id").pipe(Effect.flip);
      expect(tested.reason).toBe("connection_failed");
    }).pipe(
      Effect.provide(
        McpGateway.layer.pipe(
          Layer.provide(
            Settings.layerTest({
              mcpServers: [
                server({
                  id: "broken-id",
                  name: "broken",
                  transport: {
                    type: "stdio",
                    command: "par3-missing-mcp-server-command",
                    args: [],
                  },
                }),
              ],
            }),
          ),
        ),
      ),
    ),
  );
});
