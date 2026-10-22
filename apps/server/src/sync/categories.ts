import {
  McpServerConfig,
  type ServerSettings,
  type SyncSkipReason,
  SyncError,
  parseVaultReference,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ServerSettingsModule from "../serverSettings.ts";
import { canonicalJson, sha256Hex } from "../vault/vaultCrypto.ts";
import type * as VaultServiceModule from "../vault/VaultService.ts";
import { readStoredSettings } from "./storedSettings.ts";

export interface ScannedSyncItem {
  readonly name: string;
  readonly hash: string;
  readonly byteLength: number;
  readonly skipped?: SyncSkipReason;
}

export interface CategoryScan {
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly location?: string;
  readonly items: ReadonlyArray<ScannedSyncItem>;
}

/**
 * One kind of thing an environment can share. Every item is text; its hash is the SHA-256 of
 * that text, so the same item hashes the same on every machine.
 */
export interface SyncCategoryProvider {
  readonly id: string;
  readonly label: string;
  readonly scan: Effect.Effect<CategoryScan>;
  /** Null when the item does not exist here. */
  readonly read: (name: string) => Effect.Effect<string | null, SyncError>;
  readonly write: (name: string, contents: string) => Effect.Effect<void, SyncError>;
  readonly remove: (name: string) => Effect.Effect<void, SyncError>;
  /** Fires when items may have changed outside the sync store; only watched while subscribed. */
  readonly changes: Stream.Stream<void>;
}

export const hashContents = (contents: string) => sha256Hex(contents);

export const syncFailure = (reason: SyncError["reason"], message: string) =>
  new SyncError({ reason, message });

const ioFailure = (message: string) => (cause: unknown) =>
  Effect.logWarning(message, { cause }).pipe(
    Effect.andThen(Effect.fail(syncFailure("io", message))),
  );

export function makeVaultCategory(
  vault: VaultServiceModule.VaultService["Service"],
): SyncCategoryProvider {
  const toSyncError = (error: { readonly reason: string; readonly message: string }) =>
    syncFailure(error.reason === "not-member" ? "category-unavailable" : "io", error.message);
  // A vault that cannot be read is not an empty one: an empty scan would delete every secret
  // on the other machines, and a null read would let a write overwrite whatever is there.
  const entries = vault.syncEntries.pipe(Effect.mapError(toSyncError));
  return {
    id: "vault",
    label: "Vault secrets",
    scan: Effect.gen(function* () {
      if (!(yield* vault.isMember)) {
        return {
          available: false,
          unavailableReason: "This machine has not joined the vault.",
          items: [],
        } satisfies CategoryScan;
      }
      return {
        available: true,
        items: (yield* vault.syncEntries).map((entry) => ({
          name: entry.name,
          hash: hashContents(entry.contents),
          byteLength: entry.contents.length,
        })),
      } satisfies CategoryScan;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("The vault could not be read for sync.", { cause }).pipe(
          Effect.as<CategoryScan>({
            available: false,
            unavailableReason: "The vault could not be read.",
            items: [],
          }),
        ),
      ),
    ),
    read: (name) =>
      entries.pipe(Effect.map((all) => all.find((entry) => entry.name === name)?.contents ?? null)),
    write: (name, contents) => vault.syncWrite(name, contents).pipe(Effect.mapError(toSyncError)),
    remove: (name) => vault.syncRemove(name).pipe(Effect.mapError(toSyncError)),
    changes: vault.changes,
  };
}

const decodeServer = Schema.decodeUnknownOption(Schema.fromJsonString(McpServerConfig));
const encodeServer = Schema.encodeSync(McpServerConfig);

type McpServer = ServerSettings["mcpServers"][number];

/** A secret value only syncs as a vault reference; a saved secret stays on its machine. */
const holdsLocalSecret = (server: McpServer) =>
  [...server.environment, ...server.headers].some(
    (variable) =>
      variable.sensitive &&
      parseVaultReference(variable.value) === null &&
      (variable.valueRedacted === true || variable.value.length > 0),
  );

function mcpServerContents(server: McpServer): string {
  const strip = <V extends { readonly valueRedacted?: boolean }>(variables: ReadonlyArray<V>) =>
    variables.map(({ valueRedacted: _omit, ...rest }) => rest);
  const encoded = encodeServer(server);
  return canonicalJson({
    ...encoded,
    environment: strip(encoded.environment ?? []),
    headers: strip(encoded.headers ?? []),
  });
}

export function makeMcpServersCategory(input: {
  readonly fs: FileSystem.FileSystem;
  readonly settingsPath: string;
  readonly settings: ServerSettingsModule.ServerSettingsService["Service"];
}): SyncCategoryProvider {
  const servers = readStoredSettings(input.fs, input.settingsPath).pipe(
    Effect.map((settings) => settings.mcpServers),
  );
  const serversOrFail = servers.pipe(
    Effect.catch(ioFailure("The shared MCP servers could not be read.")),
  );
  const save = (next: ReadonlyArray<McpServer>) =>
    input.settings
      .updateSettings({ mcpServers: next })
      .pipe(Effect.asVoid, Effect.catch(ioFailure("The shared MCP servers could not be saved.")));
  return {
    id: "mcpServers",
    label: "Shared MCP servers",
    scan: servers.pipe(
      Effect.map((list): CategoryScan => ({
        available: true,
        items: list.map((server) => {
          const contents = mcpServerContents(server);
          return {
            name: server.id,
            hash: hashContents(contents),
            byteLength: contents.length,
            ...(holdsLocalSecret(server) ? { skipped: "needs-vault" as const } : {}),
          };
        }),
      })),
      Effect.orElseSucceed((): CategoryScan => ({
        available: false,
        unavailableReason: "Settings could not be read.",
        items: [],
      })),
    ),
    read: (name) =>
      serversOrFail.pipe(
        Effect.map((list) => {
          const server = list.find((candidate) => candidate.id === name);
          return server === undefined || holdsLocalSecret(server)
            ? null
            : mcpServerContents(server);
        }),
      ),
    write: Effect.fn("sync.mcpServers.write")(function* (name: string, contents: string) {
      const decoded = decodeServer(contents);
      if (Option.isNone(decoded) || decoded.value.id !== name) {
        return yield* syncFailure("not-allowed", `The synced MCP server ${name} is malformed.`);
      }
      if (holdsLocalSecret(decoded.value)) {
        return yield* syncFailure(
          "not-allowed",
          `${decoded.value.name} carries a secret value; only vault references sync.`,
        );
      }
      const list = yield* serversOrFail;
      // The gateway resolves a server by name and takes the first match.
      if (list.some((server) => server.id !== name && server.name === decoded.value.name)) {
        return yield* syncFailure(
          "not-allowed",
          `Another MCP server here is already named ${decoded.value.name}.`,
        );
      }
      // `read` reports a server holding a local secret as absent, so an op that expected it to
      // be absent has to be refused here or it would replace the secret.
      const existing = list.find((server) => server.id === name);
      if (existing !== undefined && holdsLocalSecret(existing)) {
        return yield* syncFailure(
          "not-allowed",
          `${existing.name} holds a secret value here and is not replaced by sync.`,
        );
      }
      const exists = existing !== undefined;
      yield* save(
        exists
          ? list.map((server) => (server.id === name ? decoded.value : server))
          : [...list, decoded.value],
      );
    }),
    remove: (name) =>
      serversOrFail.pipe(
        Effect.flatMap((list) =>
          list.some((server) => server.id === name)
            ? save(list.filter((server) => server.id !== name))
            : Effect.void,
        ),
      ),
    changes: input.settings.streamChanges.pipe(Stream.map(() => undefined)),
  };
}
