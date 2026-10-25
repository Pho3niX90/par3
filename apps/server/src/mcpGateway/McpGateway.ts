/**
 * Shares the third-party MCP servers in settings with every agent through the `t3-code` server's
 * `mcp_servers` and `mcp_call` tools. One lazily opened connection per server serves every thread.
 * Effect's `McpServer` cannot remove or filter tools per caller, so every policy check happens here.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type Tool as UpstreamTool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isMcpServerHttpUrl,
  McpGatewayError,
  type McpGatewayServerStatus,
  type McpGatewayTestResult,
  type McpGatewayTool,
  type McpServerConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as Settings from "../serverSettings.ts";

const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 5 * 60_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL_CHARS = 2_000;
const ERROR_DETAIL_CHARS = 500;
const MIN_REDACTED_CHARS = 4;

export interface McpGatewayCaller {
  readonly threadId?: string;
  readonly providerInstanceId?: string;
  readonly clientLabel?: string;
  /**
   * Why the caller may call only tools the upstream marks `readOnlyHint`: a read-only MCP client,
   * or a thread in plan mode, which must not change anything while it plans.
   */
  readonly readOnly: false | "client" | "plan";
}

/** The upstream `tools/call` result, passed to the agent unchanged. */
export interface McpGatewayCallResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

interface OpenedTransport {
  readonly transport: Transport;
  /** The end of the server's stderr, which usually says why a command failed to start. */
  readonly stderrTail: () => string;
}

/** May throw; the gateway reports that as this server failing to connect. */
export type OpenTransport = (server: McpServerConfig) => OpenedTransport;

export class McpGateway extends Context.Service<
  McpGateway,
  {
    /** `connect` opens every enabled server first, so a broken one reports its error. */
    readonly listServers: (options: {
      readonly connect: boolean;
    }) => Effect.Effect<ReadonlyArray<McpGatewayServerStatus>, McpGatewayError>;
    /** Only the tools the server's policy lets agents call. */
    readonly listTools: (
      server: string,
    ) => Effect.Effect<ReadonlyArray<McpGatewayTool>, McpGatewayError>;
    readonly callTool: (input: {
      readonly server: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly caller: McpGatewayCaller;
    }) => Effect.Effect<McpGatewayCallResult, McpGatewayError>;
    /** Reconnects one server by id, even a disabled one, and lists every tool it offers. */
    readonly test: (serverId: string) => Effect.Effect<McpGatewayTestResult, McpGatewayError>;
  }
>()("t3/mcpGateway/McpGateway") {}

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

const describeCause = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

const isTimeout = (cause: unknown) =>
  cause instanceof McpError && cause.code === ErrorCode.RequestTimeout;

/**
 * A JSON-RPC error answer leaves the connection usable. Anything else, such as an HTTP error
 * status for an expired session, a dropped connection, or a timeout, means it is not.
 */
const brokeConnection = (cause: unknown) =>
  !(cause instanceof McpError) ||
  cause.code === ErrorCode.ConnectionClosed ||
  cause.code === ErrorCode.RequestTimeout;

/** Longest first, so a value that contains another is redacted whole. */
const secretValuesOf = (server: McpServerConfig) =>
  [...server.environment, ...server.headers]
    .filter((variable) => variable.sensitive)
    .flatMap((variable) => {
      const value = variable.value.trim();
      // A header such as `Bearer <token>` may be echoed without its scheme.
      return [value, value.slice(value.lastIndexOf(" ") + 1)];
    })
    .filter((value) => value.length >= MIN_REDACTED_CHARS)
    .sort((left, right) => right.length - left.length);

/** Upstream messages and stderr reach agents, and a server may echo its own token in them. */
const failureText = (server: McpServerConfig, text: string) =>
  cut(
    secretValuesOf(server).reduce(
      (redacted, secret) => redacted.replaceAll(secret, "[redacted]"),
      text,
    ),
    ERROR_DETAIL_CHARS,
  );

const headerRecord = (server: McpServerConfig) =>
  Object.fromEntries(server.headers.map((header) => [header.name, header.value]));

