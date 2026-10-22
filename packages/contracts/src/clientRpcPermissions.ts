import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
import { SyncApplyInput, SyncSetParticipationInput, splitSyncItemKey } from "./sync.ts";
import { VaultMutation, vaultMutationNeedsOwner } from "./vault.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  // Testing starts the server's command on the host, like saving it would.
  [WS_METHODS.mcpGatewayTest]: AuthSettingsWriteScope,
  [WS_METHODS.specsMutate]: AuthOrchestrationOperateScope,
  // Sync writes into provider homes and settings on the host.
  [WS_METHODS.syncApply]: AuthProvidersManageScope,
  [WS_METHODS.syncSetParticipation]: AuthProvidersManageScope,
  // Owner-only mutations are raised to access:write below.
  [WS_METHODS.vaultMutate]: AuthSettingsWriteScope,
  // Holding the vault key opens every secret, so handing it out is an owner decision.
  [WS_METHODS.vaultWrapKeyFor]: AuthAccessWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsConflictsResolve]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsConflictsAutoResolve]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsConflictsReopen]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsOperationRun]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsMergeBase]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeVaultMutation = Schema.decodeUnknownSync(VaultMutation);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeSyncApply = Schema.decodeUnknownOption(SyncApplyInput);
const decodeSyncParticipation = Schema.decodeUnknownOption(SyncSetParticipationInput);

/** These categories live in settings and the vault, not in a provider's home folder. */
const SETTINGS_BACKED_SYNC_CATEGORIES: ReadonlySet<string> = new Set(["vault", "mcpServers"]);

/** Syncing files needs provider administration; syncing settings-backed items also writes settings. */
function syncScopes(touchesSettings: boolean): readonly AuthEnvironmentScope[] {
  return touchesSettings
    ? [AuthProvidersManageScope, AuthSettingsWriteScope]
    : [AuthProvidersManageScope];
}

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  // Thread commands migrate to the client guard individually; existing callers
  // still rely on server authorization until their command boundary is migrated.
  if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && input !== undefined) {
    return typeof input === "object" &&
      input !== null &&
      "type" in input &&
      input.type === "thread.sidekick.set"
      ? [AuthOrchestrationOperateScope]
      : [];
  }
  if (method === WS_METHODS.vaultMutate && input !== undefined) {
    return vaultMutationNeedsOwner(decodeVaultMutation(input))
      ? [AuthAccessWriteScope]
      : [AuthSettingsWriteScope];
  }
  // An undecodable payload is rejected by the handler anyway; until then, assume the stricter set.
  if (method === WS_METHODS.syncApply && input !== undefined) {
    const payload = decodeSyncApply(input);
    return syncScopes(
      Option.isNone(payload) ||
        payload.value.ops.some((op) => {
          const category = splitSyncItemKey(op.key)?.categoryId;
          return category === undefined || SETTINGS_BACKED_SYNC_CATEGORIES.has(category);
        }),
    );
  }
  if (method === WS_METHODS.syncSetParticipation && input !== undefined) {
    const payload = decodeSyncParticipation(input);
    return syncScopes(
      Option.isNone(payload) ||
        payload.value.categories.some((category) => SETTINGS_BACKED_SYNC_CATEGORIES.has(category)),
    );
  }
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
