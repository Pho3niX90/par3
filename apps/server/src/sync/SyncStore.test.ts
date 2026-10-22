import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type SyncApplyOp,
  syncItemKey,
  VaultError,
  vaultReference,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as VaultService from "../vault/VaultService.ts";
import { hashContents, makeVaultCategory } from "./categories.ts";
import { FILE_CATEGORIES, makeFileCategory } from "./fileCategories.ts";
import * as SyncStore from "./SyncStore.ts";

const storeLayer = SyncStore.layer.pipe(
  Layer.provideMerge(VaultService.layer),
  Layer.provideMerge(ServerSettingsModule.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-a")),
    }),
  ),
  Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sync-store-test-" })),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** A sync store whose Claude home is a scratch directory with the given files. */
const setup = (
  files: Readonly<Record<string, string | Uint8Array>>,
  options: { readonly linkedHome?: boolean } = {},
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(storeLayer);
    const fs = Context.get(context, FileSystem.FileSystem);
    const path = Context.get(context, Path.Path);
    const settings = Context.get(context, ServerSettingsModule.ServerSettingsService);
    const config = Context.get(context, ServerConfig.ServerConfig);
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-claude-home-" });
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(home, name);
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* typeof contents === "string"
        ? fs.writeFileString(target, contents)
        : fs.writeFile(target, contents);
    }
    // Dotfile managers often make the whole provider home a link to a checkout.
    const configuredHome = options.linkedHome
      ? path.join(yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-link-" }), "claude")
      : home;
    if (options.linkedHome) yield* fs.symlink(home, configuredHome);
    yield* settings.updateSettings({
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: configuredHome },
        },
      },
    });
    const store = Context.get(context, SyncStore.SyncStore);
    yield* store.setParticipation({
      enabled: true,
      categories: ["claude.agents", "claude.instructions", "mcpServers"],
      excluded: [],
    });
    return { store, fs, path, home, settings, config };
  });

const agentKey = (name: string) => syncItemKey("claude.agents", name);

const writeOp = (key: string, contents: string, expectedHash: string | null): SyncApplyOp => ({
  key,
  expectedHash,
  action: { _tag: "write", contents },
  baseline: { hash: hashContents(contents), rev: 1 },
});

it.effect("lists only the files a category syncs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store } = yield* setup({
        "agents/reviewer.md": "# Reviewer",
        "agents/.draft.md": "hidden",
        "agents/notes.txt": "not markdown",
        "agents/binary.md": new Uint8Array([0x23, 0x00, 0x01]),
        "rules/style.md": "Be brief.",
        "CLAUDE.md": "Global instructions",
        "settings.json": "{}",
        ".credentials.json": "{}",
      });
      const snapshot = yield* store.snapshot;
      const listed = snapshot.items
        .filter((item) => item.categoryId.startsWith("claude."))
        .map((item) => [item.key, item.skipped ?? null]);
      assert.deepEqual(listed.toSorted(), [
        ["claude.agents:agents/binary.md", "binary"],
        ["claude.agents:agents/reviewer.md", null],
        ["claude.instructions:CLAUDE.md", null],
        ["claude.instructions:rules/style.md", null],
      ]);
    }),
  ),
);

it.effect("syncs files in a provider home that is itself a link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store } = yield* setup({ "agents/reviewer.md": "# Reviewer" }, { linkedHome: true });
      const item = (yield* store.snapshot).items.find(
        (candidate) => candidate.key === agentKey("agents/reviewer.md"),
      );
      assert.isDefined(item);
      assert.isUndefined(item?.skipped);
      assert.equal(item?.hash, hashContents("# Reviewer"));
    }),
  ),
);

