import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Names look like environment variables, so a reference reads the same in an env var list. */
export const VaultSecretName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
);
export type VaultSecretName = typeof VaultSecretName.Type;

const VAULT_REFERENCE_PREFIX = "vault:";
const VAULT_REFERENCE_PATTERN = /^vault:([A-Za-z_][A-Za-z0-9_]{0,127})$/;

/** The secret name a `vault:NAME` value refers to, or null for any other value. */
export function parseVaultReference(value: string): string | null {
  return VAULT_REFERENCE_PATTERN.exec(value.trim())?.[1] ?? null;
}

export function vaultReference(name: string): string {
  return `${VAULT_REFERENCE_PREFIX}${name}`;
}

/** Metadata only; a secret's value never leaves the server that holds it. */
export const VaultEntry = Schema.Struct({
  name: VaultSecretName,
  description: Schema.optionalKey(Schema.String),
  agentReadable: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type VaultEntry = typeof VaultEntry.Type;

export const VaultAuditEntry = Schema.Struct({
  name: VaultSecretName,
  at: IsoDateTime,
  outcome: Schema.Literals(["read", "denied", "refused"]),
  threadId: Schema.optionalKey(ThreadId),
  providerInstanceId: Schema.optionalKey(Schema.String),
});
export type VaultAuditEntry = typeof VaultAuditEntry.Type;

/**
 * An environment's vault public key, signed by its environment signing key so a member can
 * check the key it wraps for belongs to the environment that presented it.
 */
export const VaultRecipient = Schema.Struct({
  environmentId: EnvironmentId,
  publicKey: TrimmedNonEmptyString,
  signingPublicKey: TrimmedNonEmptyString,
  signature: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
});
export type VaultRecipient = typeof VaultRecipient.Type;

export const VaultStatus = Schema.Struct({
  member: Schema.Boolean,
  recipient: VaultRecipient,
  /** Same on every member; shown so a person can tell two vaults apart. */
  vaultFingerprint: Schema.optionalKey(Schema.String),
});
export type VaultStatus = typeof VaultStatus.Type;

export const VaultListResult = Schema.Struct({
  status: VaultStatus,
  entries: Schema.Array(VaultEntry),
  audit: Schema.Array(VaultAuditEntry),
});
export type VaultListResult = typeof VaultListResult.Type;

export const VaultSetInput = Schema.Struct({
  name: VaultSecretName,
  /** Omitted to change only the description. */
  value: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64 * 1024))),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type VaultSetInput = typeof VaultSetInput.Type;

export const VaultNameInput = Schema.Struct({ name: VaultSecretName });
export type VaultNameInput = typeof VaultNameInput.Type;

export const VaultSetAgentReadableInput = Schema.Struct({
  name: VaultSecretName,
  agentReadable: Schema.Boolean,
});
export type VaultSetAgentReadableInput = typeof VaultSetAgentReadableInput.Type;

export const VaultWrappedKey = Schema.Struct({
  recipientFingerprint: TrimmedNonEmptyString,
  ephemeralPublicKey: TrimmedNonEmptyString,
  iv: TrimmedNonEmptyString,
  ciphertext: TrimmedNonEmptyString,
  tag: TrimmedNonEmptyString,
  vaultFingerprint: TrimmedNonEmptyString,
});
export type VaultWrappedKey = typeof VaultWrappedKey.Type;

export const VaultWrapKeyInput = Schema.Struct({ recipient: VaultRecipient });
export type VaultWrapKeyInput = typeof VaultWrapKeyInput.Type;

export const VaultAcceptKeyInput = Schema.Struct({ wrapped: VaultWrappedKey });
export type VaultAcceptKeyInput = typeof VaultAcceptKeyInput.Type;

/** A secret already stored in this environment's settings that can move into the vault. */
export const VaultImportCandidate = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: Schema.String,
  suggestedName: Schema.String,
});
export type VaultImportCandidate = typeof VaultImportCandidate.Type;

export const VaultImportCandidates = Schema.Struct({
  candidates: Schema.Array(VaultImportCandidate),
});
export type VaultImportCandidates = typeof VaultImportCandidates.Type;

export const VaultImportInput = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, name: VaultSecretName })).check(
    Schema.isMaxLength(200),
  ),
});
export type VaultImportInput = typeof VaultImportInput.Type;

export const VaultImportResult = Schema.Struct({
  imported: Schema.Array(VaultSecretName),
});
export type VaultImportResult = typeof VaultImportResult.Type;

export const VaultMutation = Schema.Union([
  /** Starts a vault on this machine; the first machine to sync secrets does this once. */
  Schema.TaggedStruct("create", {}),
  Schema.TaggedStruct("set", VaultSetInput.fields),
  Schema.TaggedStruct("delete", VaultNameInput.fields),
  Schema.TaggedStruct("setAgentReadable", VaultSetAgentReadableInput.fields),
  Schema.TaggedStruct("acceptKey", VaultAcceptKeyInput.fields),
  /** Deletes the vault key and every secret on this machine. */
  Schema.TaggedStruct("leave", {}),
  Schema.TaggedStruct("import", VaultImportInput.fields),
]);
export type VaultMutation = typeof VaultMutation.Type;

/** Holding the vault key opens every secret, so handing it out is an owner decision. */
export function vaultMutationNeedsOwner(mutation: Pick<VaultMutation, "_tag">): boolean {
  return mutation._tag === "create" || mutation._tag === "acceptKey" || mutation._tag === "leave";
}

export const VaultErrorReason = Schema.Literals([
  "not-member",
  "already-member",
  "not-found",
  "invalid",
  "conflict",
  "key-mismatch",
  "not-allowed",
  "io",
]);
export type VaultErrorReason = typeof VaultErrorReason.Type;

export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  reason: VaultErrorReason,
  message: Schema.String,
}) {}
