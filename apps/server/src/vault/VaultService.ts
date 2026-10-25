import {
  parseVaultReference,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ServerSettings,
  type ThreadId,
  type VaultAuditEntry,
  VaultAuditEntry as VaultAuditEntrySchema,
  type VaultEntry,
  VaultError,
  type VaultImportCandidate,
  type VaultImportCandidates,
  type VaultImportInput,
  type VaultImportResult,
  type VaultListResult,
  type VaultMutation,
  type VaultRecipient,
  type VaultSetAgentReadableInput,
  type VaultSetInput,
  type VaultStatus,
  type VaultWrappedKey,
  vaultReference,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { mcpServerSecretName, providerEnvironmentSecretName } from "../settingsSecrets.ts";
import { readStoredSettings } from "../sync/storedSettings.ts";
import {
  canonicalJson,
  decryptEntry,
  encryptEntry,
  generateVaultKey,
  generateX25519KeyPair,
  recipientFingerprint,
  signRecipient,
  unwrapVaultKey,
  vaultKeyFingerprint,
  verifyRecipient,
  wrapVaultKey,
  type X25519KeyPair,
} from "./vaultCrypto.ts";
import {
  readVaultEntries,
  readVaultKey,
  StoredVaultEntry,
  VAULT_AUDIT_SECRET,
  VAULT_ENTRIES_SECRET,
  VAULT_KEY_PAIR_SECRET,
  VAULT_KEY_SECRET,
  writeVaultEntries,
} from "./vaultStorage.ts";

export interface VaultAgentCaller {
  readonly threadId?: ThreadId;
  readonly providerInstanceId?: string;
}

export interface VaultSyncEntry {
  readonly name: string;
  readonly contents: string;
}

export class VaultService extends Context.Service<
  VaultService,
  {
    readonly status: Effect.Effect<VaultStatus, VaultError>;
    readonly list: Effect.Effect<VaultListResult, VaultError>;
    readonly create: Effect.Effect<VaultStatus, VaultError>;
    readonly set: (input: VaultSetInput) => Effect.Effect<void, VaultError>;
    readonly remove: (name: string) => Effect.Effect<void, VaultError>;
    readonly setAgentReadable: (
      input: VaultSetAgentReadableInput,
    ) => Effect.Effect<void, VaultError>;
    readonly wrapKeyFor: (recipient: VaultRecipient) => Effect.Effect<VaultWrappedKey, VaultError>;
    readonly acceptKey: (wrapped: VaultWrappedKey) => Effect.Effect<VaultStatus, VaultError>;
    readonly leave: Effect.Effect<VaultStatus, VaultError>;
    readonly importCandidates: Effect.Effect<VaultImportCandidates, VaultError>;
    readonly importSecrets: (
      input: VaultImportInput,
    ) => Effect.Effect<VaultImportResult, VaultError>;
    /**
     * Plaintext for an agent, only for an entry marked agent-readable and only when the caller's
     * thread may read it. Every attempt is recorded.
     */
    /** Applies one mutation and returns the vault as it stands after it. */
    readonly mutate: (mutation: VaultMutation) => Effect.Effect<VaultListResult, VaultError>;
    readonly readForAgent: (
      name: string,
      caller: VaultAgentCaller,
      allowed: boolean,
    ) => Effect.Effect<string, VaultError>;
    readonly isMember: Effect.Effect<boolean, VaultError>;
    /** Entries exactly as they sync: metadata in the clear, the value sealed with the vault key. */
    readonly syncEntries: Effect.Effect<ReadonlyArray<VaultSyncEntry>, VaultError>;
    readonly syncWrite: (name: string, contents: string) => Effect.Effect<void, VaultError>;
    readonly syncRemove: (name: string) => Effect.Effect<void, VaultError>;
    readonly changes: Stream.Stream<void>;
  }
>()("t3/vault/VaultService") {}

const AUDIT_LIMIT = 200;

const KeyPair = Schema.Struct({ privateKey: Schema.String, publicKey: Schema.String });
const KeyPairJson = Schema.fromJsonString(KeyPair);
const decodeKeyPair = Schema.decodeUnknownOption(KeyPairJson);
const encodeKeyPair = Schema.encodeSync(KeyPairJson);

const AuditEntries = Schema.Array(VaultAuditEntrySchema);
const AuditJson = Schema.fromJsonString(AuditEntries);
const decodeAudit = Schema.decodeUnknownOption(AuditJson);
const encodeAudit = Schema.encodeSync(AuditJson);
const decodeStoredEntry = Schema.decodeUnknownOption(Schema.fromJsonString(StoredVaultEntry));

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const vaultError = (reason: VaultError["reason"], message: string) =>
  new VaultError({ reason, message });
const ioError = (cause: unknown) =>
  Effect.logWarning("vault storage failed", { cause }).pipe(
    Effect.andThen(Effect.fail(vaultError("io", "The vault could not be read or written."))),
  );
const notMember = () =>
  vaultError("not-member", "This machine does not hold the vault. Create one or join it first.");

const suggestedSecretName = (name: string) => {
  const upper = name.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return /^[A-Z_]/.test(upper) ? upper : `_${upper}`;
};

interface ImportSource extends VaultImportCandidate {
  readonly redacted: boolean;
  readonly inlineValue: string;
  readonly rewrite: (settings: ServerSettings, reference: string) => ServerSettings;
}

function importSources(settings: ServerSettings): ReadonlyArray<ImportSource> {
  const sources: ImportSource[] = [];
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    for (const variable of instance.environment ?? []) {
      if (!variable.sensitive || parseVaultReference(variable.value) !== null) continue;
      if (variable.valueRedacted !== true && variable.value.length === 0) continue;
      sources.push({
        id: providerEnvironmentSecretName(instanceId, variable.name),
        label: `${instance.displayName ?? instanceId} · ${variable.name}`,
        suggestedName: suggestedSecretName(variable.name),
        redacted: variable.valueRedacted === true,
        inlineValue: variable.value,
        rewrite: (current, reference) => {
          const target = current.providerInstances[ProviderInstanceId.make(instanceId)];
          if (target === undefined) return current;
          const next: ProviderInstanceConfig = {
            ...target,
            environment: (target.environment ?? []).map((entry) =>
              entry.name === variable.name
                ? { name: entry.name, sensitive: true, value: reference }
                : entry,
            ),
          };
          return {
            ...current,
            providerInstances: {
              ...current.providerInstances,
              [ProviderInstanceId.make(instanceId)]: next,
            },
          };
        },
      });
    }
  }
  for (const server of settings.mcpServers) {
    for (const [kind, variables] of [
      ["env", server.environment],
      ["header", server.headers],
    ] as const) {
      for (const variable of variables) {
        if (!variable.sensitive || parseVaultReference(variable.value) !== null) continue;
        if (variable.valueRedacted !== true && variable.value.length === 0) continue;
        sources.push({
          id: mcpServerSecretName(server.id, kind, variable.name),
          label: `${server.name} · ${kind === "env" ? "" : "header "}${variable.name}`,
          suggestedName: suggestedSecretName(`${server.name}_${variable.name}`),
          redacted: variable.valueRedacted === true,
          inlineValue: variable.value,
          rewrite: (current, reference) => ({
            ...current,
            mcpServers: current.mcpServers.map((candidate) => {
              if (candidate.id !== server.id) return candidate;
              const swap = <V extends { readonly name: string }>(entries: ReadonlyArray<V>) =>
                entries.map((entry) =>
                  entry.name === variable.name
                    ? { name: entry.name, sensitive: true, value: reference }
                    : entry,
                );
              return kind === "env"
                ? { ...candidate, environment: swap(candidate.environment) }
                : { ...candidate, headers: swap(candidate.headers) };
            }),
          }),
        });
      }
    }
  }
  return sources;
}

