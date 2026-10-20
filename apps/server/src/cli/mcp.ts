import {
  isMcpServerHttpUrl,
  McpServerConfig,
  McpServerConfigs,
  McpServerConfigsPatch,
} from "@t3tools/contracts";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { mcpServerSecretName } from "../settingsSecrets.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const SparseSettings = Schema.Record(Schema.String, Schema.Unknown);
const decodeSettingsJson = Schema.decodeUnknownEffect(fromLenientJson(SparseSettings));
const encodeSettingsJson = Schema.encodeEffect(fromJsonStringPretty(SparseSettings));
const decodeStoredServer = Schema.decodeUnknownOption(McpServerConfig);
const decodeNewServers = Schema.decodeUnknownEffect(McpServerConfigsPatch);
const encodeServers = Schema.encodeSync(McpServerConfigs);

export class McpSettingsUnreadableError extends Schema.TaggedError<McpSettingsUnreadableError>()(
  "McpSettingsUnreadableError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read ${this.settingsPath}. Fix it, then run this again.`;
  }
}

export class McpSettingsBusyError extends Schema.TaggedError<McpSettingsBusyError>()(
  "McpSettingsBusyError",
  { settingsPath: Schema.String },
) {
  override get message(): string {
    return `${this.settingsPath} kept changing while writing. Try again.`;
  }
}

export class McpSettingsWriteError extends Schema.TaggedError<McpSettingsWriteError>()(
  "McpSettingsWriteError",
  { settingsPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not write ${this.settingsPath}.`;
  }
}

export class McpServerInputError extends Schema.TaggedError<McpServerInputError>()(
  "McpServerInputError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const runWithServerConfig = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (config: ServerConfig.ServerConfig["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    return yield* run(config).pipe(
      Effect.provide(
        ServerSecretStore.layer.pipe(
          Layer.provideMerge(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const readSettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(settingsPath).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed("")
          : Effect.fail(new McpSettingsUnreadableError({ settingsPath, cause })),
    }),
  );
  const settings =
    raw.trim().length === 0
      ? {}
      : yield* decodeSettingsJson(raw).pipe(
          Effect.mapError((cause) => new McpSettingsUnreadableError({ settingsPath, cause })),
        );
  const servers = settings.mcpServers ?? [];
  if (!Array.isArray(servers)) {
    return yield* new McpSettingsUnreadableError({
      settingsPath,
      cause: new Error("mcpServers is not a list"),
    });
  }
  return { raw, settings, servers: servers as ReadonlyArray<unknown> };
});

const serverName = (entry: unknown) =>
  typeof entry === "object" && entry !== null && "name" in entry ? entry.name : undefined;

/**
 * A running server owns this file too and serializes its own writes in-process only, so a write
 * here re-reads and retries when the file changed underneath it. The server's file watcher then
 * applies the change without a restart. Entries are kept as stored, not re-encoded, so fields
 * from a newer build survive.
 */
const updateServers = Effect.fn(function* (
  settingsPath: string,
  update: (
    servers: ReadonlyArray<unknown>,
  ) => Effect.Effect<ReadonlyArray<unknown>, McpServerInputError>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { raw, settings, servers } = yield* readSettings(settingsPath);
    const next = yield* update(servers);
    const contents = yield* encodeSettingsJson({ ...settings, mcpServers: next });
    const current = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
    if (current !== raw) continue;
    yield* writeFileStringAtomically({ filePath: settingsPath, contents: `${contents}\n` }).pipe(
      Effect.mapError((cause) => new McpSettingsWriteError({ settingsPath, cause })),
    );
    return;
  }
  return yield* new McpSettingsBusyError({ settingsPath });
});

const parseHeader = (header: string) => {
  const separator = header.indexOf(":");
  const name = header.slice(0, separator).trim();
  const value = header.slice(separator + 1).trim();
  return separator === -1 || name.length === 0 || value.length === 0
    ? Effect.fail(new McpServerInputError({ detail: 'Expected each --header as "Name: value".' }))
    : Effect.succeed({ name, value });
};

const describeTransport = (transport: McpServerConfig["transport"]) =>
  transport.type === "http" ? transport.url : [transport.command, ...transport.args].join(" ");

const mcpAddCommand = Command.make("add", {
  ...projectLocationFlags,
  transport: Flag.Literals("transport", ["stdio", "http"]).pipe(
    Flag.withAlias("t"),
    Flag.withDescription("How Par3 connects. Defaults to http for an http(s) URL, else stdio."),
    Flag.optional,
  ),
  env: Flag.KeyValuePair("env").pipe(
    Flag.withAlias("e"),
    Flag.withDescription("Environment variable for a stdio server, as KEY=value. Repeatable."),
    Flag.optional,
  ),
  header: Flag.String("header").pipe(
    Flag.withAlias("H"),
    Flag.withDescription('Header for an http server, as "Name: value". Repeatable.'),
    Flag.atLeast(0),
  ),
  description: Flag.String("description").pipe(
    Flag.withAlias("d"),
    Flag.withDescription("Tells agents when the server is useful."),
    Flag.optional,
  ),
  name: Argument.String("name").pipe(
    Argument.withDescription("What agents use to reach the server, such as linear."),
  ),
  target: Argument.String("command-or-url").pipe(
    Argument.withDescription("The command that starts a local server, or a remote server's URL."),
  ),
  args: Argument.String("args").pipe(
    Argument.withDescription("Arguments for the command. Put -- before them if any start with -."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription(
    "Share an MCP server with every agent. Environment and header values go to the secret store.",
  ),
  Command.withHandler((flags) =>
    runWithServerConfig(flags, (config) =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const transportType =
          Option.getOrUndefined(flags.transport) ??
          (isMcpServerHttpUrl(flags.target) ? "http" : "stdio");
        const environment = Object.entries(Option.getOrElse(flags.env, () => ({})));
        const headers = yield* Effect.forEach(flags.header, parseHeader);
        if (transportType === "http" && (flags.args.length > 0 || environment.length > 0)) {
          return yield* new McpServerInputError({
            detail: "An http server takes a URL only. Use --header for its credentials.",
          });
        }
        if (transportType === "stdio" && headers.length > 0) {
          return yield* new McpServerInputError({
            detail: "--header applies to http servers. Use --env for a stdio server.",
          });
        }

        const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const secrets = [
          ...environment.map(([name, value]) => ({ kind: "env" as const, name, value })),
          ...headers.map(({ name, value }) => ({ kind: "header" as const, name, value })),
        ];
        const stored = (name: string) => ({
          name,
          value: "",
          sensitive: true,
          valueRedacted: true,
        });
        const [server] = yield* decodeNewServers([
          {
            id,
            name: flags.name,
            ...Option.match(flags.description, {
              onNone: () => ({}),
              onSome: (description) => ({ description }),
            }),
            transport:
              transportType === "http"
                ? { type: "http", url: flags.target }
                : { type: "stdio", command: flags.target, args: flags.args },
            environment: environment.map(([name]) => stored(name)),
            headers: headers.map(({ name }) => stored(name)),
          },
        ]).pipe(
          Effect.mapError(
            (cause) => new McpServerInputError({ detail: `Invalid server: ${cause.message}` }),
          ),
        );

        const secretNames = secrets.map((secret) =>
          mcpServerSecretName(id, secret.kind, secret.name),
        );
        const removeSecrets = Effect.forEach(
          secretNames,
          (name) => secretStore.remove(name).pipe(Effect.ignore),
          { discard: true },
        );
        // Secrets first: a running server may reload the settings the moment they change.
        yield* Effect.forEach(
          secrets,
          (secret, index) =>
            secretStore.set(secretNames[index]!, new TextEncoder().encode(secret.value)),
          { discard: true },
        ).pipe(Effect.onError(() => removeSecrets));
        yield* updateServers(config.settingsPath, (servers) =>
          servers.some((entry) => serverName(entry) === flags.name)
            ? Effect.fail(
                new McpServerInputError({
                  detail: `A server named "${flags.name}" already exists. Remove it first with \`par3 mcp remove ${flags.name}\`.`,
                }),
              )
            : Effect.succeed([...servers, ...encodeServers([server!])]),
        ).pipe(Effect.onError(() => removeSecrets));

        yield* Console.log(
          `Added "${flags.name}" (${transportType}: ${describeTransport(server!.transport)}).` +
            (secrets.length > 0 ? ` ${secrets.length} value(s) stored as secrets.` : "") +
            "\nAgents reach it through mcp_servers and mcp_call.",
        );
      }),
    ),
  ),
);

