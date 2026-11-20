import { specRoleSupported, type SpecRole, type SpecStatus } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../i18n/messages";

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

const noPermissionReason = () => m(msg("This connection cannot change specs."));

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
  const gate = (reason: string | null) => (canMutate ? reason : noPermissionReason());
  const actions: SpecAction[] = [];
  switch (status) {
    case "draft":
      actions.push(
        action("edit", m(msg("Edit")), "secondary", gate(null)),
        action("request-review", m(msg("Request review")), "primary", gate(null)),
        action("start-requirements", m(msg("Start requirements thread")), "secondary", gate(null)),
      );
      break;
    case "review":
      actions.push(
        action(
          "approve",
          m(msg("Approve")),
          "primary",
          gate(
            findingCount > 0
              ? m(
                  msg(
                    "{count, plural, one {Resolve {count} readiness finding before approving.} other {Resolve {count} readiness findings before approving.}}",
                    { count: findingCount },
                  ),
                )
              : null,
          ),
        ),
        action("request-changes", m(msg("Request changes")), "secondary", gate(null)),
        action("reject", m(msg("Reject")), "destructive", gate(null)),
        action("start-requirements", m(msg("Start requirements thread")), "secondary", gate(null)),
      );
      break;
    case "approved":
      actions.push(
        action(
          "start-implementation",
          m(msg("Start implementation")),
          "primary",
          gate(
            approvalValid
              ? null
              : m(msg("The approval is out of date. Reopen the spec and approve it again.")),
          ),
        ),
      );
      if (!approvalValid) actions.push(action("reopen", m(msg("Reopen")), "secondary", gate(null)));
      break;
    case "rejected":
    case "done":
    case "implemented":
    case "blocked":
      actions.push(action("reopen", m(msg("Reopen")), "secondary", gate(null)));
      break;
    case "in-progress":
      break;
  }
  if (hasError && !actions.some((entry) => entry.id === "reopen")) {
    actions.push(action("reopen", m(msg("Reopen")), "secondary", gate(null)));
  }
  return actions;
}

export function nextSpecStepHint(status: SpecStatus): string {
  switch (status) {
    case "draft":
      return m(msg("Finish the requirements, then request review."));
    case "review":
      return m(msg("Waiting for a person to approve or request changes."));
    case "approved":
      return m(msg("Approved. Start implementation in a new thread."));
    case "in-progress":
      return m(msg("Implementation is in progress."));
    case "implemented":
      return m(msg("Implemented. Check the evidence, then reopen if needed."));
    case "done":
      return m(msg("Done."));
    case "blocked":
      return m(msg("Blocked. Reopen the spec to continue."));
    case "rejected":
      return m(msg("Rejected. Reopen the spec to revise it."));
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
  if (driver === null) return m(msg("Choose a provider before binding this thread to a spec."));
  if (specRoleSupported(driver, role)) return null;
  const label = DRIVER_LABELS[driver] ?? driver;
  return m(
    msg(
      "The {role} role needs Codex or Claude. {label} supports the implementation and test roles only.",
      { role, label },
    ),
  );
}

export function specModeCreateDisabledReason(input: {
  readonly specModeEnabled: boolean;
  readonly canMutate: boolean;
}): string | null {
  if (!input.canMutate) return noPermissionReason();
  if (!input.specModeEnabled) {
    return m(msg("Turn on Spec mode in the project settings to create specs."));
  }
  return null;
}

const SPEC_PAGE_SIZE = 25;

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