it.effect("writes only over the version the caller saw, and records what it wrote", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, fs, path, home } = yield* setup({});
      const key = agentKey("agents/new.md");

      const stale = yield* store.apply({ ops: [writeOp(key, "# New", "not-what-is-there")] });
      assert.equal(stale.results[0]?.status, "stale");
      assert.isFalse(yield* fs.exists(path.join(home, "agents/new.md")));
      assert.deepEqual((yield* store.snapshot).baselines, {});

      const applied = yield* store.apply({ ops: [writeOp(key, "# New", null)] });
      assert.equal(applied.results[0]?.status, "applied");
      assert.equal(yield* fs.readFileString(path.join(home, "agents/new.md")), "# New");
      const snapshot = yield* store.snapshot;
      assert.deepEqual(snapshot.baselines[key], { hash: hashContents("# New"), rev: 1 });
      assert.equal(snapshot.items.find((item) => item.key === key)?.hash, hashContents("# New"));
    }),
  ),
);

it.effect("refuses paths outside a category and categories this machine does not sync", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store } = yield* setup({});
      const result = yield* store.apply({
        ops: [
          writeOp(agentKey("../escape.md"), "x", null),
          writeOp(agentKey("settings.json"), "x", null),
          writeOp(agentKey("agents/../../escape.md"), "x", null),
          writeOp(syncItemKey("codex.prompts", "prompts/p.md"), "x", null),
        ],
      });
      assert.deepEqual(
        result.results.map((outcome) => outcome.status),
        ["rejected", "rejected", "rejected", "rejected"],
      );
    }),
  ),
);

it.effect("deletes a file and remembers the deletion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, fs, path, home, config } = yield* setup({ "agents/old.md": "# Old" });
      const key = agentKey("agents/old.md");
      const result = yield* store.apply({
        ops: [
          {
            key,
            expectedHash: hashContents("# Old"),
            action: { _tag: "delete" },
            baseline: { hash: null, rev: 2 },
          },
        ],
      });
      assert.equal(result.results[0]?.status, "applied");
      assert.isFalse(yield* fs.exists(path.join(home, "agents/old.md")));
      const state = yield* fs.readFileString(path.join(config.stateDir, "sync-state.json"));
      assert.include(state, `"${key}":{"hash":null,"rev":2}`);
    }),
  ),
);

it.effect("tells subscribers about a change it applied", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store } = yield* setup({});
      const first = yield* Deferred.make<void>();
      const fiber = yield* store.subscribe.pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.filter((snapshot) =>
          snapshot.items.some((item) => item.key === agentKey("agents/live.md")),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(first);
      yield* store.apply({ ops: [writeOp(agentKey("agents/live.md"), "# Live", null)] });
      yield* TestClock.adjust("1 second");
      const [snapshot] = yield* Fiber.join(fiber);
      assert.deepEqual(snapshot?.baselines[agentKey("agents/live.md")], {
        hash: hashContents("# Live"),
        rev: 1,
      });
    }),
  ),
);

it.effect("shares an MCP server only once its secrets are vault references", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, settings } = yield* setup({});
      const server = (value: string) => ({
        id: "linear",
        name: "linear",
        enabled: true,
        transport: { type: "http" as const, url: "https://mcp.linear.app/mcp" },
        environment: [],
        headers: [{ name: "Authorization", value, sensitive: true }],
        toolPolicy: {
          mode: "all" as const,
          tools: [],
          readOnlyClientsMayCall: "readOnlyHint" as const,
        },
      });
      yield* settings.updateSettings({ mcpServers: [server("Bearer plain")] });
      const key = syncItemKey("mcpServers", "linear");
      const local = (yield* store.snapshot).items.find((item) => item.key === key);
      assert.equal(local?.skipped, "needs-vault");

      yield* settings.updateSettings({ mcpServers: [server(vaultReference("LINEAR_TOKEN"))] });
      const shared = (yield* store.snapshot).items.find((item) => item.key === key);
      assert.isUndefined(shared?.skipped);
      const contents = (yield* store.read(key)).contents;
      assert.include(contents, vaultReference("LINEAR_TOKEN"));

      const copied = yield* store.apply({
        ops: [
          writeOp(
            syncItemKey("mcpServers", "sentry"),
            contents.replaceAll("linear", "sentry"),
            null,
          ),
        ],
      });
      assert.equal(copied.results[0]?.status, "applied");
      assert.deepEqual(
        (yield* settings.getSettings).mcpServers.map((entry) => entry.id).toSorted(),
        ["linear", "sentry"],
      );
    }),
  ),
);

