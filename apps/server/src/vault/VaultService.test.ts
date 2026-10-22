import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  vaultReference,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as VaultService from "./VaultService.ts";

const machineLayer = (environmentId: string) =>
  VaultService.layer.pipe(
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
      }),
    ),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: `t3-vault-test-${environmentId}-` }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const machine = (environmentId: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(machineLayer(environmentId));
    return {
      vault: Context.get(context, VaultService.VaultService),
      settings: Context.get(context, ServerSettingsModule.ServerSettingsService),
      clientSettings: Context.get(context, ServerSettingsModule.ServerSettingsClientView),
      config: Context.get(context, ServerConfig.ServerConfig),
      fs: Context.get(context, FileSystem.FileSystem),
    };
  });

const CLAUDE = ProviderInstanceId.make("claudeAgent");

const withTokenVariable = (value: string, sensitive = true) => ({
  providerInstances: {
    [CLAUDE]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      environment: [{ name: "API_TOKEN", value, sensitive }],
    },
  },
});

it.effect("keeps secret values out of everything a client can list", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { vault } = yield* machine("env-a");
      yield* vault.mutate({ _tag: "create" });
      const listed = yield* vault.mutate({
        _tag: "set",
        name: "API_TOKEN",
        value: "super-secret-value",
        description: "CI token",
      });
      assert.deepEqual(
        listed.entries.map((entry) => [entry.name, entry.description, entry.agentReadable]),
        [["API_TOKEN", "CI token", false]],
      );
      assert.isTrue(listed.status.member);
      assert.notInclude(JSON.stringify(listed), "super-secret-value");
      const synced = yield* vault.syncEntries;
      assert.notInclude(JSON.stringify(synced), "super-secret-value");
    }),
  ),
);

it.effect("resolves a vault reference on the server and shows clients only the reference", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { vault, settings, clientSettings } = yield* machine("env-a");
      yield* vault.mutate({ _tag: "create" });
      yield* vault.mutate({ _tag: "set", name: "API_TOKEN", value: "resolved-value" });
      yield* settings.updateSettings(withTokenVariable(vaultReference("API_TOKEN")));

      const resolved = yield* settings.getSettings;
      assert.deepEqual(
        resolved.providerInstances[CLAUDE]?.environment?.[0]?.value,
        "resolved-value",
      );
      const forClient = yield* clientSettings.getSettings;
      assert.notInclude(JSON.stringify(forClient), "resolved-value");
      assert.equal(
        forClient.providerInstances[CLAUDE]?.environment?.[0]?.value,
        vaultReference("API_TOKEN"),
      );

      // A client saving the reference back keeps it a reference, not a stored copy.
      yield* settings.updateSettings({ providerInstances: forClient.providerInstances });
      assert.equal(
        (yield* clientSettings.getSettings).providerInstances[CLAUDE]?.environment?.[0]?.value,
        vaultReference("API_TOKEN"),
      );
    }),
  ),
);

it.effect("leaves a reference to a missing secret empty instead of failing settings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { settings } = yield* machine("env-a");
      yield* settings.updateSettings(withTokenVariable(vaultReference("NOT_THERE")));
      const resolved = yield* settings.getSettings;
      assert.equal(resolved.providerInstances[CLAUDE]?.environment?.[0]?.value, "");
    }),
  ),
);

it.effect("shares the vault key only with the machine that signed for it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine("env-a");
      const b = yield* machine("env-b");
      yield* a.vault.mutate({ _tag: "create" });
      yield* a.vault.mutate({ _tag: "set", name: "API_TOKEN", value: "shared" });

      const recipient = (yield* b.vault.status).recipient;
      const forged = yield* a.vault
        .wrapKeyFor({ ...recipient, environmentId: EnvironmentId.make("env-c") })
        .pipe(Effect.flip);
      assert.equal(forged.reason, "key-mismatch");

      const wrapped = yield* a.vault.wrapKeyFor(recipient);
      const joined = yield* b.vault.mutate({ _tag: "acceptKey", wrapped });
      assert.isTrue(joined.status.member);
      assert.equal(joined.status.vaultFingerprint, (yield* a.vault.status).vaultFingerprint);

      // The entry travels as ciphertext and opens on the joined machine.
      for (const entry of yield* a.vault.syncEntries) {
        yield* b.vault.syncWrite(entry.name, entry.contents);
      }
      yield* b.vault.mutate({ _tag: "setAgentReadable", name: "API_TOKEN", agentReadable: true });
      assert.equal(yield* b.vault.readForAgent("API_TOKEN", {}, true), "shared");
    }),
  ),
);

it.effect("refuses an entry sealed by a different vault", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const a = yield* machine("env-a");
      const c = yield* machine("env-c");
      yield* a.vault.mutate({ _tag: "create" });
      yield* c.vault.mutate({ _tag: "create" });
      yield* a.vault.mutate({ _tag: "set", name: "API_TOKEN", value: "from-a" });
      const [entry] = yield* a.vault.syncEntries;
      const refused = yield* c.vault.syncWrite("API_TOKEN", entry!.contents).pipe(Effect.flip);
      assert.equal(refused.reason, "key-mismatch");
    }),
  ),
);

it.effect("lets agents read only opted-in secrets from trusted threads and records each try", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { vault } = yield* machine("env-a");
      yield* vault.mutate({ _tag: "create" });
      yield* vault.mutate({ _tag: "set", name: "API_TOKEN", value: "v" });

      const refused = yield* vault.readForAgent("API_TOKEN", {}, true).pipe(Effect.flip);
      assert.equal(refused.reason, "not-allowed");
      yield* vault.mutate({ _tag: "setAgentReadable", name: "API_TOKEN", agentReadable: true });
      const denied = yield* vault.readForAgent("API_TOKEN", {}, false).pipe(Effect.flip);
      assert.equal(denied.reason, "not-allowed");
      assert.equal(yield* vault.readForAgent("API_TOKEN", {}, true), "v");

      const { audit } = yield* vault.list;
      assert.deepEqual(
        audit.map((entry) => entry.outcome),
        ["read", "denied", "refused"],
      );
    }),
  ),
);

it.effect("moves a saved provider secret into the vault and leaves a reference behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { vault, settings, fs, config } = yield* machine("env-a");
      yield* settings.updateSettings(withTokenVariable("plain-saved-secret"));
      yield* vault.mutate({ _tag: "create" });

      const { candidates } = yield* vault.importCandidates;
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.suggestedName, "API_TOKEN");

      yield* vault.mutate({
        _tag: "import",
        items: [{ id: candidates[0]!.id, name: "CLAUDE_TOKEN" }],
      });
      const onDisk = yield* fs.readFileString(config.settingsPath);
      assert.include(onDisk, vaultReference("CLAUDE_TOKEN"));
      assert.notInclude(onDisk, "plain-saved-secret");
      const resolved = yield* settings.getSettings;
      assert.equal(
        resolved.providerInstances[CLAUDE]?.environment?.[0]?.value,
        "plain-saved-secret",
      );
      assert.deepEqual((yield* vault.importCandidates).candidates, []);
    }),
  ),
);

it.effect("deletes the key and every secret when a machine leaves", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { vault } = yield* machine("env-a");
      yield* vault.mutate({ _tag: "create" });
      yield* vault.mutate({ _tag: "set", name: "API_TOKEN", value: "v" });
      const left = yield* vault.mutate({ _tag: "leave" });
      assert.isFalse(left.status.member);
      assert.deepEqual(left.entries, []);
    }),
  ),
);
