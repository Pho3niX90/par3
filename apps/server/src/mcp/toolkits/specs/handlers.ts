import {
  type CommandId,
  OrchestratorMcpFailure,
  type SpecMutationInput,
  type SpecQueryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as SpecService from "../../../specs/SpecService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SpecsToolkit } from "./tools.ts";

type AgentAction = Exclude<
  SpecMutationInput["action"],
  | "create"
  | "approve"
  | "reject"
  | "request-changes"
  | "reopen"
  | "confirm-evidence"
  | "bind"
  | "unbind"
>;

const toFailure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const mutate =
  <const Action extends AgentAction>(action: Action) =>
  <P extends { readonly expectedRevision: number; readonly commandId: CommandId }>(params: P) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const own = yield* McpInvocationContext.requireThreadScope(scope, "Spec changes");
      const service = yield* SpecService.SpecService;
      const binding = yield* service.binding(own.thread.threadId).pipe(Effect.mapError(toFailure));
      if (!binding) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "This thread is not bound to a spec. A human binds threads to specs in the client.",
        });
      }
      const input = {
        ...params,
        action,
        projectId: binding.projectId,
        threadId: own.thread.threadId,
        slug: binding.slug,
      } as SpecMutationInput;
      return yield* service
        .mutate(input, { kind: "agent", threadId: own.thread.threadId })
        .pipe(Effect.mapError(toFailure));
    });

const query = Effect.fn("SpecsMcp.query")(function* (input: SpecQueryInput) {
  const service = yield* SpecService.SpecService;
  return yield* service.query(input).pipe(Effect.mapError(toFailure));
});

export const layer = McpToolAccess.toLayer(SpecsToolkit, {
  spec_status: McpToolAccess.reads(query),
  spec_update: McpToolAccess.writesSpec(mutate("update")),
  spec_request_approval: McpToolAccess.writesSpec(mutate("request-review")),
  spec_set_status: McpToolAccess.writesSpec(mutate("transition")),
  spec_update_tasks: McpToolAccess.writesSpec(mutate("tasks")),
  spec_record_evidence: McpToolAccess.writesSpec(mutate("evidence")),
  spec_write_artifact: McpToolAccess.writesSpec(mutate("artifact")),
});
