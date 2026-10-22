import * as Schema from "effect/Schema";

import {
  CommandId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const SpecStatus = Schema.Literals([
  "draft",
  "review",
  "approved",
  "in-progress",
  "implemented",
  "done",
  "blocked",
  "rejected",
]);
export type SpecStatus = typeof SpecStatus.Type;

export const SpecRole = Schema.Literals([
  "requirements",
  "implementation",
  "test",
  "researcher",
  "verifier",
]);
export type SpecRole = typeof SpecRole.Type;

export const SpecSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
export type SpecSlug = typeof SpecSlug.Type;

export const SpecBinding = Schema.Struct({
  slug: SpecSlug,
  role: SpecRole,
});
export type SpecBinding = typeof SpecBinding.Type;

export const SpecTarget = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type SpecTarget = typeof SpecTarget.Type;

export const SpecRef = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  slug: SpecSlug,
});
export type SpecRef = typeof SpecRef.Type;

export const SpecTaskStatus = Schema.Literals(["pending", "in-progress", "passed", "failed"]);
export type SpecTaskStatus = typeof SpecTaskStatus.Type;

export const SpecTask = Schema.Struct({
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  acs: Schema.Array(TrimmedNonEmptyString),
  dependsOn: Schema.Array(TrimmedNonEmptyString),
  verify: Schema.String,
  status: SpecTaskStatus,
});
export type SpecTask = typeof SpecTask.Type;

export const SpecEvidenceKind = Schema.Literals(["automated", "manual"]);
export type SpecEvidenceKind = typeof SpecEvidenceKind.Type;

export const SpecEvidence = Schema.Struct({
  id: TrimmedNonEmptyString,
  acs: Schema.Array(TrimmedNonEmptyString),
  kind: SpecEvidenceKind,
  description: Schema.String,
  checkpoint: Schema.String,
  requirementsHash: Schema.String,
  taskHash: Schema.String,
  passed: Schema.Boolean,
  confirmedBy: Schema.optionalKey(Schema.String),
});
export type SpecEvidence = typeof SpecEvidence.Type;

export const SpecEvidenceInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  acs: Schema.Array(TrimmedNonEmptyString),
  kind: SpecEvidenceKind,
  description: Schema.String,
  checkpoint: Schema.String,
  requirementsHash: Schema.String,
  taskHash: Schema.String,
  passed: Schema.Boolean,
});
export type SpecEvidenceInput = typeof SpecEvidenceInput.Type;

export const SpecApproval = Schema.Struct({
  subject: Schema.String,
  label: Schema.String,
  approvedAt: Schema.String,
  revision: NonNegativeInt,
  specHash: Schema.String,
  constitutionHash: Schema.NullOr(Schema.String),
});
export type SpecApproval = typeof SpecApproval.Type;

export const SpecFinding = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: Schema.String,
  criterion: Schema.optionalKey(Schema.String),
});
export type SpecFinding = typeof SpecFinding.Type;

export const SpecSummary = Schema.Struct({
  slug: SpecSlug,
  title: TrimmedNonEmptyString,
  status: SpecStatus,
  revision: NonNegativeInt,
  workspacePath: Schema.String,
  updatedAt: Schema.String,
  approvalValid: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});
export type SpecSummary = typeof SpecSummary.Type;

export const SpecDocument = Schema.Struct({
  slug: SpecSlug,
  title: TrimmedNonEmptyString,
  status: SpecStatus,
  revision: NonNegativeInt,
  workspacePath: Schema.String,
  updatedAt: Schema.String,
  approvalValid: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  version: Schema.Literal(1),
  content: Schema.String,
  tasks: Schema.Array(SpecTask),
  evidence: Schema.Array(SpecEvidence),
  approval: Schema.NullOr(SpecApproval),
  findings: Schema.Array(SpecFinding),
  specHash: Schema.String,
  constitutionHash: Schema.NullOr(Schema.String),
  taskHash: Schema.String,
  bindings: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      role: SpecRole,
    }),
  ),
  supersedes: Schema.optionalKey(SpecSlug),
});
export type SpecDocument = typeof SpecDocument.Type;

export const SpecQueryInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  slug: Schema.optionalKey(SpecSlug),
  offset: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
});
export type SpecQueryInput = typeof SpecQueryInput.Type;

export const SpecQueryResult = Schema.Struct({
  specs: Schema.Array(SpecSummary),
  detail: Schema.optionalKey(SpecDocument),
  nextOffset: Schema.optionalKey(NonNegativeInt),
});
export type SpecQueryResult = typeof SpecQueryResult.Type;

const SpecMutationBase = {
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
  slug: SpecSlug,
  commandId: CommandId,
  expectedRevision: NonNegativeInt,
};

export const SpecMutationInput = Schema.Union([
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("create"),
    content: Schema.String,
    title: TrimmedNonEmptyString,
    supersedes: Schema.optionalKey(SpecSlug),
  }),
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("update"),
    content: Schema.String,
    title: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({ ...SpecMutationBase, action: Schema.Literal("request-review") }),
  Schema.Struct({ ...SpecMutationBase, action: Schema.Literal("approve") }),
  Schema.Struct({ ...SpecMutationBase, action: Schema.Literal("request-changes") }),
  Schema.Struct({ ...SpecMutationBase, action: Schema.Literal("reject") }),
  Schema.Struct({ ...SpecMutationBase, action: Schema.Literal("reopen") }),
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("transition"),
    status: SpecStatus,
  }),
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("tasks"),
    tasks: Schema.Array(SpecTask),
  }),
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("evidence"),
    evidence: Schema.Array(SpecEvidenceInput),
  }),
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("confirm-evidence"),
    evidenceId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("bind"),
    role: SpecRole,
  }),
  Schema.Struct({ ...SpecMutationBase, action: Schema.Literal("unbind") }),
  Schema.Struct({
    ...SpecMutationBase,
    action: Schema.Literal("artifact"),
    path: TrimmedNonEmptyString,
    content: Schema.String,
  }),
]);
export type SpecMutationInput = typeof SpecMutationInput.Type;

export const SpecErrorReason = Schema.Literals([
  "not-found",
  "disabled",
  "conflict",
  "invalid",
  "forbidden",
  "approval-required",
  "unsupported-provider",
  "io",
  "inconsistent",
]);
export type SpecErrorReason = typeof SpecErrorReason.Type;

export class SpecError extends Schema.TaggedError<SpecError>()("SpecError", {
  reason: SpecErrorReason,
  message: Schema.String,
}) {}

const SPEC_ROLE_SUPPORT: Readonly<Record<SpecRole, readonly string[]>> = {
  requirements: ["codex", "claudeAgent", "copilot"],
  implementation: ["codex", "claudeAgent", "copilot", "cursor", "grok", "opencode", "antigravity"],
  test: ["codex", "claudeAgent", "copilot", "cursor", "grok", "opencode", "antigravity"],
  researcher: ["codex", "claudeAgent", "copilot"],
  verifier: ["codex", "claudeAgent", "copilot"],
};

export function specRoleSupported(driver: string, role: SpecRole): boolean {
  return SPEC_ROLE_SUPPORT[role].includes(driver);
}
