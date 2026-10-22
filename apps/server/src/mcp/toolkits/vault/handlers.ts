import * as Effect from "effect/Effect";

import * as VaultService from "../../../vault/VaultService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { VaultToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(VaultToolkit, {
  vault_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* McpInvocationContext.requireMcpCapability("vault");
      const vault = yield* VaultService.VaultService;
      return { entries: (yield* vault.list).entries };
    }),
  ),
  // Reading puts the value in the conversation, so it is limited to threads already trusted to
  // run anything without asking; the per-secret switch is the user's consent to share it at all.
  secret_get: McpToolAccess.readsAsLiveCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireMcpCapability("vault");
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "secret_get");
      const caller = yield* loadCaller();
      const allowed =
        caller.scope.client === undefined &&
        caller.limits.runtimeMode === "full-access" &&
        caller.limits.interactionMode === "default";
      const vault = yield* VaultService.VaultService;
      const value = yield* vault.readForAgent(
        input.name,
        {
          threadId: thread.thread.threadId,
          providerInstanceId: thread.thread.providerInstanceId,
        },
        allowed,
      );
      return { name: input.name, value };
    }),
  ),
});
