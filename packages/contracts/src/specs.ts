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

/**
 * `par3` owns the status, task and approval files beside `spec.md`. `base` follows the project's
 * external BASE workflow and leaves those files alone. A spec keeps the layout it was created with.
 */
export const SpecLayout = Schema.Literals(["par3", "base"]);
export type SpecLayout = typeof SpecLayout.Type;

const PAR3_SPEC_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASE_SPEC_SLUG = /^[A-Z][A-Z0-9]+-\d+_[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SPEC_SLUG_MAX_LENGTH = 80;

/** What the contract accepts is the union; each layout then enforces its own subset. */
export function specSlugAllowed(slug: string, layout: SpecLayout): boolean {
  return (
    slug.length <= SPEC_SLUG_MAX_LENGTH &&
    (PAR3_SPEC_SLUG.test(slug) || (layout === "base" && BASE_SPEC_SLUG.test(slug)))
  );
}

export const SpecSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SPEC_SLUG_MAX_LENGTH),
  Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*|[A-Z][A-Z0-9]+-\d+_[a-z0-9]+(?:-[a-z0-9]+)*)$/),
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
  /** Set when the approval was recorded outside Par3 and adopted from the project's approval.json. */
  external: Schema.optionalKey(Schema.Boolean),
});
export type SpecApproval = typeof SpecApproval.Type;

export const SpecFinding = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: Schema.String,
  criterion: Schema.optionalKey(Schema.String),
});
export type SpecFinding = typeof SpecFinding.Type;

export const SpecValidateResult = Schema.Struct({
  layout: SpecLayout,
  /** False when no external validator ran: always in a Par3 layout, or when none could be started. */
  ran: Schema.Boolean,
  ok: Schema.Boolean,
  findings: Schema.Array(SpecFinding),
  /** Problems that do not block review or approval, such as Python being unavailable. */
  warnings: Schema.Array(Schema.String),
});
export type SpecValidateResult = typeof SpecValidateResult.Type;

export const SpecSummary = Schema.Struct({
  slug: SpecSlug,
  title: TrimmedNonEmptyString,
  status: SpecStatus,
  revision: NonNegativeInt,
  workspacePath: Schema.String,
  updatedAt: Schema.String,
  approvalValid: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  /** Absent on specs stored before layouts existed, which are `par3`. */
  layout: Schema.optionalKey(SpecLayout),
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
  layout: Schema.optionalKey(SpecLayout),
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
  /** Ask for the checkout's `specs/_template.md`; sent only when a client will seed a new spec. */
  includeTemplate: Schema.optionalKey(Schema.Boolean),
});
export type SpecQueryInput = typeof SpecQueryInput.Type;

/**
 * A thread asked to start a spec from its next message. It ends only when the agent creates the
 * spec (which binds the thread) or a person cancels it.
 */
export const SpecIntake = Schema.Struct({ createdAt: Schema.String });
export type SpecIntake = typeof SpecIntake.Type;

export const SpecQueryResult = Schema.Struct({
  specs: Schema.Array(SpecSummary),
  detail: Schema.optionalKey(SpecDocument),
  nextOffset: Schema.optionalKey(NonNegativeInt),
  /** The layout a new spec gets in this checkout. */
  layout: Schema.optionalKey(SpecLayout),
  /** The checkout's `specs/_template.md`, present only for `base` and when the query asked for it. */
  template: Schema.optionalKey(Schema.String),
  /** Present when the query named a thread that is waiting for its spec to be created. */
  intake: Schema.optionalKey(SpecIntake),
});
export type SpecQueryResult = typeof SpecQueryResult.Type;

/** `mark` waits for the thread's next message to start a spec; `cancel` withdraws that. */
export const SpecIntakeInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  action: Schema.Literals(["mark", "cancel"]),
});
export type SpecIntakeInput = typeof SpecIntakeInput.Type;

export const SpecIntakeResult = Schema.Struct({ intake: Schema.NullOr(SpecIntake) });
export type SpecIntakeResult = typeof SpecIntakeResult.Type;

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
  requirements: ["codex", "claudeAgent"],
  implementation: ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"],
  test: ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity"],
  researcher: ["codex", "claudeAgent"],
  verifier: ["codex", "claudeAgent"],
};

export function specRoleSupported(driver: string, role: SpecRole): boolean {
  return SPEC_ROLE_SUPPORT[role].includes(driver);
}
