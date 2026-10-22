import type { SpecDocument, SpecLayout, SpecRole } from "@t3tools/contracts";

// The BASE layout has no constitution and no Par3-owned status, task or approval files, so its
// instructions drop those references.
const roles = (base: boolean): Record<SpecRole, string> => ({
  requirements: `Turn the request into requirements, never implementation. ${base ? "Read the relevant" : "Read specs/constitution.md if present and relevant"} knowledge/ documents before drafting. Ground decisions in the existing code. Clarify blocking questions with the user and mark unresolved ones [blocking]. Edit requirements only through spec_update, never by writing spec files directly. Preserve stable AC-n IDs; retire IDs with strikethrough. Fix the readiness findings spec_status reports, call spec_request_approval, and stop. You cannot approve${base ? "" : " or change approval files"}.`,
  implementation:
    "Implement only the approved acceptance criteria. Use to-tasks: every task references active AC-n IDs, dependencies, and a concrete verification step; every active criterion is covered. Use spec_update_tasks, then spec_set_status to enter in-progress. Work one task at a time and record passing verification before marking it passed. Never weaken requirements to match code. On scope changes, stop and use evolve-spec: unchanged requirements can continue, changed criteria require reapproval, completed/new scope requires a superseding spec. Mark implemented only after all tasks pass. Do not mark done.",
  test: "Verify the implemented requirements. Use to-test-plan: map every active AC-n to automated verification or explicit manual steps and expected results; write test-plan.md through spec_write_artifact. Add or update tests, run the applicable checks, and record evidence with the current requirements hash, task hash, and tested code checkpoint. Manual evidence requires human confirmation. Failed acceptance returns the spec to in-progress. Mark done only when every criterion has current passing evidence. Do not change production behavior or requirements to make checks pass. A push or PR is optional, never automatic.",
  researcher: `Answer focused research questions using read-only tools. Read ${base ? "the relevant" : "the constitution and relevant"} knowledge/ material. Cite files and symbols, distinguish verified facts from inference, and cover affected clients/providers. Do not edit files, change status, or launch unrestricted work.`,
  verifier:
    "Review read-only against active AC-n criteria and supplied test evidence. For each criterion report met, partially met, or unmet with file references. Flag scope creep and constraint violations. Report high-confidence findings; do not edit files or change spec status. The Test role runs checks and records evidence.",
});

export function specInstructions(document: SpecDocument, role: SpecRole) {
  const base = document.layout === "base";
  const workflow = base
    ? "Use the spec service tools to change status, tasks, evidence and approval. Follow the workflow documented in this repository (its agent instructions and specs/_template.md): it wins over generic guidance here, so keep the template's sections and structure. You may write the BASE files prd.md, tech-analysis.md and status.json beside spec.md with spec_write_artifact. Par3 keeps the frontmatter status line in sync with the lifecycle status. After editing spec files, call spec_validate to run the project's validators and fix every error it reports before requesting approval."
    : "Never write status.json, tasks.json, or approval.json directly. Use the spec service tools.";
  return `<par3_spec_workflow>\nRole: ${role}\nSpec: specs/${document.slug}/spec.md\nCheckout: ${document.workspacePath}\nStatus: ${document.status}; revision: ${document.revision}\nRequirements SHA-256: ${document.specHash}\nTask-definition SHA-256: ${document.taskHash}\n${roles(base)[role]}\nUse spec_status to read the current document and allowed work. Status lifecycle: draft -> review -> approved -> in-progress -> implemented -> done; blocked/rejected require resolution. Human approval is separate from starting implementation, is local to this checkout/environment, and is invalidated by requirements${base ? "" : " or constitution"} changes. ${workflow} A child task inherits this spec and role; changing checkout requires approval there. Never clear the binding, approve yourself, or bypass restrictions through another thread.\n</par3_spec_workflow>`;
}

/**
 * For a thread a person asked to start a spec: it has no spec yet, so the agent chooses the
 * folder name and creates the draft itself, then carries on as the requirements role.
 */
export function specIntakeInstructions(input: {
  readonly layout: SpecLayout;
  readonly workspacePath: string;
  readonly year: string;
}) {
  const base = input.layout === "base";
  const naming = base
    ? `Name the spec folder KEY-123_short-kebab: a ticket key in capitals, a dash, the ticket number, an underscore, then lowercase words separated by single hyphens (at most 80 characters in all). Use the ticket key found in the user's message. If there is none, ask the user for it with your question tool before creating anything, and offer ${input.year}-short-kebab as the fallback; never invent a key. Read specs/_template.md first and start the content from it, keeping its sections and structure. This repository's documented BASE workflow (its agent instructions) wins over generic guidance here.`
    : "Name the spec folder with lowercase words separated by single hyphens, such as dark-mode-toggle (at most 80 characters). Read specs/constitution.md if present. Start the content with the sections Summary, Scope, Users and scenarios, Acceptance criteria (numbered AC-1, AC-2, …), Constraints, Open questions and Design notes.";
  return `<par3_spec_workflow>\nRole: requirements (new spec)\nCheckout: ${input.workspacePath}\nThis thread has no spec yet, and the user's message is the request to start one. Turn it into requirements, never implementation. Read the relevant code${base ? " and knowledge/ documents" : ""} first and ask the user about anything blocking before you draft.\n${naming}\nCreate the draft with spec_create (title, slug, content). You cannot write files yourself; spec_create writes the spec and binds this thread to it as the requirements role. If it fails, read the message and correct the slug or content. After it succeeds, use spec_status, fix the readiness findings with spec_update,${base ? " run spec_validate and fix every error it reports," : ""} call spec_request_approval, and stop. Preserve stable AC-n IDs. You cannot approve, and a person reviews the spec before any code is written.\n</par3_spec_workflow>`;
}
