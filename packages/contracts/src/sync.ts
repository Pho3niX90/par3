import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Categories are open strings: each server reports the ones it has, and clients act only on
 * categories both sides report, so a newer server can add one without a contract change.
 */
export const SyncCategoryId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type SyncCategoryId = typeof SyncCategoryId.Type;

/** `${categoryId}:${name}`: the name is a secret name, server id, or relative file path. */
export const SyncItemKey = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
export type SyncItemKey = typeof SyncItemKey.Type;

export function syncItemKey(categoryId: string, name: string): string {
  return `${categoryId}:${name}`;
}

export function splitSyncItemKey(key: string): { categoryId: string; name: string } | null {
  const index = key.indexOf(":");
  if (index <= 0 || index === key.length - 1) return null;
  return { categoryId: key.slice(0, index), name: key.slice(index + 1) };
}

export const SyncCategory = Schema.Struct({
  id: SyncCategoryId,
  label: Schema.String,
  available: Schema.Boolean,
  unavailableReason: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.String),
});
export type SyncCategory = typeof SyncCategory.Type;

export const SyncSkipReason = Schema.Literals(["binary", "too-large", "symlink", "needs-vault"]);
export type SyncSkipReason = typeof SyncSkipReason.Type;

export const SyncItem = Schema.Struct({
  key: SyncItemKey,
  categoryId: SyncCategoryId,
  name: Schema.String,
  hash: Schema.String,
  byteLength: NonNegativeInt,
  /** Listed so a person can see why it stays local; never synced. */
  skipped: Schema.optionalKey(SyncSkipReason),
});
export type SyncItem = typeof SyncItem.Type;

/** The version this environment last agreed on with the others; a null hash is a deletion. */
export const SyncBaseline = Schema.Struct({
  hash: Schema.NullOr(Schema.String),
  rev: NonNegativeInt,
});
export type SyncBaseline = typeof SyncBaseline.Type;

export const SyncParticipation = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(SyncCategoryId),
  excluded: Schema.Array(SyncItemKey),
  decidedAt: IsoDateTime,
});
export type SyncParticipation = typeof SyncParticipation.Type;

export const SyncSnapshot = Schema.Struct({
  /** Null until someone decides whether this environment syncs. */
  participation: Schema.NullOr(SyncParticipation),
  categories: Schema.Array(SyncCategory),
  items: Schema.Array(SyncItem),
  baselines: Schema.Record(Schema.String, SyncBaseline),
  seq: NonNegativeInt,
});
export type SyncSnapshot = typeof SyncSnapshot.Type;

export const SyncReadInput = Schema.Struct({ key: SyncItemKey });
export type SyncReadInput = typeof SyncReadInput.Type;

export const SyncReadResult = Schema.Struct({
  key: SyncItemKey,
  contents: Schema.String,
  hash: Schema.String,
});
export type SyncReadResult = typeof SyncReadResult.Type;

export const SyncApplyAction = Schema.Union([
  Schema.TaggedStruct("write", { contents: Schema.String }),
  Schema.TaggedStruct("delete", {}),
  /** Records the baseline without touching the item, for an item already at that version. */
  Schema.TaggedStruct("adopt", {}),
]);
export type SyncApplyAction = typeof SyncApplyAction.Type;

export const SyncApplyOp = Schema.Struct({
  key: SyncItemKey,
  /** The hash the caller saw; the op is refused when the item changed since. Null: absent. */
  expectedHash: Schema.NullOr(Schema.String),
  action: SyncApplyAction,
  baseline: SyncBaseline,
});
export type SyncApplyOp = typeof SyncApplyOp.Type;

export const SyncApplyInput = Schema.Struct({
  ops: Schema.Array(SyncApplyOp).check(Schema.isMaxLength(200)),
});
export type SyncApplyInput = typeof SyncApplyInput.Type;

export const SyncApplyOutcome = Schema.Struct({
  key: SyncItemKey,
  status: Schema.Literals(["applied", "stale", "rejected"]),
  currentHash: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.String),
});
export type SyncApplyOutcome = typeof SyncApplyOutcome.Type;

export const SyncApplyResult = Schema.Struct({
  results: Schema.Array(SyncApplyOutcome),
});
export type SyncApplyResult = typeof SyncApplyResult.Type;

export const SyncSetParticipationInput = Schema.Struct({
  enabled: Schema.Boolean,
  categories: Schema.Array(SyncCategoryId),
  excluded: Schema.Array(SyncItemKey),
});
export type SyncSetParticipationInput = typeof SyncSetParticipationInput.Type;

export const SyncErrorReason = Schema.Literals([
  "not-allowed",
  "not-found",
  "too-large",
  "category-unavailable",
  "io",
]);
export type SyncErrorReason = typeof SyncErrorReason.Type;

export class SyncError extends Schema.TaggedError<SyncError>()("SyncError", {
  reason: SyncErrorReason,
  message: Schema.String,
}) {}