const mcpListCommand = Command.make("list", { ...projectLocationFlags }).pipe(
  Command.withDescription("List the MCP servers shared with every agent."),
  Command.withHandler((flags) =>
    runWithServerConfig(flags, (config) =>
      Effect.gen(function* () {
        const { servers } = yield* readSettings(config.settingsPath);
        if (servers.length === 0) {
          return yield* Console.log("No shared MCP servers. Add one with `par3 mcp add`.");
        }
        const rows = servers.map((entry) =>
          Option.match(decodeStoredServer(entry), {
            onNone: () => [String(serverName(entry) ?? "?"), "invalid", ""],
            onSome: (server) => [
              server.name,
              server.enabled ? server.transport.type : `${server.transport.type}, off`,
              describeTransport(server.transport),
            ],
          }),
        );
        const widths = [0, 1].map((column) => Math.max(...rows.map((row) => row[column]!.length)));
        yield* Console.log(
          rows
            .map(([name, state, target]) =>
              `${name!.padEnd(widths[0]!)}  ${state!.padEnd(widths[1]!)}  ${target}`.trimEnd(),
            )
            .join("\n"),
        );
      }),
    ),
  ),
);

const mcpRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  name: Argument.String("name").pipe(Argument.withDescription("The server's name.")),
}).pipe(
  Command.withDescription("Stop sharing an MCP server and delete its stored secrets."),
  Command.withHandler((flags) =>
    runWithServerConfig(flags, (config) =>
      Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        let removed: ReadonlyArray<unknown> = [];
        yield* updateServers(config.settingsPath, (servers) => {
          removed = servers.filter((entry) => serverName(entry) === flags.name);
          return removed.length === 0
            ? Effect.fail(
                new McpServerInputError({ detail: `No shared MCP server named "${flags.name}".` }),
              )
            : Effect.succeed(servers.filter((entry) => serverName(entry) !== flags.name));
        });
        // After the settings write, so a failure here leaves an unused secret, never a server
        // without its credentials.
        for (const server of removed.flatMap((entry) =>
          Option.toArray(decodeStoredServer(entry)),
        )) {
          yield* Effect.forEach(
            [
              ...server.environment.map((variable) =>
                mcpServerSecretName(server.id, "env", variable.name),
              ),
              ...server.headers.map((header) =>
                mcpServerSecretName(server.id, "header", header.name),
              ),
            ],
            (name) => secretStore.remove(name).pipe(Effect.ignore({ log: true })),
            { discard: true },
          );
        }
        yield* Console.log(`Removed "${flags.name}".`);
      }),
    ),
  ),
);

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Manage the MCP servers Par3 shares with every agent."),
  Command.withSubcommands([mcpAddCommand, mcpListCommand, mcpRemoveCommand]),
);
