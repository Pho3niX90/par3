import { describe, expect, it } from "@effect/vitest";
import type { SpecEvidence, SpecTask } from "@t3tools/contracts";

import {
  acceptanceCriteria,
  checkCriterionHistory,
  checkReady,
  checkTasks,
  evidenceComplete,
  taskDefinitions,
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
});
