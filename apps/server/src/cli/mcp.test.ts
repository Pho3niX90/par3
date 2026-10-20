// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { mcpServerSecretName } from "../settingsSecrets.ts";
import { McpServerInputError } from "./mcp.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const makeBaseDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-mcp-cli-"));

const settingsPathFor = (baseDir: string) => NodePath.join(baseDir, "userdata", "settings.json");
const secretPathFor = (baseDir: string, name: string) =>
  NodePath.join(baseDir, "userdata", "secrets", `${name}.bin`);

const readSettings = (baseDir: string) =>
  JSON.parse(NodeFS.readFileSync(settingsPathFor(baseDir), "utf8")) as {
    readonly mcpServers: ReadonlyArray<Record<string, any>>;
  } & Record<string, unknown>;

const writeSettings = (baseDir: string, settings: Record<string, unknown>) => {
  NodeFS.mkdirSync(NodePath.dirname(settingsPathFor(baseDir)), { recursive: true });
  NodeFS.writeFileSync(settingsPathFor(baseDir), `${JSON.stringify(settings, null, 2)}\n`);
};

/** Reads settings the way a running server does, secrets included. */
const loadServerSettings = (baseDir: string) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return yield* settings.getSettings;
  }).pipe(
    Effect.provide(
      ServerSettings.layer.pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );

describe("par3 mcp", () => {
  it.effect("adds a stdio server whose environment the server reads from the secret store", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      writeSettings(baseDir, { somethingFromANewerBuild: { nested: true } });

      yield* runCli([
        "mcp",
        "add",
        "--base-dir",
        baseDir,
        "-e",
        "API_KEY=sk-test",
        "everything",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-everything",
      ]);

      const settings = readSettings(baseDir);
      assert.deepEqual(settings.somethingFromANewerBuild, { nested: true });
      const [stored] = settings.mcpServers;
      assert.equal(stored?.name, "everything");
      assert.deepEqual(stored?.transport, {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });
      assert.deepEqual(stored?.environment, [
        { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
      ]);
      assert.notInclude(NodeFS.readFileSync(settingsPathFor(baseDir), "utf8"), "sk-test");

      const loaded = yield* loadServerSettings(baseDir);
      assert.equal(loaded.mcpServers[0]?.environment[0]?.value, "sk-test");
    }),
  );

  it.effect("treats a URL as an http server and stores its headers as secrets", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      yield* runCli([
        "mcp",
        "add",
        "--base-dir",
        baseDir,
        "-H",
        "Authorization: Bearer token-1",
        "-d",
        "Issues",
        "linear",
        "https://mcp.company.test/mcp",
      ]);

      const [stored] = readSettings(baseDir).mcpServers;
      assert.deepEqual(stored?.transport, { type: "http", url: "https://mcp.company.test/mcp" });
      assert.equal(stored?.description, "Issues");
      const loaded = yield* loadServerSettings(baseDir);
      assert.equal(loaded.mcpServers[0]?.headers[0]?.value, "Bearer token-1");
    }),
  );

  it.effect("refuses a duplicate name without leaving its secrets behind", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      yield* runCli(["mcp", "add", "--base-dir", baseDir, "linear", "https://a.test/mcp"]);
      const secretsDir = NodePath.join(baseDir, "userdata", "secrets");
      const before = NodeFS.readdirSync(secretsDir);

      const error = yield* runCli([
        "mcp",
        "add",
        "--base-dir",
        baseDir,
        "-H",
        "Authorization: Bearer x",
        "linear",
        "https://b.test/mcp",
      ]).pipe(Effect.flip);

      assert.instanceOf(error, McpServerInputError);
      assert.lengthOf(readSettings(baseDir).mcpServers, 1);
      assert.deepEqual(NodeFS.readdirSync(secretsDir), before);
    }),
  );

  it.effect("refuses headers on a stdio server", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const error = yield* runCli([
        "mcp",
        "add",
        "--base-dir",
        baseDir,
        "-H",
        "X: y",
        "local",
        "my-server",
      ]).pipe(Effect.flip);
      assert.instanceOf(error, McpServerInputError);
      assert.isFalse(NodeFS.existsSync(settingsPathFor(baseDir)));
    }),
  );

  it.effect("does not echo a malformed header, which may be a token", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const error = yield* runCli([
        "mcp",
        "add",
        "--base-dir",
        baseDir,
        "-H",
        "Bearer sk-secret",
        "linear",
        "https://a.test/mcp",
      ]).pipe(Effect.flip);
      assert.instanceOf(error, McpServerInputError);
      assert.notInclude(error.message, "sk-secret");
    }),
  );

  it.effect("lists servers and removes one with its secrets", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      yield* runCli(["mcp", "add", "--base-dir", baseDir, "-e", "TOKEN=t", "local", "my-server"]);
      yield* runCli(["mcp", "add", "--base-dir", baseDir, "linear", "https://a.test/mcp"]);
      const localId = readSettings(baseDir).mcpServers[0]?.id as string;
      const secretPath = secretPathFor(baseDir, mcpServerSecretName(localId, "env", "TOKEN"));
      assert.isTrue(NodeFS.existsSync(secretPath));

      yield* runCli(["mcp", "list", "--base-dir", baseDir]);
      const listed = (yield* TestConsole.logLines).join("\n");
      assert.include(listed, "local   stdio  my-server");
      assert.include(listed, "linear  http   https://a.test/mcp");

      yield* runCli(["mcp", "remove", "--base-dir", baseDir, "local"]);
      assert.deepEqual(
        readSettings(baseDir).mcpServers.map((server) => server.name),
        ["linear"],
      );
      assert.isFalse(NodeFS.existsSync(secretPath));
    }),
  );
});
