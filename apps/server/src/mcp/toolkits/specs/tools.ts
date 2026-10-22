import {
  CommandId,
  NonNegativeInt,
  OrchestratorMcpFailure,
  SpecDocument,
  SpecEvidenceInput,
  SpecQueryInput,
  SpecQueryResult,
  SpecStatus,
  SpecTask,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SpecService from "../../../specs/SpecService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    SpecService.SpecService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};

// Agents act only on the spec bound to their own thread, so the server fills in project, thread and slug.
const revision = {
  expectedRevision: NonNegativeInt.annotate({
    description: "The spec revision you last read with spec_status.",
  }),
  commandId: CommandId.annotate({
    description: "A new unique ID for each change; reuse it only when retrying the same change.",
  }),
};

const mutation = <const Name extends string, const Fields extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  fields: Fields,
) =>
  Tool.make(name, {
    ...shared,
    description,
    parameters: Schema.Struct({ ...revision, ...fields }),
    success: SpecDocument,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true);

export const SpecsToolkit = Toolkit.make(
  Tool.make("spec_status", {
    ...shared,
    description:
      "Read project specs or one spec, including readiness findings, approval hashes, current revision, tasks and evidence. Set threadId to your own thread to select its checkout and bound spec.",
    parameters: SpecQueryInput,
    success: SpecQueryResult,
  }).annotate(Tool.Readonly, true),
  mutation(
    "spec_update",
    "Requirements role: replace the requirements markdown of your bound spec. Preserve AC-n IDs and retire removed ones as ~~AC-n~~. Changing approved requirements revokes approval and interrupts linked work.",
    { content: Schema.String, title: Schema.optional(TrimmedNonEmptyString) },
  ),
  mutation(
    "spec_request_approval",
    "Requirements role: submit your bound spec for human review once spec_status reports no readiness findings, then stop. This cannot approve a spec.",
    {},
  ),
  mutation(
    "spec_set_status",
    "Report lifecycle progress on your bound spec. Implementation: approved -> in-progress -> implemented, or blocked. Test: implemented -> done (needs current passing evidence for every criterion) or back to in-progress.",
    { status: SpecStatus },
  ),
  mutation(
    "spec_update_tasks",
    "Implementation role: set tasks covering every active AC-n, with dependencies and a concrete verification step. Changing task definitions clears earlier evidence; status-only changes keep approval.",
    { tasks: Schema.Array(SpecTask) },
  ),
  mutation(
    "spec_record_evidence",
    "Implementation/Test role: record criterion evidence referencing the current requirementsHash, taskHash and the tested checkpoint. Manual evidence needs human confirmation in the client.",
    { evidence: Schema.Array(SpecEvidenceInput) },
  ),
  mutation(
    "spec_write_artifact",
    "Implementation/Test role: write test-plan.md, decisions.md, or evidence/<name>.md|txt|json inside your bound spec directory. In a BASE project any writing role can also write prd.md, tech-analysis.md and status.json.",
    { path: TrimmedNonEmptyString, content: Schema.String },
  ),
);
