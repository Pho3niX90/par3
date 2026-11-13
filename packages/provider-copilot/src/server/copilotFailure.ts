/**
 * Maps a failed GitHub Copilot ACP prompt to an orchestration failure.
 *
 * @module provider-copilot/server/copilotFailure
 */
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { COPILOT_USAGE_LIMIT_MESSAGE } from "@t3tools/provider-acp/server/copilotAcp";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

// Only a request error carries Copilot's limit text; transport and spawn failures never do.
export function copilotPromptFailure(cause: unknown): OrchestrationV2ProviderFailure {
  if (!isAcpRequestError(cause)) {
    return makeProviderFailure({ cause, class: "provider_error" });
  }
  return makeProviderFailure({
    cause,
    message: cause.errorMessage || "GitHub Copilot prompt failed",
    code: String(cause.code),
    class: COPILOT_USAGE_LIMIT_MESSAGE.test(cause.errorMessage) ? "usage_limit" : "provider_error",
  });
}
