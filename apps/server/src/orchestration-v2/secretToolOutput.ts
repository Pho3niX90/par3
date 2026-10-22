import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

export const REDACTED_SECRET_OUTPUT = "The value of this secret is not stored by Par3.";

/**
 * The live agent receives a `secret_get` value, but a turn item is stored in the event log and
 * the projection, and any client that can read the thread can load it. Failures keep their output:
 * they carry the reason, never a value.
 */
export function redactSecretToolOutput(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (
    item.type !== "dynamic_tool" ||
    item.output === undefined ||
    resolveT3McpToolId(item.toolName) !== "secret_get" ||
    compactDynamicToolOutput(item.output)?.isError === true
  ) {
    return item;
  }
  return { ...item, output: REDACTED_SECRET_OUTPUT };
}
