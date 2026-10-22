import { describe, expect, it } from "vite-plus/test";

import { abortCopy, conflictChoices, operationOutcomeMessage } from "./mergeConflictChoices";

describe("conflictChoices", () => {
  it("offers a side each, labelling the one that deletes the file", () => {
    expect(conflictChoices({ kind: "both-modified" }).map((choice) => choice.label)).toEqual([
      "Accept ours",
      "Accept theirs",
    ]);
    expect(conflictChoices({ kind: "deleted-by-us" }).map((choice) => choice.label)).toEqual([
      "Accept ours (delete)",
      "Accept theirs",
    ]);
  });

  it("puts git's recorded resolution first, within three choices", () => {
    const choices = conflictChoices({ kind: "both-modified", rerereResolved: true });
    expect(choices).toHaveLength(3);
    expect(choices[0]!.resolution).toEqual({ _tag: "workingCopy" });
  });

  it("never offers the recorded resolution for a file-level-only file", () => {
    expect(
      conflictChoices({ kind: "both-modified", rerereResolved: true, fileLevelReason: "filter" }),
    ).toHaveLength(2);
  });
});

describe("copy", () => {
  it("warns that aborting can discard uncommitted edits", () => {
    expect(abortCopy("merge").message).toContain("uncommitted edits");
    expect(abortCopy("rebase").confirmText).toBe("Abort rebase");
  });

  it("describes each outcome", () => {
    expect(operationOutcomeMessage("merge", "completed")).toBe("The merge is complete.");
    expect(operationOutcomeMessage(null, "conflicts")).toContain("next step");
  });
});
