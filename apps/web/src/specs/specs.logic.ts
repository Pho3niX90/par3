import {
  locateSelection,
  sectionHeadingAt,
  selectionContext,
} from "@t3tools/client-runtime/spec-documents";
import type { SpecRemarkSelection, SpecStatus } from "@t3tools/contracts";

export { specRoleRefusal } from "@t3tools/shared/specComposer";

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

const SPEC_PAGE_SIZE = 25;

export function specPageLimit(pages: number): number {
  return Math.min(200, Math.max(1, pages) * SPEC_PAGE_SIZE);
}

/** A BASE checkout supplies its own template; otherwise new specs start from Par3's sections. */
export function seedSpecContent(title: string, template: string | undefined): string {
  return template ?? defaultSpecContent(title);
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

const MAX_SELECTION = 2000;
const CONTEXT = 30;

/**
 * What a remark records about a selection of rendered text: the section it belongs to and some
 * surrounding text. The source is searched first, since that gives the real `##` heading and a
 * stable context; text the source cannot be matched to (formatting inside the selection) falls
 * back to what the rendered page around it said.
 */
export function describeRemarkSelection(input: {
  readonly source: string;
  readonly selected: string;
  readonly renderedBefore: string;
  readonly renderedAfter: string;
  readonly renderedHeading: string | undefined;
  readonly documentLabel: string;
}): { readonly selection: SpecRemarkSelection; readonly heading: string } {
  const text = input.selected.trim().slice(0, MAX_SELECTION);
  const located = locateSelection(input.source, text, input.renderedBefore.slice(-CONTEXT));
  const context = located
    ? selectionContext(input.source, located.start, located.end, CONTEXT)
    : {
        prefix: input.renderedBefore.slice(-CONTEXT),
        suffix: input.renderedAfter.slice(0, CONTEXT),
      };
  const heading =
    (located ? sectionHeadingAt(input.source, located.start) : undefined) ??
    input.renderedHeading?.trim() ??
    input.documentLabel;
  return {
    heading: heading === "" ? input.documentLabel : heading,
    selection: {
      text,
      ...(context.prefix === "" ? {} : { prefix: context.prefix }),
      ...(context.suffix === "" ? {} : { suffix: context.suffix }),
    },
  };
}