it.effect("syncs OpenCode's global agents and rules but never its config", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, fs, path } = yield* setup({});
      const xdg = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sync-xdg-" });
      const home = path.join(xdg, "opencode");
      for (const [name, contents] of Object.entries({
        "AGENTS.md": "Global rules",
        "agent/reviewer.md": "# Reviewer",
        "command/ship.md": "# Ship",
        "skills/deploy/SKILL.md": "# Deploy",
        "opencode.json": '{"provider":{"anthropic":{"options":{"apiKey":"sk-secret"}}}}',
        "plugins/hook.ts": "export {}",
      })) {
        yield* fs.makeDirectory(path.dirname(path.join(home, name)), { recursive: true });
        yield* fs.writeFileString(path.join(home, name), contents);
      }
      yield* store.setParticipation({
        enabled: true,
        categories: ["opencode.instructions", "opencode.agents", "opencode.commands"],
        excluded: [],
      });
      const snapshot = yield* store.snapshot.pipe(
        Effect.provideService(HostProcess.Environment, { XDG_CONFIG_HOME: xdg }),
      );
      assert.deepEqual(
        snapshot.items
          .filter((item) => item.categoryId.startsWith("opencode."))
          .map((item) => item.key)
          .toSorted(),
        [
          "opencode.agents:agent/reviewer.md",
          "opencode.commands:command/ship.md",
          "opencode.instructions:AGENTS.md",
          "opencode.skills:skills/deploy/SKILL.md",
        ],
      );

      const refused = yield* store
        .apply({
          ops: [writeOp(syncItemKey("opencode.instructions", "opencode.json"), "{}", null)],
        })
        .pipe(Effect.provideService(HostProcess.Environment, { XDG_CONFIG_HOME: xdg }));
      assert.equal(refused.results[0]?.status, "rejected");
      assert.equal(yield* fs.exists(path.join(home, "opencode.json")), true);
      assert.include(yield* fs.readFileString(path.join(home, "opencode.json")), "sk-secret");
    }),
  ),
);

it.effect("leaves a provider alone when its default instance moves the home", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, settings } = yield* setup({});
      yield* settings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            environment: [{ name: "GROK_HOME", value: "/somewhere/else", sensitive: false }],
          },
        },
      });
      const grok = (yield* store.snapshot).categories.find(
        (category) => category.id === "grok.skills",
      );
      assert.equal(grok?.available, false);
      assert.equal(grok?.unavailableReason, "Grok is not set up on this machine.");
    }),
  ),
);

/** A file category over `home`, on a filesystem where the given operations fail. */
const brokenFileCategory = (
  id: string,
  home: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  broken: { readonly readDirectory?: true; readonly readFile?: true },
) => {
  const denied = (method: string) =>
    Effect.fail(
      PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method }),
    );
  return makeFileCategory({
    spec: FILE_CATEGORIES.find((spec) => spec.id === id)!,
    fs: {
      ...fs,
      readDirectory: ((...args: Parameters<FileSystem.FileSystem["readDirectory"]>) =>
        broken.readDirectory
          ? denied("readDirectory")
          : fs.readDirectory(...args)) as FileSystem.FileSystem["readDirectory"],
      readFile: ((...args: Parameters<FileSystem.FileSystem["readFile"]>) =>
        broken.readFile
          ? denied("readFile")
          : fs.readFile(...args)) as FileSystem.FileSystem["readFile"],
    },
    path,
    home: Effect.succeed(home),
  });
};

// The planner reads an item missing from a snapshot as a deletion, so a scan that cannot see
// everything has to say so instead of returning what it managed to find.
it.effect("reports a category unavailable when its folder cannot be listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, home } = yield* setup({ "agents/reviewer.md": "# Reviewer" });
      const missing = yield* brokenFileCategory("claude.commands", home, fs, path, {}).scan;
      assert.equal(missing.available, true);
      assert.deepEqual(missing.items, []);

      const scan = yield* brokenFileCategory("claude.agents", home, fs, path, {
        readDirectory: true,
      }).scan;
      assert.equal(scan.available, false);
      assert.include(scan.unavailableReason, "Could not read");
    }),
  ),
);

