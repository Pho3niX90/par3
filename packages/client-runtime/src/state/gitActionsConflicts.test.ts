import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMenuItems, getGitActionDisabledReason, resolveQuickAction } from "./gitActions.ts";

const status = (overrides: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 1,
  behindCount: 0,
  pr: null,
  ...overrides,
});

describe("git actions during a merge, rebase, cherry-pick or revert", () => {
  const conflicted = status({
    operation: { kind: "merge" },
    conflicts: [{ path: "a.ts", kind: "both-modified" }],
    conflictCount: 12,
  });

  it("turns the quick action into resolving, counting past the capped list", () => {
    expect(resolveQuickAction(conflicted, false)).toEqual({
      label: "Resolve conflicts (12)",
      disabled: false,
      kind: "resolve_conflicts",
    });
  });

  it("offers to continue when nothing is left to resolve", () => {
    expect(resolveQuickAction(status({ operation: { kind: "cherry-pick" } }), false)).toMatchObject(
      {
        label: "Continue cherry-pick",
        kind: "resolve_conflicts",
      },
    );
  });

  it("disables commit, push and change request items and explains why", () => {
    const items = buildMenuItems(conflicted, false, true);
    expect(items.every((item) => item.disabled)).toBe(true);
    expect(
      getGitActionDisabledReason({
        item: items[0]!,
        gitStatus: conflicted,
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Finish resolving the merge conflicts first.");
  });

  it("is unchanged for a server that reports no operation", () => {
    expect(resolveQuickAction(status(), false).kind).not.toBe("resolve_conflicts");
  });
});
