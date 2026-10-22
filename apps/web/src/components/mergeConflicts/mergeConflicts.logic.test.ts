import { describe, expect, it } from "vite-plus/test";

import {
  abortConfirmation,
  conflictRowActions,
  continueOutcomeToast,
  fileMergePreviewPath,
  EMPTY_RESOLVED_IN_OPERATION,
  forgetResolved,
  mutationBlockedReason,
  operationSignature,
  recordResolved,
  sideDescriptions,
  sideOutcome,
  visibleResolved,
} from "./mergeConflicts.logic";

describe("sideOutcome", () => {
  it("says delete when the chosen side has no file", () => {
    expect(sideOutcome("deleted-by-us", "ours")).toBe("delete");
    expect(sideOutcome("deleted-by-us", "theirs")).toBe("keep");
    expect(sideOutcome("deleted-by-them", "theirs")).toBe("delete");
    expect(sideOutcome("added-by-us", "theirs")).toBe("delete");
    expect(sideOutcome("added-by-them", "ours")).toBe("delete");
    expect(sideOutcome("both-modified", "ours")).toBe("keep");
    expect(sideOutcome("both-deleted", "theirs")).toBe("delete");
  });
});

describe("conflictRowActions", () => {
  it("offers merging only for text files both sides have", () => {
    expect(conflictRowActions({ kind: "both-modified" }).canMerge).toBe(true);
    expect(conflictRowActions({ kind: "both-added" }).canMerge).toBe(true);
    expect(conflictRowActions({ kind: "deleted-by-us" }).canMerge).toBe(false);
  });

  it("limits file-level-only files to choosing a side", () => {
    const actions = conflictRowActions({
      kind: "both-modified",
      fileLevelReason: "filter",
      rerereResolved: true,
    });
    expect(actions.canMerge).toBe(false);
    expect(actions.canUseRecordedResolution).toBe(false);
    expect(actions.ours.label).toBe("Accept ours");
  });

  it("offers git's recorded resolution only for a file without markers", () => {
    expect(
      conflictRowActions({ kind: "both-modified", rerereResolved: true }).canUseRecordedResolution,
    ).toBe(true);
    expect(
      conflictRowActions({ kind: "both-modified", rerereResolved: false }).canUseRecordedResolution,
    ).toBe(false);
    expect(conflictRowActions({ kind: "both-modified" }).canUseRecordedResolution).toBe(false);
  });

  it("labels a deleting choice", () => {
    expect(conflictRowActions({ kind: "deleted-by-them" }).theirs.label).toBe(
      "Accept theirs (delete)",
    );
  });
});

describe("side descriptions and copy", () => {
  it("explains the swapped rebase sides", () => {
    expect(sideDescriptions("rebase").ours).toContain("rebased onto");
    expect(sideDescriptions("merge").ours).toBe("Current branch");
  });

  it("warns that aborting can discard uncommitted edits", () => {
    const copy = abortConfirmation("merge");
    expect(copy.description).toContain("uncommitted edits");
    expect(copy.confirmLabel).toBe("Abort merge");
  });

  it("reports each continue outcome", () => {
    expect(continueOutcomeToast("rebase", "completed").type).toBe("success");
    expect(continueOutcomeToast("rebase", "conflicts").title).toBe("Next step has conflicts");
    expect(continueOutcomeToast("merge", "paused").type).toBe("info");
  });
});

describe("mutationBlockedReason", () => {
  it("blocks without permission or while a turn runs in the repository", () => {
    expect(
      mutationBlockedReason({ canWriteSourceControl: true, turnRunningInRepository: false }),
    ).toBe(null);
    expect(
      mutationBlockedReason({ canWriteSourceControl: false, turnRunningInRepository: false }),
    ).toContain("cannot change source control");
    expect(
      mutationBlockedReason({ canWriteSourceControl: true, turnRunningInRepository: true }),
    ).toContain("agent is working");
  });
});

describe("resolved-in-operation list", () => {
  const signature = operationSignature({ kind: "rebase", step: { current: 1, total: 3 } });

  it("accumulates within one step and restarts on the next", () => {
    let state = recordResolved(EMPTY_RESOLVED_IN_OPERATION, signature, "a.ts");
    state = recordResolved(state, signature, "b.ts");
    state = recordResolved(state, signature, "a.ts");
    expect(state.paths).toEqual(["a.ts", "b.ts"]);
    const next = operationSignature({ kind: "rebase", step: { current: 2, total: 3 } });
    expect(recordResolved(state, next, "c.ts").paths).toEqual(["c.ts"]);
  });

  it("hides entries from another step, a finished operation, and files conflicted again", () => {
    const state = recordResolved(EMPTY_RESOLVED_IN_OPERATION, signature, "a.ts");
    expect(visibleResolved(state, signature, [])).toEqual(["a.ts"]);
    expect(visibleResolved(state, signature, ["a.ts"])).toEqual([]);
    expect(visibleResolved(state, operationSignature(undefined), [])).toEqual([]);
    expect(visibleResolved(state, "merge:0", [])).toEqual([]);
  });

  it("forgets a reopened path", () => {
    const state = recordResolved(EMPTY_RESOLVED_IN_OPERATION, signature, "a.ts");
    expect(forgetResolved(state, "a.ts").paths).toEqual([]);
  });
});

describe("fileMergePreviewPath", () => {
  it("keeps the path for the workspace root and prefixes a child repository", () => {
    expect(fileMergePreviewPath("/work/app", "/work/app", "src/a.ts")).toBe("src/a.ts");
    expect(fileMergePreviewPath("/work/app/", "/work/app/api", "src/a.ts")).toBe("api/src/a.ts");
    expect(fileMergePreviewPath("C:\\work\\app", "C:/work/app/api", "a.ts")).toBe("api/a.ts");
  });

  it("gives up when the repository is outside the workspace root", () => {
    expect(fileMergePreviewPath("/work/app", "/work/other", "a.ts")).toBeNull();
    expect(fileMergePreviewPath("/work/app", "/work/app-two", "a.ts")).toBeNull();
    expect(fileMergePreviewPath(undefined, "/work/app", "a.ts")).toBeNull();
  });
});
