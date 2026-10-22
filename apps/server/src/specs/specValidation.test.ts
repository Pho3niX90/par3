import { describe, expect, it } from "@effect/vitest";
import type { SpecEvidence, SpecTask } from "@t3tools/contracts";

import {
  acceptanceCriteria,
  baseReadiness,
  checkCriterionHistory,
  checkReady,
  checkTasks,
  evidenceComplete,
  statusAdoptable,
  taskDefinitions,
  templateHeadings,
  transitionAllowed,
} from "./specValidation.ts";

const readySpec = `# Example

## Summary
A concise summary.

## Scope
Included behavior.

## Users and scenarios
The primary user workflow.

## Acceptance criteria
- AC-1: The setting is saved.
- AC-2: The saved setting is restored.

## Constraints
Keep the existing API stable.

## Open questions
None.

## Design notes
Use the existing settings store.
`;

const baseTemplate = `---
id: <slug>
status: draft            # draft | review | approved
---
# <Title>

## Context
Why this exists.

## Acceptance criteria
- [ ] AC-1: Example criterion.

\`\`\`md
## Not a section
\`\`\`

## Open questions   
- [ ] Q1 [HIGH] Example question.

## Assumptions
- [x] Example assumption.
`.replaceAll("\\`", "`");

const baseSpec = `---
id: PROJ-123_short-kebab
status: draft            # draft | review | approved
---
# Example

## Context
See [the design](https://example.test/design) and the table:

| Key | Value |
| --- | ----- |
| a   | b     |

### Sub-heading
Detail under context.

## Acceptance criteria
- [ ] AC-1: The setting is saved.
- [x] AC-2: The saved setting is restored.

## Open questions
- [ ] Q1 [MEDIUM] Which store should hold it?
- [x] Q2 [HIGH] Is a migration needed? (owner: @someone)

## Assumptions
- [x] The store already exists.
- [ ] Nothing else reads the setting.

## Epic checklist
### Epic follow-ups
- [ ] Extra section the template does not have.
`;

const tasks: SpecTask[] = [
  {
    id: "save",
    title: "Save setting",
    acs: ["AC-1"],
    dependsOn: [],
    verify: "Run save check",
    status: "pending",
  },
  {
    id: "restore",
    title: "Restore setting",
    acs: ["AC-2"],
    dependsOn: ["save"],
    verify: "Run restore check",
    status: "pending",
  },
];

