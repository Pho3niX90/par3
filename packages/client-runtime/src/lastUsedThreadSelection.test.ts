import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  MAX_LAST_USED_PROJECTS,
  recordLastUsedThreadSelection,
  resolveNewThreadSeed,
  type LastUsedThreadSelection,
} from "./lastUsedThreadSelection.ts";

const selection = (model: string, overrides?: Partial<LastUsedThreadSelection>) =>
  ({
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    ...overrides,
  }) satisfies LastUsedThreadSelection;

describe("recordLastUsedThreadSelection", () => {
  it("returns the same reference when the latest entry is unchanged", () => {
    const current = recordLastUsedThreadSelection({}, "p1", selection("a"));
    expect(recordLastUsedThreadSelection(current, "p1", selection("a"))).toBe(current);
  });

  it("moves a re-recorded project to the end and replaces its value", () => {
    let current = recordLastUsedThreadSelection({}, "p1", selection("a"));
    current = recordLastUsedThreadSelection(current, "p2", selection("b"));
    current = recordLastUsedThreadSelection(current, "p1", selection("c"));
    expect(Object.keys(current)).toEqual(["p2", "p1"]);
    expect(current.p1?.modelSelection.model).toBe("c");
  });

  it("re-recording an unchanged older project still refreshes its recency", () => {
    let current = recordLastUsedThreadSelection({}, "p1", selection("a"));
    current = recordLastUsedThreadSelection(current, "p2", selection("b"));
    current = recordLastUsedThreadSelection(current, "p1", selection("a"));
    expect(Object.keys(current)).toEqual(["p2", "p1"]);
  });

  it("drops the stalest projects past the cap", () => {
    let current = {};
    for (let index = 0; index < MAX_LAST_USED_PROJECTS + 3; index += 1) {
      current = recordLastUsedThreadSelection(current, `p${index}`, selection("a"));
    }
    const keys = Object.keys(current);
    expect(keys).toHaveLength(MAX_LAST_USED_PROJECTS);
    expect(keys[0]).toBe("p3");
  });

  it("ignores an empty project key", () => {
    const current = {};
    expect(recordLastUsedThreadSelection(current, "", selection("a"))).toBe(current);
  });
});

describe("resolveNewThreadSeed", () => {
  const environmentDefaults = {
    defaultModelSelection: null,
    defaultModelSelectionSource: "environment",
    defaultRuntimeMode: "full-access",
    defaultRuntimeModeSource: "environment",
  } as const;

  it("falls back to defaults without a last-used entry", () => {
    expect(resolveNewThreadSeed({ lastUsed: null, ...environmentDefaults })).toEqual({
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: null,
    });
  });

  it("uses the last-used entry over environment-wide defaults", () => {
    const lastUsed = selection("a");
    expect(
      resolveNewThreadSeed({
        lastUsed,
        ...environmentDefaults,
        defaultModelSelection: selection("env").modelSelection,
      }),
    ).toEqual({
      modelSelection: lastUsed.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
  });

  it("keeps defaults the user set for this project", () => {
    const projectModel = selection("pinned").modelSelection;
    expect(
      resolveNewThreadSeed({
        lastUsed: selection("a"),
        defaultModelSelection: projectModel,
        defaultModelSelectionSource: "project",
        defaultRuntimeMode: "auto-accept-edits",
        defaultRuntimeModeSource: "t3.json",
      }),
    ).toMatchObject({ modelSelection: projectModel, runtimeMode: "auto-accept-edits" });
  });
});