/** @public */
export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const settings = yield* ServerSettingsModule.ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  const changed = yield* PubSub.unbounded<void>();
  const fs = yield* FileSystem.FileSystem;
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const storedSettings = readStoredSettings(fs, settingsPath);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const publish = PubSub.publish(changed, undefined).pipe(Effect.asVoid);
  const exclusive = lock.withPermits(1);

  const keyPair = Effect.gen(function* () {
    const stored = yield* store.get(VAULT_KEY_PAIR_SECRET);
    if (Option.isSome(stored)) {
      const decoded = decodeKeyPair(textDecoder.decode(stored.value));
      if (Option.isSome(decoded)) return decoded.value as X25519KeyPair;
    }
    const generated = generateX25519KeyPair();
    yield* store.set(VAULT_KEY_PAIR_SECRET, textEncoder.encode(encodeKeyPair(generated)));
    return generated;
  }).pipe(Effect.catch(ioError));

  const vaultKey = readVaultKey(store).pipe(Effect.catch(ioError));
  const requireKey = vaultKey.pipe(
    Effect.flatMap(
      Option.match({ onNone: () => Effect.fail(notMember()), onSome: Effect.succeed }),
    ),
  );
  const entries = readVaultEntries(store).pipe(Effect.catch(ioError));
  const saveEntries = (next: Readonly<Record<string, StoredVaultEntry>>) =>
    writeVaultEntries(store, next).pipe(Effect.catch(ioError));

  const audit = store.get(VAULT_AUDIT_SECRET).pipe(
    Effect.map((stored) =>
      Option.isNone(stored)
        ? []
        : Option.getOrElse(decodeAudit(textDecoder.decode(stored.value)), () => []),
    ),
    Effect.catch(ioError),
  );
  const recordAudit = (entry: VaultAuditEntry) =>
    exclusive(
      audit.pipe(
        Effect.flatMap((current) =>
          store.set(
            VAULT_AUDIT_SECRET,
            textEncoder.encode(encodeAudit([...current, entry].slice(-AUDIT_LIMIT))),
          ),
        ),
        Effect.catch(ioError),
      ),
    );

  const recipient = Effect.gen(function* () {
    const pair = yield* keyPair;
    const environmentId = yield* environment.getEnvironmentId;
    const signing = yield* getOrCreateEnvironmentKeyPairFromSecretStore(store).pipe(
      Effect.catch(ioError),
    );
    return {
      environmentId,
      publicKey: pair.publicKey,
      signingPublicKey: signing.publicKey,
      signature: signRecipient(environmentId, pair.publicKey, signing.privateKey),
      fingerprint: recipientFingerprint(pair.publicKey),
    } satisfies VaultRecipient;
  });

  const status = Effect.gen(function* () {
    const key = yield* vaultKey;
    return {
      member: Option.isSome(key),
      recipient: yield* recipient,
      ...(Option.isSome(key) ? { vaultFingerprint: vaultKeyFingerprint(key.value) } : {}),
    } satisfies VaultStatus;
  }).pipe(Effect.withSpan("VaultService.status"));

  const toEntry = (stored: StoredVaultEntry): VaultEntry => ({
    name: stored.name,
    agentReadable: stored.agentReadable,
    updatedAt: stored.updatedAt,
    ...(stored.description === undefined ? {} : { description: stored.description }),
  });

  const list = Effect.gen(function* () {
    const current = yield* entries;
    return {
      status: yield* status,
      entries: Object.values(current)
        .map(toEntry)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
      audit: (yield* audit).toReversed().slice(0, 50),
    } satisfies VaultListResult;
  }).pipe(Effect.withSpan("VaultService.list"));

  const create = exclusive(
    Effect.gen(function* () {
      if (Option.isSome(yield* vaultKey)) {
        return yield* vaultError("already-member", "This machine already holds a vault.");
      }
      yield* store.create(VAULT_KEY_SECRET, generateVaultKey()).pipe(Effect.catch(ioError));
      return yield* status;
    }),
  ).pipe(
    Effect.tap(() => publish),
    Effect.withSpan("VaultService.create"),
  );

  const writeEntry = (
    name: string,
    update: (current: StoredVaultEntry | undefined) => Effect.Effect<StoredVaultEntry, VaultError>,
  ) =>
    exclusive(
      Effect.gen(function* () {
        const current = yield* entries;
        const next = yield* update(current[name]);
        yield* saveEntries({ ...current, [name]: next });
      }),
    ).pipe(Effect.tap(() => publish));

  const set = Effect.fn("VaultService.set")(function* (input: VaultSetInput) {
    const key = yield* requireKey;
    const updatedAt = yield* now;
    yield* writeEntry(input.name, (existing) => {
      if (input.value === undefined && existing === undefined) {
        return Effect.fail(vaultError("not-found", `No secret named ${input.name}.`));
      }
      const sealed =
        input.value === undefined ? existing! : encryptEntry(key, input.name, input.value);
      const description = input.description ?? existing?.description;
      return Effect.succeed({
        v: 1 as const,
        name: input.name,
        agentReadable: existing?.agentReadable ?? false,
        updatedAt,
        iv: sealed.iv,
        ciphertext: sealed.ciphertext,
        tag: sealed.tag,
        ...(description === undefined || description.length === 0 ? {} : { description }),
      });
    });
  });

  const remove = Effect.fn("VaultService.remove")(function* (name: string) {
    yield* requireKey;
    yield* exclusive(
      Effect.gen(function* () {
        const current = yield* entries;
        if (current[name] === undefined) {
          return yield* vaultError("not-found", `No secret named ${name}.`);
        }
        const { [name]: _removed, ...rest } = current;
        yield* saveEntries(rest);
      }),
    );
    yield* publish;
  });

  const setAgentReadable = Effect.fn("VaultService.setAgentReadable")(function* (
    input: VaultSetAgentReadableInput,
  ) {
    yield* requireKey;
    const updatedAt = yield* now;
    yield* writeEntry(input.name, (existing) =>
      existing === undefined
        ? Effect.fail(vaultError("not-found", `No secret named ${input.name}.`))
        : Effect.succeed({ ...existing, agentReadable: input.agentReadable, updatedAt }),
    );
  });

  const wrapKeyFor = Effect.fn("VaultService.wrapKeyFor")(function* (target: VaultRecipient) {
    const key = yield* requireKey;
    if (!verifyRecipient(target) || recipientFingerprint(target.publicKey) !== target.fingerprint) {
      return yield* vaultError(
        "key-mismatch",
        "The other machine's vault key is not signed by that machine. Nothing was shared.",
      );
    }
    const wrapped = wrapVaultKey(key, target.publicKey);
    return {
      ...wrapped,
      recipientFingerprint: target.fingerprint,
      vaultFingerprint: vaultKeyFingerprint(key),
    } satisfies VaultWrappedKey;
  });

  const acceptKey = Effect.fn("VaultService.acceptKey")(function* (wrapped: VaultWrappedKey) {
    const pair = yield* keyPair;
    if (wrapped.recipientFingerprint !== recipientFingerprint(pair.publicKey)) {
      return yield* vaultError("key-mismatch", "This vault key was shared with another machine.");
    }
    const existing = yield* vaultKey;
    if (Option.isSome(existing)) {
      if (vaultKeyFingerprint(existing.value) === wrapped.vaultFingerprint) return yield* status;
      return yield* vaultError(
        "already-member",
        "This machine already holds a different vault. Leave it before joining another.",
      );
    }
    const key = yield* Effect.try({
      try: () => unwrapVaultKey(wrapped, pair),
      catch: () => vaultError("key-mismatch", "The shared vault key could not be opened here."),
    });
    if (vaultKeyFingerprint(key) !== wrapped.vaultFingerprint) {
      return yield* vaultError("key-mismatch", "The shared vault key does not match its vault.");
    }
    yield* exclusive(store.set(VAULT_KEY_SECRET, key).pipe(Effect.catch(ioError)));
    yield* publish;
    return yield* status;
  });

  const leave = exclusive(
    Effect.gen(function* () {
      yield* store.remove(VAULT_ENTRIES_SECRET).pipe(Effect.catch(ioError));
      yield* store.remove(VAULT_KEY_SECRET).pipe(Effect.catch(ioError));
    }),
  ).pipe(
    Effect.tap(() => publish),
    Effect.andThen(status),
    Effect.withSpan("VaultService.leave"),
  );

  const storedSettingsOrFail = storedSettings.pipe(Effect.catch((cause) => ioError(cause)));

  const importCandidates = storedSettingsOrFail.pipe(
    Effect.map((current) => ({
      candidates: importSources(current).map(({ id, label, suggestedName }) => ({
        id,
        label,
        suggestedName,
      })),
    })),
    Effect.withSpan("VaultService.importCandidates"),
  );

  // Copy, then rewrite, then delete: the old secret is only dropped by the settings write that
  // replaces it with a reference, and that write rolls back on failure.
  const importSecrets = Effect.fn("VaultService.importSecrets")(function* (
    input: VaultImportInput,
  ) {
    const key = yield* requireKey;
    const current = yield* storedSettingsOrFail;
    const sources = new Map(importSources(current).map((source) => [source.id, source]));
    const values = new Map<string, string>();
    for (const item of input.items) {
      const source = sources.get(item.id);
      if (source === undefined) {
        return yield* vaultError("not-found", "A selected secret is no longer in settings.");
      }
      const value = source.redacted
        ? yield* store
            .get(source.id)
            .pipe(
              Effect.map(
                Option.match({ onNone: () => "", onSome: (bytes) => textDecoder.decode(bytes) }),
              ),
              Effect.catch(ioError),
            )
        : source.inlineValue;
      if (value.length === 0) {
        return yield* vaultError("invalid", `${source.label} has no saved value to import.`);
      }
      const previous = values.get(item.name);
      if (previous !== undefined && previous !== value) {
        return yield* vaultError(
          "conflict",
          `Two different values would both be saved as ${item.name}. Choose different names.`,
        );
      }
      values.set(item.name, value);
    }
    const updatedAt = yield* now;
    const added: string[] = [];
    yield* exclusive(
      Effect.gen(function* () {
        const stored = yield* entries;
        const next = { ...stored };
        for (const [name, value] of values) {
          const existing = stored[name];
          if (existing !== undefined) {
            const same = yield* Effect.try({
              try: () => decryptEntry(key, name, existing) === value,
              catch: () => false,
            }).pipe(Effect.orElseSucceed(() => false));
            if (!same) {
              return yield* vaultError(
                "conflict",
                `The vault already has a different ${name}. Choose another name.`,
              );
            }
            continue;
          }
          const sealed = encryptEntry(key, name, value);
          next[name] = { v: 1, name, agentReadable: false, updatedAt, ...sealed };
          added.push(name);
        }
        yield* saveEntries(next);
      }),
    );
    let rewritten = current;
    for (const item of input.items) {
      rewritten = sources.get(item.id)!.rewrite(rewritten, vaultReference(item.name));
    }
    yield* settings
      .updateSettings({
        providerInstances: rewritten.providerInstances,
        mcpServers: rewritten.mcpServers,
      })
      .pipe(
        Effect.catch((cause) =>
          exclusive(
            entries.pipe(
              Effect.flatMap((stored) =>
                saveEntries(
                  Object.fromEntries(
                    Object.entries(stored).filter(([name]) => !added.includes(name)),
                  ),
                ),
              ),
            ),
          ).pipe(Effect.andThen(ioError(cause))),
        ),
      );
    yield* publish;
    return { imported: [...values.keys()] } satisfies VaultImportResult;
  });

  const readForAgent = Effect.fn("VaultService.readForAgent")(function* (
    name: string,
    caller: VaultAgentCaller,
    allowed: boolean,
  ) {
    const key = yield* requireKey;
    const entry = (yield* entries)[name];
    if (entry === undefined) return yield* vaultError("not-found", `No secret named ${name}.`);
    const at = yield* now;
    const record = (outcome: VaultAuditEntry["outcome"]) =>
      recordAudit({
        name: entry.name,
        at,
        outcome,
        ...(caller.threadId === undefined ? {} : { threadId: caller.threadId }),
        ...(caller.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: caller.providerInstanceId }),
      } as VaultAuditEntry);
    if (!entry.agentReadable) {
      yield* record("refused");
      return yield* vaultError(
        "not-allowed",
        `${name} is not readable by agents. Ask the user to turn on "Agents may read" for it in Settings → Vault, or use it by reference as ${vaultReference(name)}.`,
      );
    }
    if (!allowed) {
      yield* record("denied");
      return yield* vaultError(
        "not-allowed",
        `Reading ${name} needs a full-access thread. Use it by reference as ${vaultReference(name)} instead, or ask the user to run this thread with full access.`,
      );
    }
    const value = yield* Effect.try({
      try: () => decryptEntry(key, name, entry),
      catch: () =>
        vaultError("key-mismatch", `${name} cannot be opened with this machine's vault key.`),
    });
    yield* record("read");
    return value;
  });

  const syncEntries = Effect.gen(function* () {
    if (Option.isNone(yield* vaultKey)) return [];
    return Object.values(yield* entries).map((entry) => ({
      name: entry.name,
      contents: canonicalJson(entry),
    }));
  });

  const syncWrite = Effect.fn("VaultService.syncWrite")(function* (name: string, contents: string) {
    const key = yield* requireKey;
    const decoded = decodeStoredEntry(contents);
    if (Option.isNone(decoded) || decoded.value.name !== name) {
      return yield* vaultError("invalid", `The synced secret ${name} is malformed.`);
    }
    const entry = decoded.value;
    yield* Effect.try({
      try: () => decryptEntry(key, name, entry),
      catch: () =>
        vaultError("key-mismatch", `${name} was sealed with a different vault key; not accepted.`),
    });
    yield* writeEntry(name, () => Effect.succeed(entry));
  });

  const syncRemove = Effect.fn("VaultService.syncRemove")(function* (name: string) {
    yield* requireKey;
    yield* exclusive(
      entries.pipe(
        Effect.flatMap((current) => {
          if (current[name] === undefined) return Effect.void;
          const { [name]: _removed, ...rest } = current;
          return saveEntries(rest);
        }),
      ),
    );
    yield* publish;
  });

  const mutate = Effect.fn("VaultService.mutate")(function* (mutation: VaultMutation) {
    switch (mutation._tag) {
      case "create":
        yield* create;
        break;
      case "set":
        yield* set(mutation);
        break;
      case "delete":
        yield* remove(mutation.name);
        break;
      case "setAgentReadable":
        yield* setAgentReadable(mutation);
        break;
      case "acceptKey":
        yield* acceptKey(mutation.wrapped);
        break;
      case "leave":
        yield* leave;
        break;
      case "import":
        yield* importSecrets(mutation);
        break;
    }
    return yield* list;
  });

  return VaultService.of({
    mutate,
    status,
    list,
    create,
    set,
    remove,
    setAgentReadable,
    wrapKeyFor,
    acceptKey,
    leave,
    importCandidates,
    importSecrets,
    readForAgent,
    isMember: vaultKey.pipe(Effect.map(Option.isSome)),
    syncEntries,
    syncWrite,
    syncRemove,
    get changes() {
      return Stream.fromPubSub(changed);
    },
  });
});

export const layer = Layer.effect(VaultService, make);
