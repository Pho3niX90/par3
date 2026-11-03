import { EnvironmentId, type SyncBaseline, type SyncSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type PlannedOp,
  planConflictResolution,
  planSync,
  runSyncPlan,
  type SyncEnvironmentView,
} from "./plan.ts";

const A = EnvironmentId.make("a");
const B = EnvironmentId.make("b");
const C = EnvironmentId.make("c");
const KEY = "claude.agents:agents/reviewer.md";

interface ItemState {
  readonly hash?: string | null;
  readonly base?: SyncBaseline;
  readonly skipped?: "binary";
}

function env(
  environmentId: EnvironmentId,
  state: ItemState,
  options: {
    readonly categories?: ReadonlyArray<string>;
    readonly excluded?: ReadonlyArray<string>;
    readonly enabled?: boolean;
  } = {},
): SyncEnvironmentView {
  const snapshot: SyncSnapshot = {
    participation:
      options.enabled === false
        ? null
        : {
            enabled: true,
            categories: [...(options.categories ?? ["claude.agents"])],
            excluded: [...(options.excluded ?? [])],
            decidedAt: "2026-10-21T00:00:00.000Z",
          },
    categories: [{ id: "claude.agents", label: "Claude agents", available: true }],
    items:
      state.hash === undefined || state.hash === null
        ? []
        : [
            {
              key: KEY,
              categoryId: "claude.agents",
              name: "agents/reviewer.md",
              hash: state.hash,
              byteLength: 10,
              ...(state.skipped === undefined ? {} : { skipped: state.skipped }),
            },
          ],
    baselines: state.base === undefined ? {} : { [KEY]: state.base },
    seq: 1,
  };
  return { environmentId, snapshot };
}

const opsFor = (plan: ReturnType<typeof planSync>, environmentId: EnvironmentId) =>
  plan.opsByEnvironment.get(environmentId) ?? [];

