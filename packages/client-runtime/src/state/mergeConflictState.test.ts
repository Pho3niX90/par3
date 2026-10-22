import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasRunningTurnInRepository,
  mergeOperationNoun,
  NO_MERGE_CONFLICT_STATE,
  selectMergeConflictState,
  sumMergeConflictStates,
} from "./mergeConflictState.ts";
import type { EnvironmentThreadShell } from "./models.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

describe("selectMergeConflictState", () => {
  it("is idle for a server that never reports operations", () => {
    expect(selectMergeConflictState(null)).toBe(NO_MERGE_CONFLICT_STATE);
    expect(selectMergeConflictState({})).toBe(NO_MERGE_CONFLICT_STATE);
  });

  it("counts from conflictCount, since the listed conflicts are capped", () => {
    expect(
      selectMergeConflictState({
        operation: { kind: "rebase" },
        conflicts: [{ path: "a", kind: "both-modified" }],
        conflictCount: 450,
      }),
    ).toEqual({
      operation: "rebase",
      conflictCount: 450,
      canContinue: false,
      needsResolution: true,
    });
  });

  it("can continue only once an operation has nothing left to resolve", () => {
    expect(selectMergeConflictState({ operation: { kind: "merge" } }).canContinue).toBe(true);
    expect(
      selectMergeConflictState({ conflicts: [{ path: "a", kind: "both-added" }] }),
    ).toMatchObject({
      operation: null,
      conflictCount: 1,
      canContinue: false,
      needsResolution: true,
    });
  });
});

describe("sumMergeConflictStates", () => {
  it("adds repositories and continues only when none has conflicts", () => {
    const merging = selectMergeConflictState({ operation: { kind: "merge" }, conflictCount: 2 });
    const done = selectMergeConflictState({ operation: { kind: "merge" } });
    expect(sumMergeConflictStates([merging, done])).toMatchObject({
      conflictCount: 2,
      canContinue: false,
    });
    expect(sumMergeConflictStates([done, done])).toMatchObject({ canContinue: true });
    expect(sumMergeConflictStates([NO_MERGE_CONFLICT_STATE])).toBe(NO_MERGE_CONFLICT_STATE);
  });
});

describe("hasRunningTurnInRepository", () => {
  const project = { environmentId, id: projectId, workspaceRoot: "/work/repo" };
  const thread = (
    overrides: Partial<Pick<EnvironmentThreadShell, "worktreePath" | "archivedAt">> & {
      readonly status?: "running" | "idle" | "waiting";
    } = {},
  ) =>
    ({
      environmentId,
      projectId,
      worktreePath: overrides.worktreePath ?? null,
      archivedAt: overrides.archivedAt ?? null,
      runtime: { status: overrides.status ?? "running" },
    }) as Pick<
      EnvironmentThreadShell,
      "environmentId" | "projectId" | "worktreePath" | "runtime" | "archivedAt"
    >;
  const check = (cwd: string, threads: ReadonlyArray<ReturnType<typeof thread>>) =>
    hasRunningTurnInRepository({ environmentId, cwd, threads, projects: [project] });

  it("matches a thread working in the project root or the repository's worktree", () => {
    expect(check("/work/repo", [thread()])).toBe(true);
    expect(check("/work/wt", [thread({ worktreePath: "/work/wt" })])).toBe(true);
    expect(check("/work/wt", [thread()])).toBe(false);
  });

  it("matches a parent folder of a child repository and the reverse", () => {
    expect(check("/work/repo/child", [thread()])).toBe(true);
    expect(check("/work", [thread()])).toBe(true);
    expect(check("/work/repo-two", [thread()])).toBe(false);
  });

  it("ignores idle, archived and other-environment threads, and tolerates separators", () => {
    expect(check("/work/repo", [thread({ status: "idle" })])).toBe(false);
    expect(check("/work/repo", [thread({ archivedAt: "2026-01-01T00:00:00.000Z" })])).toBe(false);
    expect(
      hasRunningTurnInRepository({
        environmentId: EnvironmentId.make("other"),
        cwd: "/work/repo",
        threads: [thread()],
        projects: [project],
      }),
    ).toBe(false);
    expect(check("C:\\work\\repo\\", [thread({ worktreePath: "C:/work/repo" })])).toBe(true);
  });

  it("counts a thread waiting on the user, since it resumes on its own", () => {
    expect(check("/work/repo", [thread({ status: "waiting" })])).toBe(true);
  });
});

describe("mergeOperationNoun", () => {
  it("names the operation", () => {
    expect(mergeOperationNoun("cherry-pick")).toBe("cherry-pick");
    expect(mergeOperationNoun(null)).toBe("conflict resolution");
  });
});
