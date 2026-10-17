/**
 * Maps a failed GitHub Copilot ACP prompt to an orchestration failure.
 *
 * @module provider-copilot/server/copilotFailure
 */
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

/**
 * Copilot reports its limits as plain text on a JSON-RPC error (no dedicated error code is
 * documented), so a request error is matched on whole phrases. Bare status numbers are left
 * out on purpose: request ids and ports contain them. Transport and spawn failures are never
 * usage limits.
 */
const USAGE_LIMIT_MESSAGE =
  /\b(?:rate[\s-]?limit(?:ed)?|too many requests|quota (?:exceeded|exhausted)|(?:insufficient|no) quota|usage limit|payment required)\b/i;

export function copilotPromptFailure(cause: unknown): OrchestrationV2ProviderFailure {
  if (!isAcpRequestError(cause)) {
    return makeProviderFailure({ cause, class: "provider_error" });
  }
  return makeProviderFailure({
    cause,
    message: cause.errorMessage || "GitHub Copilot prompt failed",
    code: String(cause.code),
    class: USAGE_LIMIT_MESSAGE.test(cause.errorMessage) ? "usage_limit" : "provider_error",
  });
}
