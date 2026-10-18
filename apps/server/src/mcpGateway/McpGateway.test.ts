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
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as Settings from "../serverSettings.ts";
import * as McpGateway from "./McpGateway.ts";

const readOnlyCaller = { readOnly: "client", threadId: "thread-1" } as const;
const planCaller = { readOnly: "plan", threadId: "thread-1" } as const;
const caller = { readOnly: false, threadId: "thread-1" } as const;

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

/** Holds one upstream step until the test opens it. */
function gate() {
  let open!: () => void;
  let enter!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const entered = new Promise<void>((resolve) => (enter = resolve));
  return { open, opened, enter, entered };
}
type Gate = ReturnType<typeof gate>;

/** Each connect gets a fresh in-process upstream server sharing one tool list. */
function fixture(servers: ReadonlyArray<McpServerConfig>) {
  const state = {
    tools: [lookup, write, fail] as Array<Tool>,
    failMessage: "upstream exploded",
    /** Makes the transport refuse to send a tool call, as an expired HTTP session does. */
    sendFails: false,
    connectGate: undefined as Gate | undefined,
    listGate: undefined as Gate | undefined,
    callGate: undefined as Gate | undefined,
  };
  const take = (key: "connectGate" | "listGate" | "callGate") => {
    const held = state[key];
    state[key] = undefined;
    return held;
  };
  const upstreams: Array<{ readonly server: Server; closed: boolean }> = [];
  const openTransport: McpGateway.OpenTransport = () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = clientSide.send.bind(clientSide);
    clientSide.send = async (message, options) => {
      if (state.sendFails && "method" in message && message.method === "tools/call") {
        throw new Error("Streamable HTTP error: Error POSTing to endpoint (HTTP 404)");
      }
      return send(message, options);
    };
    const upstream = new Server(
      { name: "upstream", version: "1" },
      { capabilities: { tools: { listChanged: true } } },
    );
    upstream.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = state.tools;
      const held = take("listGate");
      if (held !== undefined) {
        held.enter();
        await held.opened;
      }
      return { tools };
    });
    upstream.setRequestHandler(CallToolRequestSchema, async (request) => {
      const held = take("callGate");
      if (held !== undefined) {
        held.enter();
        await held.opened;
      }
      if (request.params.name === "fail") throw new Error(state.failMessage);
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
    const held = take("connectGate");
    if (held === undefined) {
      void upstream.connect(serverSide);
    } else {
      // The client's initialize request waits in the transport until the upstream starts.
      held.enter();
      void held.opened.then(() => upstream.connect(serverSide));
    }
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
      expect(refused.message).toContain("read-only access");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a thread in plan mode to tools marked readOnlyHint, and says why", () => {
    const { layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const read = yield* gateway.callTool({
        server: "linear",
        tool: "lookup",
        arguments: {},
        caller: planCaller,
      });
      expect(read.content[0]).toMatchObject({ type: "text" });
      const refused = yield* gateway
        .callTool({ server: "linear", tool: "write", arguments: {}, caller: planCaller })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("read_only");
      expect(refused.message).toContain("plan mode");
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

  it.effect("closes a connection that finishes opening after its server was replaced", () => {
    const { state, upstreams, layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const held = gate();
      state.connectGate = held;
      const pending = yield* gateway.listTools("linear").pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => held.entered);
      // Testing replaces the server's connection while the first one is still opening.
      yield* gateway.test("linear-id");
      held.open();
      const error = yield* Fiber.join(pending);
      expect(error.reason).toBe("connection_failed");
      expect(upstreams).toHaveLength(2);
      expect(upstreams[0]?.closed).toBe(true);
      expect(upstreams[1]?.closed).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("closes a connection whose transport fails, and reconnects on the next call", () => {
    const { state, upstreams, layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      yield* gateway.callTool({ server: "linear", tool: "lookup", arguments: {}, caller });
      state.sendFails = true;
      const error = yield* gateway
        .callTool({ server: "linear", tool: "lookup", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(error.reason).toBe("upstream_error");
      expect(upstreams[0]?.closed).toBe(true);
      expect(yield* gateway.listServers({ connect: false })).toMatchObject([
        { name: "linear", state: "error" },
      ]);

      state.sendFails = false;
      yield* gateway.callTool({ server: "linear", tool: "lookup", arguments: {}, caller });
      expect(upstreams).toHaveLength(2);
      expect(yield* gateway.listServers({ connect: false })).toMatchObject([
        { name: "linear", state: "connected" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not close an idle-looking connection while a call is running", () => {
    const { state, upstreams, layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      yield* gateway.listTools("linear");
      const held = gate();
      state.callGate = held;
      const running = yield* gateway
        .callTool({ server: "linear", tool: "lookup", arguments: {}, caller })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => held.entered);
      yield* TestClock.adjust("15 minutes");
      held.open();
      const result = yield* Fiber.join(running);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(upstreams).toHaveLength(1);
      expect(upstreams[0]?.closed).toBe(false);
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

  it.effect("does not cache a listing that tools/list_changed made stale while it ran", () => {
    const { state, upstreams, layer } = fixture([server()]);
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const held = gate();
      state.listGate = held;
      const listing = yield* gateway.listTools("linear").pipe(Effect.forkChild);
      yield* Effect.promise(() => held.entered);
      state.tools = [...state.tools, { name: "search", inputSchema: { type: "object" } }];
      yield* Effect.promise(() => upstreams[0]!.server.sendToolListChanged());
      yield* Effect.promise(() => Promise.resolve());
      held.open();
      expect(yield* Fiber.join(listing)).toHaveLength(3);
      expect((yield* gateway.listTools("linear")).map((tool) => tool.name)).toContain("search");
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps an upstream error to a typed failure, without the server's secrets", () => {
    const { state, layer } = fixture([
      server({
        headers: [{ name: "Authorization", value: "Bearer s3cret-token", sensitive: true }],
      }),
    ]);
    state.failMessage = "upstream exploded for token s3cret-token";
    return Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const error = yield* gateway
        .callTool({ server: "linear", tool: "fail", arguments: {}, caller })
        .pipe(Effect.flip);
      expect(error.reason).toBe("upstream_error");
      expect(error.message).toContain("upstream exploded");
      expect(error.message).not.toContain("s3cret-token");
      // A JSON-RPC error leaves the connection usable.
      expect(yield* gateway.listServers({ connect: false })).toMatchObject([
        { name: "linear", state: "connected" },
      ]);
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

  it.effect("reports a stored invalid URL on that server alone", () =>
    Effect.gen(function* () {
      const gateway = yield* McpGateway.McpGateway;
      const [status] = yield* gateway.listServers({ connect: true });
      expect(status).toMatchObject({ name: "bad-url", state: "error" });
      expect(status?.error).toContain("not a valid http or https URL");
      const tested = yield* gateway.test("bad-url-id").pipe(Effect.flip);
      expect(tested.reason).toBe("connection_failed");
    }).pipe(
      Effect.provide(
        McpGateway.layer.pipe(
          Layer.provide(
            Settings.layerTest({
              mcpServers: [
                server({
                  id: "bad-url-id",
                  name: "bad-url",
                  transport: { type: "http", url: "mcp.company.test/mcp" },
                }),
              ],
            }),
          ),
        ),
      ),
    ),
  );
});
