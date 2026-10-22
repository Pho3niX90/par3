import {
  EnvironmentId,
  MergeConflictError,
  ProviderInstanceId,
  ThreadId,
  type MergeConflictAutoResolveInput,
  type MergeConflictListResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as MergeConflictService from "../../../vcs/MergeConflictService.ts";
import * as ThreadRepositories from "../../../vcs/ThreadRepositories.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ConflictsHandlers from "./handlers.ts";
import { ConflictsToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread:conflicts");
const WORKSPACE = "/work/app";

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:conflicts"),
  requestNamespace: "provider:conflicts",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider:conflicts",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const LIST: MergeConflictListResult = {
  operation: { kind: "merge" },
  labels: { ours: "main", theirs: "feature" },
  conflicts: [
    {
      path: "a.ts",
      kind: "both-modified",
      expected: { stages: { base: "b", ours: "o", theirs: "t" }, workingCopyHash: "w" },
    },
  ],
  conflictCount: 1,
};

const makeHarness = Effect.fn("makeConflictsToolkitHarness")(function* (
  options: {
    readonly children?: ReadonlyArray<{ cwd: string; relativePath: string }>;
    readonly worktreePath?: string | null;
    readonly failList?: MergeConflictError;
  } = {},
) {
  const listed = yield* Ref.make<ReadonlyArray<string>>([]);
  const resolved = yield* Ref.make<ReadonlyArray<MergeConflictAutoResolveInput>>([]);
  const shell = { ...liveThreadShell(THREAD_ID), worktreePath: options.worktreePath ?? null };
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell),
      getProjectThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeed(Option.some({ workspaceRoot: WORKSPACE } as never)),
    }),
    Layer.mock(ThreadRepositories.ThreadRepositories)({
      list: () => Effect.succeed({ repositories: options.children ?? [] }),
    }),
    Layer.mock(MergeConflictService.MergeConflictService)({
      list: ({ cwd }) =>
        Ref.update(listed, (calls) => [...calls, cwd]).pipe(
          Effect.andThen(options.failList ? Effect.fail(options.failList) : Effect.succeed(LIST)),
        ),
      autoResolve: (input) =>
        Ref.update(resolved, (calls) => [...calls, input]).pipe(
          Effect.as({ resolved: ["a.ts"], skipped: [], remaining: 0 }),
        ),
    }),
  );
  const toolkit = yield* ConflictsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ConflictsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  const call = <Name extends keyof typeof ConflictsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration", "worktree"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ConflictsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(layerDependencies),
    );
  return { call, listed, resolved };
});

describe("conflicts toolkit", () => {
  it.effect("reports the conflicts of the thread's own folder", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("t3_conflicts_status", {});
      expect(result).toMatchObject({
        repository: WORKSPACE,
        repositories: [WORKSPACE],
        conflictCount: 1,
        operation: { kind: "merge" },
      });
      expect(yield* Ref.get(harness.listed)).toEqual([WORKSPACE]);
    }),
  );

  it.effect("uses the thread's worktree rather than the project root", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ worktreePath: "/work/wt" });
      yield* harness.call("t3_conflicts_status", {});
      expect(yield* Ref.get(harness.listed)).toEqual(["/work/wt"]);
    }),
  );

  it.effect("refuses a credential without the worktree capability, before touching git", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const denied = yield* harness.call("t3_conflicts_status", {}, ["orchestration"]);
      expect(denied).toMatchObject({ code: "capability_denied" });
      expect(yield* Ref.get(harness.listed)).toEqual([]);
    }),
  );

  describe("a thread that works in several repositories", () => {
    const children = [
      { cwd: "/work/app/api", relativePath: "api" },
      { cwd: "/work/app/web", relativePath: "web" },
    ];

    it.effect("asks which one, naming them", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ children });
        const result = yield* harness.call("t3_conflicts_status", {});
        expect(result).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("/work/app/api"),
        });
        expect(yield* Ref.get(harness.listed)).toEqual([]);
      }),
    );

    it.effect("takes a repository by absolute or relative path", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ children });
        yield* harness.call("t3_conflicts_status", { repository: "web" });
        yield* harness.call("t3_conflicts_status", { repository: "/work/app/api" });
        expect(yield* Ref.get(harness.listed)).toEqual(["/work/app/web", "/work/app/api"]);
      }),
    );

    it.effect("rejects a path that is not one of the thread's repositories", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ children });
        for (const repository of ["/etc", "../elsewhere", "/work/app/api/../../../etc"]) {
          const result = yield* harness.call("t3_conflicts_auto_resolve", { repository });
          expect(result).toMatchObject({ code: "invalid_request" });
        }
        expect(yield* Ref.get(harness.resolved)).toEqual([]);
      }),
    );

    it.effect("uses the only child repository when none is named", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ children: [children[0]!] });
        yield* harness.call("t3_conflicts_status", {});
        expect(yield* Ref.get(harness.listed)).toEqual(["/work/app/api"]);
      }),
    );
  });

  it.effect("auto-resolves in the thread's repository and passes the paths through", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("t3_conflicts_auto_resolve", { paths: ["a.ts"] });
      expect(result).toEqual({
        repository: WORKSPACE,
        resolved: ["a.ts"],
        skipped: [],
        remaining: 0,
      });
      expect(yield* Ref.get(harness.resolved)).toEqual([{ cwd: WORKSPACE, paths: ["a.ts"] }]);
    }),
  );

  it.effect("passes the service's own wording on, and nothing else about a failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        failList: new MergeConflictError({
          reason: "no-operation",
          detail: "There is no merge, rebase, cherry-pick or revert in progress.",
        }),
      });
      const result = yield* harness.call("t3_conflicts_status", {});
      expect(result).toMatchObject({
        code: "invalid_request",
        message: "There is no merge, rebase, cherry-pick or revert in progress.",
      });
    }),
  );

  it("tells agents to auto-resolve first and not to finish the operation", () => {
    const status = ConflictsToolkit.tools.t3_conflicts_status.description ?? "";
    const autoResolve = ConflictsToolkit.tools.t3_conflicts_auto_resolve.description ?? "";
    expect(status).toContain("t3_conflicts_auto_resolve");
    expect(status).toContain("Do not continue, commit or abort");
    expect(autoResolve).toContain("before resolving anything by hand");
    expect(autoResolve).toContain("never continues, commits or aborts");
  });
});