describe("planSync", () => {
  it("copies an item to a joining machine that lacks it", () => {
    const plan = planSync([env(A, { hash: "h1", base: { hash: "h1", rev: 1 } }), env(B, {})]);
    expect(opsFor(plan, B)).toEqual([
      {
        key: KEY,
        expectedHash: null,
        action: { _tag: "write", sourceEnvironmentId: A },
        baseline: { hash: "h1", rev: 1 },
      },
    ]);
    expect(opsFor(plan, A)).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("adopts an identical file on a joining machine without rewriting it", () => {
    const plan = planSync([
      env(A, { hash: "h1", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h1" }),
    ]);
    expect(opsFor(plan, B).map((op) => op.action._tag)).toEqual(["adopt"]);
  });

  it("treats a joining machine's different file as a conflict", () => {
    const plan = planSync([
      env(A, { hash: "h1", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h2" }),
    ]);
    expect(plan.conflicts.map((conflict) => conflict.key)).toEqual([KEY]);
    expect(plan.opsByEnvironment.size).toBe(0);
  });

  it("starts a new item at revision one and shares it", () => {
    const plan = planSync([env(A, { hash: "h1" }), env(B, {})]);
    expect(opsFor(plan, A)).toEqual([
      { key: KEY, expectedHash: "h1", action: { _tag: "adopt" }, baseline: { hash: "h1", rev: 1 } },
    ]);
    expect(opsFor(plan, B)[0]?.action).toEqual({ _tag: "write", sourceEnvironmentId: A });
  });

  it("moves an edit made on one machine to the others with a new revision", () => {
    const plan = planSync([
      env(A, { hash: "h2", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h1", base: { hash: "h1", rev: 1 } }),
    ]);
    expect(opsFor(plan, B)[0]).toMatchObject({
      expectedHash: "h1",
      baseline: { hash: "h2", rev: 2 },
      action: { _tag: "write", sourceEnvironmentId: A },
    });
    expect(opsFor(plan, A)[0]?.action).toEqual({ _tag: "adopt" });
  });

  it("adopts the same edit made on both machines", () => {
    const plan = planSync([
      env(A, { hash: "h2", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h2", base: { hash: "h1", rev: 1 } }),
    ]);
    expect(plan.conflicts).toEqual([]);
    expect([...opsFor(plan, A), ...opsFor(plan, B)].map((op) => op.action._tag)).toEqual([
      "adopt",
      "adopt",
    ]);
  });

  it("reports different edits on two machines as a conflict", () => {
    const plan = planSync([
      env(A, { hash: "h2", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h3", base: { hash: "h1", rev: 1 } }),
    ]);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("reports an edit against a deletion as a conflict", () => {
    const plan = planSync([
      env(A, { base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h2", base: { hash: "h1", rev: 1 } }),
    ]);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("propagates a deletion as a tombstone", () => {
    const plan = planSync([
      env(A, { base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h1", base: { hash: "h1", rev: 1 } }),
    ]);
    expect(opsFor(plan, B)).toEqual([
      {
        key: KEY,
        expectedHash: "h1",
        action: { _tag: "delete" },
        baseline: { hash: null, rev: 2 },
      },
    ]);
  });

  it("does not let a joining machine bring a deleted item back", () => {
    const plan = planSync([
      env(A, { base: { hash: null, rev: 2 } }),
      env(B, { base: { hash: null, rev: 2 } }),
      env(C, { hash: "h1" }),
    ]);
    expect(plan.conflicts.map((conflict) => conflict.key)).toEqual([KEY]);
  });

  it("fast-forwards a machine that was offline while two others moved on", () => {
    const plan = planSync([
      env(A, { hash: "h3", base: { hash: "h3", rev: 3 } }),
      env(B, { hash: "h3", base: { hash: "h3", rev: 3 } }),
      env(C, { hash: "h1", base: { hash: "h1", rev: 1 } }),
    ]);
    expect(opsFor(plan, C)[0]).toMatchObject({
      expectedHash: "h1",
      baseline: { hash: "h3", rev: 3 },
      action: { _tag: "write" },
    });
    expect(plan.conflicts).toEqual([]);
  });

  it("reports two groups that reached the same revision separately as a conflict", () => {
    const plan = planSync([
      env(A, { hash: "h2", base: { hash: "h2", rev: 2 } }),
      env(C, { hash: "h3", base: { hash: "h3", rev: 2 } }),
    ]);
    expect(plan.conflicts).toHaveLength(1);
  });

  it("leaves out machines that excluded the item, skipped it, or do not sync its category", () => {
    const source = env(A, { hash: "h1", base: { hash: "h1", rev: 1 } });
    expect(planSync([source, env(B, {}, { excluded: [KEY] })]).opsByEnvironment.size).toBe(0);
    expect(planSync([source, env(B, {}, { categories: [] })]).opsByEnvironment.size).toBe(0);
    expect(planSync([source, env(B, {}, { enabled: false })]).opsByEnvironment.size).toBe(0);
    expect(planSync([source, env(B, { hash: "x", skipped: "binary" })]).conflicts).toEqual([]);
  });

  it("counts items every machine already agrees on", () => {
    const plan = planSync([
      env(A, { hash: "h1", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h1", base: { hash: "h1", rev: 1 } }),
    ]);
    expect(plan.inSync).toBe(1);
    expect(plan.opsByEnvironment.size).toBe(0);
  });
});

describe("planConflictResolution", () => {
  it("settles on the chosen machine's version above every known revision", () => {
    const environments = [
      env(A, { hash: "h2", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h3", base: { hash: "h1", rev: 1 } }),
    ];
    const ops = planConflictResolution(environments, KEY, B);
    expect(ops.get(A)?.[0]).toMatchObject({
      expectedHash: "h2",
      action: { _tag: "write", sourceEnvironmentId: B },
      baseline: { hash: "h3", rev: 2 },
    });
    expect(ops.get(B)?.[0]?.action).toEqual({ _tag: "adopt" });
  });

  it("can delete the item everywhere", () => {
    const ops = planConflictResolution(
      [env(A, { hash: "h2", base: { hash: "h1", rev: 1 } }), env(B, { hash: "h3" })],
      KEY,
      "delete",
    );
    expect([...ops.values()].flat().map((op) => op.action._tag)).toEqual(["delete", "delete"]);
  });

  it("writes merged contents to every machine that lacks them, which none can be read from", async () => {
    const environments = [
      env(A, { hash: "h2", base: { hash: "h1", rev: 1 } }),
      env(B, { hash: "h3", base: { hash: "h1", rev: 1 } }),
      env(C, { hash: "h4", base: { hash: "h1", rev: 1 } }),
    ];
    const ops = planConflictResolution(environments, KEY, { contents: "merged", hash: "h4" });
    expect(ops.get(A)?.[0]).toMatchObject({
      expectedHash: "h2",
      action: { _tag: "content", contents: "merged" },
      baseline: { hash: "h4", rev: 2 },
    });
    expect(ops.get(C)?.[0]?.action).toEqual({ _tag: "adopt" });

    const sent: unknown[] = [];
    await runSyncPlan(ops, {
      read: async () => {
        throw new Error("merged contents are never read from a machine");
      },
      apply: async (_environmentId, batch) => {
        sent.push(...batch.map((op) => op.action));
        return { results: batch.map((op) => ({ key: op.key, status: "applied" })) };
      },
    });
    expect(sent).toContainEqual({ _tag: "write", contents: "merged" });
  });
});

describe("runSyncPlan", () => {
  const writeOp = (sourceEnvironmentId: typeof A, hash: string): PlannedOp => ({
    key: KEY,
    expectedHash: null,
    action: { _tag: "write", sourceEnvironmentId },
    baseline: { hash, rev: 1 },
  });

  it("reads each source once and sends the contents to every target", async () => {
    const reads: string[] = [];
    const applied: Array<[string, unknown]> = [];
    const result = await runSyncPlan(
      new Map([
        [B, [writeOp(A, "h1")]],
        [C, [writeOp(A, "h1")]],
      ]),
      {
        read: async (environmentId, key) => {
          reads.push(`${environmentId}:${key}`);
          return { contents: "body", hash: "h1" };
        },
        apply: async (environmentId, ops) => {
          applied.push([environmentId, ops[0]?.action]);
          return { results: ops.map((op) => ({ key: op.key, status: "applied" })) };
        },
      },
    );
    expect(reads).toEqual([`a:${KEY}`]);
    expect(applied).toEqual([
      ["b", { _tag: "write", contents: "body" }],
      ["c", { _tag: "write", contents: "body" }],
    ]);
    expect(result).toEqual({ applied: 2, stale: 0, rejected: 0, failed: 0 });
  });

  it("skips a write whose source changed since the plan", async () => {
    const result = await runSyncPlan(new Map([[B, [writeOp(A, "h1")]]]), {
      read: async () => ({ contents: "newer", hash: "h9" }),
      apply: async () => {
        throw new Error("nothing should be applied");
      },
    });
    expect(result).toEqual({ applied: 0, stale: 0, rejected: 0, failed: 1 });
  });
});
