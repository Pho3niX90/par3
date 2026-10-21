import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useDiffPanelSessionStore, useDiffPanelStore } from "./diffPanelStore";
import { RunId } from "@t3tools/contracts";
import { selectThreadDiffPanelSelection } from "./diffPanelStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      repositoryByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  });

  it("retains fold choices when a panel consumer returns with fresh defaults", () => {
    const scopeKey = "environment-1:thread-1:branch";
    const defaults = new Set(["src/app.ts", "src/index.ts"]);
    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, defaults, (current) => {
      const next = new Set(current);
      next.delete("src/app.ts");
      return next;
    });

    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(["src/index.ts"]),
    );

    useDiffPanelSessionStore.getState().updateCollapsedFileKeys(scopeKey, new Set(), (current) => {
      const next = new Set(current);
      next.delete("src/index.ts");
      return next;
    });
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );

    useDiffPanelSessionStore
      .getState()
      .updateCollapsedFileKeys(scopeKey, defaults, (current) => current);
    expect(useDiffPanelSessionStore.getState().collapsedFileKeysByScopeKey[scopeKey]).toEqual(
      new Set(),
    );
    expect(defaults).toEqual(new Set(["src/app.ts", "src/index.ts"]));
  });
  it("drops the picked base ref when another child repository is chosen", () => {
    const store = useDiffPanelStore.getState();
    store.selectRepository(THREAD_REF, "/work/apis");
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectRepository(THREAD_REF, "/work/config");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"));
    store.selectGitScope(THREAD_REF, "branch");

    const state = useDiffPanelStore.getState();
    expect(Object.values(state.repositoryByThreadKey)).toEqual(["/work/config"]);
    expect(selectThreadDiffPanelSelection(state.byThreadKey, THREAD_REF)).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });
});