const openDefaultTransport: OpenTransport = (server) => {
  if (server.transport.type === "http") {
    // Saving checks the URL, but settings written before that check still load.
    if (!isMcpServerHttpUrl(server.transport.url)) {
      throw new Error("Its URL is not a valid http or https URL.");
    }
    return {
      // The SDK's own classes declare optional fields without `| undefined`.
      transport: new StreamableHTTPClientTransport(new URL(server.transport.url), {
        requestInit: { headers: headerRecord(server) },
      }) as Transport,
      stderrTail: () => "",
    };
  }
  let tail = "";
  const transport = new StdioClientTransport({
    command: server.transport.command,
    args: [...server.transport.args],
    env: Object.fromEntries(server.environment.map((variable) => [variable.name, variable.value])),
    ...(server.transport.cwd === undefined ? {} : { cwd: server.transport.cwd }),
    // Piped, not inherited, so a chatty server stays out of Par3's own log; it must be drained
    // or the child blocks once the pipe fills.
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
  });
  return { transport: transport as Transport, stderrTail: () => tail };
};

/** Secrets are part of it, so a rotated token reconnects; it stays in memory. */
const fingerprintOf = (server: McpServerConfig) =>
  encodeJsonText([
    server.transport,
    server.environment.map((variable) => [variable.name, variable.value]),
    server.headers.map((header) => [header.name, header.value]),
  ]);

const allowedByPolicy = (server: McpServerConfig, tool: string) =>
  server.toolPolicy.mode === "all" || server.toolPolicy.tools.includes(tool);

const presentTool = (server: McpServerConfig, tool: UpstreamTool): McpGatewayTool => ({
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
  inputSchema: tool.inputSchema,
  ...(tool.annotations === undefined
    ? {}
    : {
        annotations: Object.fromEntries(
          (
            ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const
          ).flatMap((key) =>
            tool.annotations?.[key] === undefined ? [] : [[key, tool.annotations[key]]],
          ),
        ),
      }),
  allowed: allowedByPolicy(server, tool.name),
});

interface Connection {
  readonly client: Client;
  tools: ReadonlyArray<UpstreamTool> | undefined;
  /** Bumped by `tools/list_changed`, so a listing already in flight does not cache a stale list. */
  toolsGeneration: number;
}

interface Slot {
  readonly fingerprint: string;
  readonly lock: Semaphore.Semaphore;
  connection: Connection | undefined;
  lastError: string | undefined;
  lastUsedAt: number;
  /** The idle reaper leaves a connection alone while a call or listing uses it. */
  activeCalls: number;
  /** Replaced or dropped: a connection that opens on it afterwards is closed at once. */
  retired: boolean;
}