it.effect("reports a category unavailable when it has more files than a scan covers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const files: Record<string, string> = {};
      for (let index = 0; index <= 2_000; index++) files[`agents/a${index}.md`] = "#";
      const { fs, path, home } = yield* setup(files);
      const scan = yield* brokenFileCategory("claude.agents", home, fs, path, {}).scan;
      assert.equal(scan.available, false);
      assert.include(scan.unavailableReason, "Too many files");
    }),
  ),
);

it.effect("reports a category unavailable when a file in it cannot be read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fs, path, home } = yield* setup({ "agents/reviewer.md": "# Reviewer" });
      const category = brokenFileCategory("claude.agents", home, fs, path, { readFile: true });
      const scan = yield* category.scan;
      assert.equal(scan.available, false);
      assert.include(scan.unavailableReason, "Could not read");
      const failure = yield* Effect.flip(category.read("agents/reviewer.md"));
      assert.equal(failure.reason, "io");
    }),
  ),
);

it.effect("never reads a vault it could not open as an empty one", () =>
  Effect.gen(function* () {
    const category = makeVaultCategory({
      isMember: Effect.succeed(true),
      syncEntries: Effect.fail(new VaultError({ reason: "io", message: "storage unreadable" })),
      changes: Stream.empty,
    } as unknown as Parameters<typeof makeVaultCategory>[0]);
    const scan = yield* category.scan;
    assert.equal(scan.available, false);
    assert.deepEqual(scan.items, []);
    const failure = yield* Effect.flip(category.read("API_TOKEN"));
    assert.equal(failure.reason, "io");
  }),
);

it.effect("refuses a synced MCP server whose name another local server already uses", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, settings } = yield* setup({});
      const server = (id: string) => ({
        id,
        name: "linear",
        enabled: true,
        transport: { type: "http" as const, url: "https://mcp.linear.app/mcp" },
        environment: [],
        headers: [],
        toolPolicy: {
          mode: "all" as const,
          tools: [],
          readOnlyClientsMayCall: "readOnlyHint" as const,
        },
      });
      yield* settings.updateSettings({ mcpServers: [server("local")] });
      const contents = (yield* store.read(syncItemKey("mcpServers", "local"))).contents;

      const duplicate = yield* store.apply({
        ops: [
          writeOp(
            syncItemKey("mcpServers", "remote"),
            contents.replace('"local"', '"remote"'),
            null,
          ),
        ],
      });
      assert.equal(duplicate.results[0]?.status, "rejected");
      assert.include(duplicate.results[0]?.message, "linear");

      const update = yield* store.apply({
        ops: [writeOp(syncItemKey("mcpServers", "local"), contents, hashContents(contents))],
      });
      assert.equal(update.results[0]?.status, "applied");
      assert.deepEqual(
        (yield* settings.getSettings).mcpServers.map((entry) => entry.id),
        ["local"],
      );
    }),
  ),
);

it.effect("does not replace a local MCP server that holds a secret value", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { store, settings } = yield* setup({});
      const server = (value: string) => ({
        id: "linear",
        name: "linear",
        enabled: true,
        transport: { type: "http" as const, url: "https://mcp.linear.app/mcp" },
        environment: [],
        headers: [{ name: "Authorization", value, sensitive: true }],
        toolPolicy: {
          mode: "all" as const,
          tools: [],
          readOnlyClientsMayCall: "readOnlyHint" as const,
        },
      });
      yield* settings.updateSettings({ mcpServers: [server("Bearer plain")] });
      // `read` reports the server as absent so its secret never leaves, which must not let a
      // write that expected it to be absent replace it.
      const contents = JSON.stringify(server(vaultReference("LINEAR_TOKEN")));
      const replaced = yield* store.apply({
        ops: [writeOp(syncItemKey("mcpServers", "linear"), contents, null)],
      });
      assert.equal(replaced.results[0]?.status, "rejected");
      assert.equal((yield* settings.getSettings).mcpServers[0]?.headers[0]?.value, "Bearer plain");
    }),
  ),
);