describe("spec validation", () => {
  it("accepts a complete requirements document and reports missing or blocked sections", () => {
    expect(checkReady(readySpec)).toEqual([]);
    expect(
      checkReady(
        readySpec.replace("## Constraints\nKeep the existing API stable.", "## Constraints\n\n"),
      ),
    ).toContainEqual(expect.objectContaining({ code: "empty-section" }));
    expect(checkReady(`${readySpec}\n[blocking] Resolve provider ownership.`)).toContainEqual(
      expect.objectContaining({ code: "blocking-question" }),
    );
  });

  it("keeps allocated acceptance criterion IDs stable and retires them explicitly", () => {
    const criteria = acceptanceCriteria("- AC-1: Keep data.\n- ~~AC-2~~: Removed behavior.");
    expect(criteria.map(({ id, retired }) => [id, retired])).toEqual([
      ["AC-1", false],
      ["AC-2", true],
    ]);
    expect(
      checkCriterionHistory(
        "- AC-1: Keep data.\n- AC-3: Existing behavior.",
        "- AC-1: Keep data.\n- AC-3: Existing behavior.\n- AC-2: New behavior.",
      ),
    ).toMatch(/greater/i);
    expect(
      checkCriterionHistory("- AC-1: Keep data.", "- AC-1: Keep data.\n- ~~AC-2~~: Retired."),
    ).toBeUndefined();
    expect(checkCriterionHistory("- ~~AC-2~~: Retired.", "- AC-2: Reused.")).toMatch(/retired/i);
    expect(checkCriterionHistory("- AC-1: Keep data.", "- AC-2: Renumbered.")).toMatch(
      /retain AC-1/i,
    );
  });

  it("accepts a task-list checkbox before a criterion and retires only with strikethrough", () => {
    const criteria = acceptanceCriteria(
      [
        "- [ ] AC-1: Open box.",
        "- [x] AC-2 Ticked box.",
        "* [X] AC-3: Capital X.",
        "- [ ] ~~AC-4~~: Retired open box.",
        "- [x] ~~AC-5~~ Retired ticked box.",
        "- ~~AC-6~~: Retired without a box.",
        "- [ ] Q1 [HIGH] An open question.",
        "- [x] Assumes AC is a known term.",
        "[ ] AC-7 needs a list marker.",
      ].join("\n"),
    );
    expect(criteria.map(({ id, retired }) => [id, retired])).toEqual([
      ["AC-1", false],
      ["AC-2", false],
      ["AC-3", false],
      ["AC-4", true],
      ["AC-5", true],
      ["AC-6", true],
    ]);
    expect(criteria.slice(0, 3).map(({ text }) => text)).toEqual([
      "Open box.",
      "Ticked box.",
      "Capital X.",
    ]);
    expect(
      checkCriterionHistory("- [ ] AC-1: Keep.", "- [x] AC-1: Keep.\n- [ ] AC-2: New."),
    ).toBeUndefined();
    expect(checkCriterionHistory("- [ ] AC-1: Keep.", "- [ ] AC-2: Renumbered.")).toMatch(
      /retain AC-1/i,
    );
    expect(checkTasks("- [ ] AC-1: Save.\n- [x] AC-2: Restore.", tasks)).toBeUndefined();
  });

  it("detects blocking questions behind a list marker and a checkbox", () => {
    for (const line of [
      "[blocking] Q",
      "- [blocking] Q",
      "- [ ] [blocking] Q",
      "* [x] [blocking] Q",
    ]) {
      expect(checkReady(`${readySpec}\n${line}`)).toContainEqual(
        expect.objectContaining({ code: "blocking-question" }),
      );
    }
    expect(checkReady(`${readySpec}\n- [ ] Q1 [HIGH] Open question.`)).toEqual([]);
  });

  it("requires task coverage and a valid acyclic dependency graph", () => {
    expect(checkTasks(readySpec, tasks)).toBeUndefined();
    expect(checkTasks(readySpec, [tasks[0]!])).toMatch(/coverage for AC-2/i);
    expect(checkTasks(readySpec, [tasks[0]!, { ...tasks[1]!, dependsOn: ["missing"] }])).toMatch(
      /invalid dependency/i,
    );
    expect(
      checkTasks(readySpec, [
        { ...tasks[0]!, dependsOn: ["third"] },
        { ...tasks[1]!, dependsOn: ["save"] },
        { ...tasks[0]!, id: "third", dependsOn: ["restore"] },
      ]),
    ).toMatch(/cycles/i);
    expect(taskDefinitions(tasks)).toEqual(
      tasks.map(({ status: _status, ...definition }) => definition),
    );
  });

  it("allows only the documented lifecycle transitions for each role", () => {
    expect(transitionAllowed("draft", "review", "requirements")).toBe(true);
    expect(transitionAllowed("approved", "in-progress", "implementation")).toBe(true);
    expect(transitionAllowed("implemented", "done", "test")).toBe(true);
    expect(transitionAllowed("draft", "approved", "human")).toBe(false);
    expect(transitionAllowed("review", "approved", "human")).toBe(true);
    expect(transitionAllowed("implemented", "in-progress", "test")).toBe(true);
  });

  it("requires fresh passing evidence for every active criterion and human confirmation for manual evidence", () => {
    const base = {
      content: "- AC-1: Save.\n- AC-2: Restore.\n- ~~AC-3~~: Retired.",
      specHash: "requirements-v2",
      taskHash: "tasks-v2",
    };
    const evidence: SpecEvidence[] = [
      {
        id: "save",
        acs: ["AC-1"],
        kind: "automated",
        description: "Passed",
        checkpoint: "checkpoint-1",
        requirementsHash: base.specHash,
        taskHash: base.taskHash,
        passed: true,
      },
      {
        id: "restore",
        acs: ["AC-2"],
        kind: "manual",
        description: "Reviewed",
        checkpoint: "checkpoint-2",
        requirementsHash: base.specHash,
        taskHash: base.taskHash,
        passed: true,
        confirmedBy: "reviewer@example.test",
      },
    ];
    expect(evidenceComplete({ ...base, evidence })).toBe(true);
    expect(evidenceComplete({ ...base, evidence: evidence.slice(0, 1) })).toBe(false);
    const { confirmedBy: _confirmedBy, ...unconfirmed } = evidence[1]!;
    expect(evidenceComplete({ ...base, evidence: [unconfirmed] })).toBe(false);
    expect(
      evidenceComplete({
        ...base,
        evidence: [{ ...evidence[0]!, requirementsHash: "stale" }, evidence[1]!],
      }),
    ).toBe(false);
  });

  it("lists every level-2 template heading outside fenced code", () => {
    expect(templateHeadings(baseTemplate)).toEqual([
      "Context",
      "Acceptance criteria",
      "Open questions",
      "Assumptions",
    ]);
    expect(templateHeadings("## A\n### B\n## A\n# C\n")).toEqual(["A"]);
    expect(templateHeadings("# Only a title\n")).toEqual([]);
  });

  it("checks a BASE spec against its template sections and keeps sub-headings in their section", () => {
    const rules = baseReadiness(baseTemplate);
    expect(checkReady(baseSpec, rules)).toEqual([]);
    expect(checkReady(baseSpec.replace("## Epic checklist", "## Something else"), rules)).toEqual(
      [],
    );
    expect(checkReady(baseSpec.replace("## Assumptions", "## Notes"), rules)).toEqual([
      { code: "missing-section", message: "Add the Assumptions section." },
    ]);
    expect(
      checkReady(
        baseSpec.replace(
          /## Context[\s\S]*?## Acceptance criteria/,
          "## Context\n\n### Sub-heading\nDetail.\n\n## Acceptance criteria",
        ),
        rules,
      ),
    ).toEqual([]);
    expect(
      checkReady(
        baseSpec.replace(
          /## Context[\s\S]*?## Acceptance criteria/,
          "## Context\n\n## Acceptance criteria",
        ),
        rules,
      ),
    ).toEqual([{ code: "empty-section", message: "Complete the Context section." }]);
  });

  it("ignores fenced headings and the par3-only sections in a BASE spec", () => {
    expect(
      checkReady("## Context\nText.\n\n- [ ] AC-1: Done.\n", baseReadiness("## Context\n")),
    ).toEqual([]);
    expect(checkReady(baseSpec, baseReadiness("## Summary\n## Scope\n"))).toEqual([
      { code: "missing-section", message: "Add the Summary section." },
      { code: "missing-section", message: "Add the Scope section." },
    ]);
    expect(
      checkReady("```\n## Context\n```\n- [ ] AC-1: Done.\n", baseReadiness("## Context\n")),
    ).toEqual([{ code: "missing-section", message: "Add the Context section." }]);
  });

  it("falls back to acceptance criteria alone when the template is missing", () => {
    const rules = baseReadiness(null);
    expect(checkReady("# Example\nNo criteria.\n", rules)).toEqual([
      { code: "missing-criteria", message: "Add at least one active AC-n acceptance criterion." },
    ]);
    expect(checkReady("[blocking] Anything\n- [ ] AC-1: Done.\n", rules)).toEqual([]);
  });

  it("applies the blocking check to a BASE template's open-questions section only", () => {
    const rules = baseReadiness(baseTemplate);
    const blocked = baseSpec.replace(
      "- [ ] Q1 [MEDIUM] Which store should hold it?",
      "- [ ] [blocking] Which store should hold it?",
    );
    expect(checkReady(blocked, rules)).toEqual([
      expect.objectContaining({ code: "blocking-question" }),
    ]);
    expect(
      checkReady(
        baseSpec.replace("- [ ] Nothing else reads", "- [ ] [blocking] Nothing else reads"),
        rules,
      ),
    ).toEqual([]);
    expect(checkReady(blocked, baseReadiness("## Context\n## Acceptance criteria\n"))).toEqual([]);
  });

  it("blocks review on an open [HIGH] question in a BASE spec, not on resolved or lower ones", () => {
    const rules = baseReadiness(baseTemplate);
    const blocking = [expect.objectContaining({ code: "blocking-question" })];
    const withQuestion = (line: string) =>
      baseSpec.replace("- [ ] Q1 [MEDIUM] Which store should hold it?", line);
    expect(checkReady(baseSpec, rules)).toEqual([]);
    expect(
      checkReady(withQuestion("- [ ] Q1 [HIGH] Which store? (owner: @someone)"), rules),
    ).toEqual(blocking);
    expect(checkReady(withQuestion("* [ ] Q1 [high] Which store?"), rules)).toEqual(blocking);
    expect(checkReady(withQuestion("- [x] Q1 [HIGH] Which store?"), rules)).toEqual([]);
    expect(checkReady(withQuestion("- [ ] Q1 [MEDIUM] Which store?"), rules)).toEqual([]);
    expect(checkReady(withQuestion("- [ ] Q1 [LOW] Which store?"), rules)).toEqual([]);
    expect(checkReady(withQuestion("- [ ] Q1 Which store?"), rules)).toEqual([]);
    // Only the open-questions section counts, and Par3 specs keep their own rule.
    expect(
      checkReady(
        baseSpec.replace("- [ ] Nothing else reads the setting.", "- [ ] [HIGH] Unverified."),
        rules,
      ),
    ).toEqual([]);
    expect(checkReady(`${readySpec}\n- [ ] Q1 [HIGH] Open question.`)).toEqual([]);
  });

  it("adopts a disk status only when no human decision is needed", () => {
    const document = {
      status: "draft" as const,
      approvalValid: false,
      approval: null,
      findings: [],
      content: readySpec,
      tasks: [],
      specHash: "h",
      taskHash: "t",
      evidence: [],
    };
    expect(statusAdoptable(document, "review")).toBe(true);
    expect(
      statusAdoptable({ ...document, findings: [{ code: "x", message: "m" }] }, "review"),
    ).toBe(false);
    expect(statusAdoptable(document, "draft")).toBe(false);
    expect(statusAdoptable(document, "approved")).toBe(false);
    expect(statusAdoptable({ ...document, status: "review" }, "approved")).toBe(false);
    expect(statusAdoptable({ ...document, status: "review" }, "rejected")).toBe(true);
    expect(statusAdoptable(document, "in-progress")).toBe(false);
    expect(statusAdoptable(document, "done")).toBe(false);

    const approved = {
      ...document,
      status: "approved" as const,
      approvalValid: true,
      approval: {
        subject: "s",
        label: "l",
        approvedAt: "now",
        revision: 1,
        specHash: "h",
        constitutionHash: null,
      },
      tasks,
    };
    expect(statusAdoptable(approved, "in-progress")).toBe(true);
    expect(statusAdoptable({ ...approved, approvalValid: false }, "in-progress")).toBe(false);
    expect(statusAdoptable({ ...approved, tasks: [] }, "in-progress")).toBe(false);
    expect(statusAdoptable(approved, "draft")).toBe(false);
    expect(statusAdoptable({ ...approved, status: "in-progress" }, "implemented")).toBe(false);
  });
});
