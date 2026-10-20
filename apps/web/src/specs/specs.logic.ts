import { specRoleSupported, type SpecRole, type SpecStatus } from "@t3tools/contracts";

export type SpecActionId =
  | "edit"
  | "request-review"
  | "approve"
  | "request-changes"
  | "reject"
  | "start-implementation"
  | "start-requirements"
  | "reopen";

export interface SpecAction {
  readonly id: SpecActionId;
  readonly label: string;
  readonly tone: "primary" | "secondary" | "destructive";
  readonly disabledReason: string | null;
}

const NO_PERMISSION_REASON = "This connection cannot change specs.";

function action(
  id: SpecActionId,
  label: string,
  tone: SpecAction["tone"],
  disabledReason: string | null,
): SpecAction {
  return { id, label, tone, disabledReason };
}

export function resolveSpecActions(input: {
  readonly status: SpecStatus;
  readonly canMutate: boolean;
  readonly findingCount: number;
  readonly approvalValid: boolean;
  readonly hasError: boolean;
}): ReadonlyArray<SpecAction> {
  const { status, canMutate, findingCount, approvalValid, hasError } = input;
  const gate = (reason: string | null) => (canMutate ? reason : NO_PERMISSION_REASON);
  const actions: SpecAction[] = [];
  switch (status) {
    case "draft":
      actions.push(
        action("edit", "Edit", "secondary", gate(null)),
        action("request-review", "Request review", "primary", gate(null)),
        action("start-requirements", "Start requirements thread", "secondary", gate(null)),
      );
      break;
    case "review":
      actions.push(
        action(
          "approve",
          "Approve",
          "primary",
          gate(
            findingCount > 0
              ? `Resolve ${findingCount} readiness ${findingCount === 1 ? "finding" : "findings"} before approving.`
              : null,
          ),
        ),
        action("request-changes", "Request changes", "secondary", gate(null)),
        action("reject", "Reject", "destructive", gate(null)),
        action("start-requirements", "Start requirements thread", "secondary", gate(null)),
      );
      break;
    case "approved":
      actions.push(
        action(
          "start-implementation",
          "Start implementation",
          "primary",
          gate(
            approvalValid
              ? null
              : "The approval is out of date. Reopen the spec and approve it again.",
          ),
        ),
      );
      if (!approvalValid) actions.push(action("reopen", "Reopen", "secondary", gate(null)));
      break;
    case "rejected":
    case "done":
    case "implemented":
    case "blocked":
      actions.push(action("reopen", "Reopen", "secondary", gate(null)));
      break;
    case "in-progress":
      break;
  }
  if (hasError && !actions.some((entry) => entry.id === "reopen")) {
    actions.push(action("reopen", "Reopen", "secondary", gate(null)));
  }
  return actions;
}

export function nextSpecStepHint(status: SpecStatus): string {
  switch (status) {
    case "draft":
      return "Finish the requirements, then request review.";
    case "review":
      return "Waiting for a person to approve or request changes.";
    case "approved":
      return "Approved. Start implementation in a new thread.";
    case "in-progress":
      return "Implementation is in progress.";
    case "implemented":
      return "Implemented. Check the evidence, then reopen if needed.";
    case "done":
      return "Done.";
    case "blocked":
      return "Blocked. Reopen the spec to continue.";
    case "rejected":
      return "Rejected. Reopen the spec to revise it.";
  }
}

const DRIVER_LABELS: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

export function specRoleRefusal(driver: string | null, role: SpecRole): string | null {
  if (driver === null) return "Choose a provider before binding this thread to a spec.";
  if (specRoleSupported(driver, role)) return null;
  const label = DRIVER_LABELS[driver] ?? driver;
  return `The ${role} role needs Codex or Claude. ${label} supports the implementation and test roles only.`;
}

export function specModeCreateDisabledReason(input: {
  readonly specModeEnabled: boolean;
  readonly canMutate: boolean;
}): string | null {
  if (!input.canMutate) return NO_PERMISSION_REASON;
  if (!input.specModeEnabled) {
    return "Turn on Spec mode in the project settings to create specs.";
  }
  return null;
}

export const SPEC_PAGE_SIZE = 25;

export function specPageLimit(pages: number): number {
  return Math.min(200, Math.max(1, pages) * SPEC_PAGE_SIZE);
}

export function defaultSpecContent(title: string): string {
  const heading = title.trim().length > 0 ? title.trim() : "Untitled spec";
  return [
    `# ${heading}`,
    "",
    "## Summary",
    "",
    "What this change is for, in a few sentences.",
    "",
    "## Scope",
    "",
    "What is in scope, and what is not.",
    "",
    "## Users and scenarios",
    "",
    "Who uses it, and the situations that matter.",
    "",
    "## Acceptance criteria",
    "",
    "- AC-1: ",
    "",
    "## Constraints",
    "",
    "Limits the solution must respect.",
    "",
    "## Open questions",
    "",
    "Anything still undecided.",
    "",
    "## Design notes",
    "",
    "Approach, trade-offs and links.",
    "",
  ].join("\n");
}
