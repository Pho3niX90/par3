import { describe, expect, it } from "vite-plus/test";

import { updateFromBaseFailureTitle, updateFromBaseToast } from "./updateFromBase.logic";

describe("updateFromBaseToast", () => {
  it("points a conflicted merge at the Conflicts panel", () => {
    expect(
      updateFromBaseToast({ outcome: "conflicts", mergedRef: "origin/main" }, "feature"),
    ).toEqual({
      type: "info",
      title: "Merging origin/main left conflicts",
      description: "Resolve them in the Conflicts panel.",
    });
  });

  it("says the merge commit is ready to push, and names an up-to-date branch", () => {
    expect(
      updateFromBaseToast({ outcome: "merged", mergedRef: "origin/main" }, "feature"),
    ).toMatchObject({
      type: "success",
      description: "The merge commit is ready to push.",
    });
    expect(
      updateFromBaseToast({ outcome: "up-to-date", mergedRef: "origin/main" }, "feature").title,
    ).toBe("Already up to date");
  });
});

describe("updateFromBaseFailureTitle", () => {
  it("tells a dirty tree from other refusals", () => {
    expect(updateFromBaseFailureTitle("dirty-working-tree")).toBe(
      "Commit or stash your changes first",
    );
    expect(updateFromBaseFailureTitle("operation-in-progress")).toContain("operation in progress");
    expect(updateFromBaseFailureTitle(undefined)).toBe("Could not update from the base branch");
  });
});