export const makeWithTransport = Effect.fn("McpGateway.makeWithTransport")(function* (
  openTransport: OpenTransport,
) {
  const settingsService = yield* Settings.ServerSettingsService;
  const slots = new Map<string, Slot>();

  const closeConnection = (slot: Slot) =>
    Effect.suspend(() => {
      const connection = slot.connection;
      // Cleared first so the client's onclose does not record an intentional close as an error.
      slot.connection = undefined;
      return connection === undefined
        ? Effect.void
        : Effect.promise(() => connection.client.close().catch(() => undefined));
    });

  const retire = (slot: Slot) =>
    Effect.suspend(() => {
      slot.retired = true;
      return closeConnection(slot);
    });

  const dropSlot = (id: string) =>
    Effect.suspend(() => {
      const slot = slots.get(id);
      if (slot === undefined) return Effect.void;
      slots.delete(id);
      return retire(slot);
    });

  const readServers = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.mcpServers),
    Effect.mapError(
      () =>
        new McpGatewayError({
          reason: "connection_failed",
          detail: "Could not read the MCP server settings.",
        }),
    ),
  );

  const findServer = Effect.fn("McpGateway.findServer")(function* (name: string) {
    const server = (yield* readServers).find((candidate) => candidate.name === name);
    if (server === undefined) {
      return yield* new McpGatewayError({
        reason: "server_not_found",
        detail: `No MCP server named "${name}" is configured. Call mcp_servers to list them.`,
      });
    }
    if (!server.enabled) {
      return yield* new McpGatewayError({
        reason: "server_disabled",
        detail: `The MCP server "${name}" is disabled in Par3's settings.`,
      });
    }
    return server;
  });

  const slotFor = Effect.fn("McpGateway.slotFor")(function* (server: McpServerConfig) {
    const fingerprint = fingerprintOf(server);
    const now = yield* Clock.currentTimeMillis;
    // Looked up and replaced in one step, so concurrent callers never orphan each other's slot.
    const { slot, replaced } = yield* Effect.sync(() => {
      const existing = slots.get(server.id);
      if (existing?.fingerprint === fingerprint) return { slot: existing, replaced: undefined };
      const slot: Slot = {
        fingerprint,
        lock: Semaphore.makeUnsafe(1),
        connection: undefined,
        lastError: undefined,
        lastUsedAt: now,
        activeCalls: 0,
        retired: false,
      };
      slots.set(server.id, slot);
      return { slot, replaced: existing };
    });
    if (replaced !== undefined) yield* retire(replaced);
    return slot;
  });

  const connect = (server: McpServerConfig, slot: Slot) =>
    Effect.suspend(() => {
      let opened: OpenedTransport | undefined;
      const stderrOf = () => {
        const stderr = opened?.stderrTail().trim();
        return stderr ? ` ${stderr}` : "";
      };
      const client = new Client({ name: "par3", version: packageJson.version });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        const connection = slot.connection;
        if (connection?.client !== client) return;
        connection.tools = undefined;
        connection.toolsGeneration += 1;
      });
      client.onclose = () => {
        if (slot.connection?.client !== client) return;
        slot.connection = undefined;
        slot.lastError = failureText(server, `The server closed the connection.${stderrOf()}`);
      };
      return Effect.tryPromise({
        try: async (signal) => {
          // Opened inside the try, so a transport that cannot be built fails this server only.
          opened = openTransport(server);
          try {
            await client.connect(opened.transport, { signal, timeout: CONNECT_TIMEOUT_MS });
          } catch (cause) {
            await client.close().catch(() => undefined);
            throw cause;
          }
          return { client, tools: undefined, toolsGeneration: 0 } as Connection;
        },
        catch: (cause) =>
          new McpGatewayError({
            reason: isTimeout(cause) ? "timeout" : "connection_failed",
            detail: failureText(
              server,
              `Could not connect to "${server.name}": ${describeCause(cause)}${stderrOf()}`,
            ),
          }),
      });
    });

  const connectedOn = (server: McpServerConfig, slot: Slot) =>
    slot.lock.withPermits(1)(
      Effect.suspend(() =>
        slot.connection !== undefined
          ? Effect.succeed(slot.connection)
          : connect(server, slot).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  slot.lastError = error.detail;
                }),
              ),
              Effect.flatMap((connection) =>
                Effect.suspend(() => {
                  if (!slot.retired) {
                    slot.connection = connection;
                    slot.lastError = undefined;
                    return Effect.succeed(connection);
                  }
                  // Its settings changed or it was removed while connecting. Nothing else
                  // tracks this connection, so a stdio server would outlive it.
                  return Effect.promise(() =>
                    connection.client.close().catch(() => undefined),
                  ).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new McpGatewayError({
                          reason: "connection_failed",
                          detail: `The settings of "${server.name}" changed while connecting. Try again.`,
                        }),
                      ),
                    ),
                  );
                }),
              ),
            ),
      ),
    );

  const withConnection = <A>(
    server: McpServerConfig,
    use: (connection: Connection, slot: Slot) => Effect.Effect<A, McpGatewayError>,
  ) =>
    Effect.flatMap(slotFor(server), (slot) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          slot.activeCalls += 1;
        }),
        () => Effect.flatMap(connectedOn(server, slot), (connection) => use(connection, slot)),
        () =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Effect.sync(() => {
              slot.activeCalls -= 1;
              slot.lastUsedAt = now;
            }),
          ),
      ),
    );

  /** Closes a broken connection, so the next call reconnects instead of failing the same way. */
  const request = <A>(
    server: McpServerConfig,
    slot: Slot,
    connection: Connection,
    action: string,
    run: (signal: AbortSignal) => Promise<A>,
  ) =>
    Effect.tryPromise({ try: run, catch: (cause) => ({ cause }) }).pipe(
      Effect.catch(({ cause }) => {
        const error = new McpGatewayError({
          reason: isTimeout(cause) ? "timeout" : "upstream_error",
          detail: failureText(server, `"${server.name}" ${action} failed: ${describeCause(cause)}`),
        });
        return Effect.suspend(() =>
          brokeConnection(cause) && slot.connection?.client === connection.client
            ? closeConnection(slot).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    slot.lastError = error.detail;
                  }),
                ),
              )
            : Effect.void,
        ).pipe(Effect.andThen(Effect.fail(error)));
      }),
    );

  const listedTools = (server: McpServerConfig, connection: Connection, slot: Slot) =>
    Effect.suspend(() => {
      if (connection.tools !== undefined) return Effect.succeed(connection.tools);
      const generation = connection.toolsGeneration;
      return request(server, slot, connection, "listing tools", async (signal) => {
        const listed: Array<UpstreamTool> = [];
        let cursor: string | undefined;
        do {
          const page = await connection.client.listTools(cursor === undefined ? {} : { cursor }, {
            signal,
            timeout: LIST_TIMEOUT_MS,
          });
          listed.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return listed;
      }).pipe(
        Effect.tap((tools) =>
          Effect.sync(() => {
            if (connection.toolsGeneration === generation) connection.tools = tools;
            slot.lastError = undefined;
          }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            slot.lastError = error.detail;
          }),
        ),
      );
    });

  const toolsOf = (server: McpServerConfig) =>
    withConnection(server, (connection, slot) => listedTools(server, connection, slot)).pipe(
      Effect.withSpan("McpGateway.toolsOf"),
    );

  const statusOf = (server: McpServerConfig): McpGatewayServerStatus => {
    const base = {
      id: server.id,
      name: server.name,
      ...(server.description ? { description: server.description } : {}),
    };
    if (!server.enabled) return { ...base, state: "disabled" };
    const slot = slots.get(server.id);
    const current = slot?.fingerprint === fingerprintOf(server) ? slot : undefined;
    if (current?.lastError !== undefined) {
      return { ...base, state: "error", error: current.lastError };
    }
    const tools = current?.connection?.tools;
    if (current?.connection !== undefined) {
      return {
        ...base,
        state: "connected",
        ...(tools === undefined
          ? {}
          : { toolCount: tools.filter((tool) => allowedByPolicy(server, tool.name)).length }),
      };
    }
    return { ...base, state: "idle" };
  };

  const listServers: McpGateway["Service"]["listServers"] = Effect.fn("McpGateway.listServers")(
    function* ({ connect: shouldConnect }) {
      const servers = yield* readServers;
      if (shouldConnect) {
        // Failures land in each slot's lastError, which the status reports.
        yield* Effect.forEach(
          servers.filter((server) => server.enabled),
          (server) => toolsOf(server).pipe(Effect.ignore),
          { concurrency: "unbounded", discard: true },
        );
      }
      return servers.map(statusOf);
    },
  );

  const listTools: McpGateway["Service"]["listTools"] = Effect.fn("McpGateway.listTools")(
    function* (name) {
      const server = yield* findServer(name);
      const tools = yield* toolsOf(server);
      return tools
        .filter((tool) => allowedByPolicy(server, tool.name))
        .map((tool) => presentTool(server, tool));
    },
  );

  const invoke = Effect.fn("McpGateway.invoke")(function* (
    input: Parameters<McpGateway["Service"]["callTool"]>[0],
  ): Effect.fn.Return<McpGatewayCallResult, McpGatewayError> {
    const server = yield* findServer(input.server);
    const result = yield* withConnection(server, (connection, slot) =>
      Effect.gen(function* () {
        const upstream = (yield* listedTools(server, connection, slot)).find(
          (tool) => tool.name === input.tool,
        );
        if (upstream === undefined) {
          return yield* new McpGatewayError({
            reason: "tool_not_found",
            detail: `"${server.name}" has no tool named "${input.tool}". Call mcp_servers with server "${server.name}" to list its tools.`,
          });
        }
        if (!allowedByPolicy(server, upstream.name)) {
          return yield* new McpGatewayError({
            reason: "tool_not_allowed",
            detail: `Par3's settings do not let agents call "${upstream.name}" on "${server.name}".`,
          });
        }
        if (input.caller.readOnly !== false && upstream.annotations?.readOnlyHint !== true) {
          return yield* new McpGatewayError({
            reason: "read_only",
            detail:
              input.caller.readOnly === "plan"
                ? `"${upstream.name}" is not marked read-only, and this thread is in plan mode, where shared MCP servers allow only read-only tools. It can be called once the user takes the thread out of plan mode.`
                : `"${upstream.name}" is not marked read-only, and this MCP client was approved for read-only access.`,
          });
        }
        return yield* request(server, slot, connection, `calling "${upstream.name}"`, (signal) =>
          connection.client.callTool(
            { name: upstream.name, arguments: { ...input.arguments } },
            undefined,
            { signal, timeout: CALL_TIMEOUT_MS },
          ),
        );
      }),
    );
    // Servers on the 2024-10-07 protocol answer with `toolResult` instead of content blocks.
    if ("toolResult" in result) {
      return { content: [{ type: "text", text: encodeJsonText(result.toolResult) }] };
    }
    return {
      content: result.content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    } satisfies McpGatewayCallResult;
  });

  // The thread's own tool activity is what users see; this line is the operator's audit trail.
  const callTool: McpGateway["Service"]["callTool"] = Effect.fn("McpGateway.callTool")(
    function* (input) {
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* invoke(input).pipe(
        Effect.onExit((exit) =>
          Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
            Effect.logInfo("mcp gateway tool call", {
              server: input.server,
              tool: input.tool,
              threadId: input.caller.threadId,
              providerInstanceId: input.caller.providerInstanceId,
              client: input.caller.clientLabel,
              durationMs: endedAt - startedAt,
              outcome:
                exit._tag === "Success"
                  ? exit.value.isError === true
                    ? "tool_error"
                    : "success"
                  : "failure",
            }),
          ),
        ),
      );
    },
  );

  const test: McpGateway["Service"]["test"] = Effect.fn("McpGateway.test")(function* (serverId) {
    const server = (yield* readServers).find((candidate) => candidate.id === serverId);
    if (server === undefined) {
      return yield* new McpGatewayError({
        reason: "server_not_found",
        detail: "This MCP server is not saved on the environment yet.",
      });
    }
    yield* dropSlot(server.id);
    const tools = yield* toolsOf(server).pipe(
      Effect.ensuring(server.enabled ? Effect.void : dropSlot(server.id)),
    );
    return {
      server: server.enabled
        ? statusOf(server)
        : {
            ...statusOf(server),
            toolCount: tools.filter((tool) => allowedByPolicy(server, tool.name)).length,
          },
      tools: tools.map((tool) => presentTool(server, tool)),
    };
  });

  yield* settingsService.streamChanges.pipe(
    Stream.runForEach((settings) =>
      Effect.suspend(() => {
        const stale = [...slots].filter(([id, slot]) => {
          const server = settings.mcpServers.find((candidate) => candidate.id === id);
          return (
            server === undefined || !server.enabled || slot.fingerprint !== fingerprintOf(server)
          );
        });
        for (const [id] of stale) slots.delete(id);
        return Effect.forEach(stale, ([, slot]) => retire(slot), { discard: true });
      }),
    ),
    Effect.forkScoped,
  );

  yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const slot of slots.values()) {
      if (
        slot.connection !== undefined &&
        slot.activeCalls === 0 &&
        now - slot.lastUsedAt > IDLE_TIMEOUT_MS
      ) {
        yield* closeConnection(slot);
      }
    }
  }).pipe(Effect.repeat(Schedule.spaced(Duration.minutes(1))), Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...slots.keys()], dropSlot, { concurrency: "unbounded", discard: true }),
  );

  return { listServers, listTools, callTool, test } satisfies McpGateway["Service"];
});

/** @public */
export const make = makeWithTransport(openDefaultTransport);

export const layer = Layer.effect(McpGateway, make);
