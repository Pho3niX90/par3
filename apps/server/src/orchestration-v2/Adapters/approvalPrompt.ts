// Generous enough for real commands, heredocs included, while keeping a runaway tool
// input from bloating every projection and client snapshot that carries the prompt.
const MAX_APPROVAL_ACTION_LENGTH = 16_000;

/**
 * Providers attach friendly summaries ("List files") to approvals. The user must still
 * see exactly what they are approving, so the action is always kept next to the summary.
 */
export function approvalPrompt(
  summary: string | null | undefined,
  action: string | null | undefined,
): string | undefined {
  const trimmedSummary = summary?.trim() || undefined;
  const trimmedAction = action?.trim() || undefined;
  const boundedAction =
    trimmedAction === undefined || trimmedAction.length <= MAX_APPROVAL_ACTION_LENGTH
      ? trimmedAction
      : `${trimmedAction.slice(0, MAX_APPROVAL_ACTION_LENGTH)}\n… ${trimmedAction.length - MAX_APPROVAL_ACTION_LENGTH} more characters`;
  if (trimmedSummary === undefined) return boundedAction;
  if (trimmedAction === undefined || trimmedSummary.includes(trimmedAction)) return trimmedSummary;
  return `${trimmedSummary}\n${boundedAction}`;
}
