import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { decryptEntry } from "./vaultCrypto.ts";

/**
 * The vault lives in the secret store, so it gets the same at-rest protection as every other
 * server secret. These helpers carry no service of their own: settings resolve `vault:NAME`
 * references with them without depending on the vault service.
 */
export const VAULT_KEY_SECRET = "vault-key";
export const VAULT_ENTRIES_SECRET = "vault-entries";
export const VAULT_AUDIT_SECRET = "vault-audit";
export const VAULT_KEY_PAIR_SECRET = "vault-x25519-key-pair";

/** Exactly what syncs between environments: metadata in the clear, the value sealed. */
export const StoredVaultEntry = Schema.Struct({
  v: Schema.Literal(1),
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  agentReadable: Schema.Boolean,
  updatedAt: Schema.String,
  iv: Schema.String,
  ciphertext: Schema.String,
  tag: Schema.String,
});
export type StoredVaultEntry = typeof StoredVaultEntry.Type;

const StoredVaultEntries = Schema.Record(Schema.String, StoredVaultEntry);
const StoredVaultEntriesJson = Schema.fromJsonString(StoredVaultEntries);
const decodeEntries = Schema.decodeUnknownEffect(StoredVaultEntriesJson);
const encodeEntries = Schema.encodeEffect(StoredVaultEntriesJson);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

type SecretStore = ServerSecretStore.ServerSecretStore["Service"];

export const readVaultKey = (store: SecretStore) =>
  store.get(VAULT_KEY_SECRET).pipe(Effect.map(Option.filter((key) => key.byteLength === 32)));

export const readVaultEntries = Effect.fn("vaultStorage.readEntries")(function* (
  store: SecretStore,
) {
  const stored = yield* store.get(VAULT_ENTRIES_SECRET);
  if (Option.isNone(stored)) return {} as Record<string, StoredVaultEntry>;
  return yield* decodeEntries(textDecoder.decode(stored.value)).pipe(
    Effect.mapError(
      (cause) => new ServerSecretStore.SecretStoreDecodeError({ resource: "vault entries", cause }),
    ),
  );
});

export const writeVaultEntries = Effect.fn("vaultStorage.writeEntries")(function* (
  store: SecretStore,
  entries: Readonly<Record<string, StoredVaultEntry>>,
) {
  const encoded = yield* encodeEntries(entries).pipe(
    Effect.mapError(
      (cause) => new ServerSecretStore.SecretStoreEncodeError({ resource: "vault entries", cause }),
    ),
  );
  yield* store.set(VAULT_ENTRIES_SECRET, textEncoder.encode(encoded));
});

/**
 * Plaintext for the named entries this environment can open. A name that is missing, or that
 * does not decrypt with this environment's key, is left out for the caller to report.
 */
export const resolveVaultValues = Effect.fn("vaultStorage.resolveValues")(function* (
  store: SecretStore,
  names: Iterable<string>,
) {
  const values = new Map<string, string>();
  const key = yield* readVaultKey(store);
  if (Option.isNone(key)) return values;
  const entries = yield* readVaultEntries(store);
  for (const name of names) {
    const entry = entries[name];
    if (entry === undefined || values.has(name)) continue;
    try {
      values.set(name, decryptEntry(key.value, name, entry));
    } catch {
      // Left unresolved; the caller reports the missing name.
    }
  }
  return values;
});
