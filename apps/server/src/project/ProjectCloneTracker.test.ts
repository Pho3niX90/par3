import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  OrchestrationDispatchCommandError,
  PAR3_PROJECT_FILE_SCHEMA_URL,
  ProjectId,
  projectCloneProgressSummary,
  type SourceControlCloneProtocol,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import { ProjectConflictError } from "./ProjectService.ts";
import { parseGitCloneProgressLine } from "./gitCloneProgress.ts";

const projectId = ProjectId.make("project-1");
const startInput = {
  projectId,
  title: "t3code",
  createdAt: "2026-01-01T00:00:00.000Z",
  remoteUrl: "git@github.com:octocat/t3code.git",
  destinationPath: "/workspace/t3code",
};

const trackerLayer = (
  repositories: Layer.Layer<SourceControlRepositoryService.SourceControlRepositoryService>,
) =>
  ProjectCloneTracker.layer.pipe(
    Layer.provide(repositories),
    Layer.provideMerge(NodeServices.layer),
  );

function makeHarness(options?: {
  readonly clone?: SourceControlRepositoryService.SourceControlRepositoryService["Service"]["cloneRepository"];
}) {
  const created: Array<{ projectId: ProjectId; workspaceRoot: string }> = [];
  const cloned: Array<ProjectId> = [];
  const discarded: Array<string> = [];
  const hooks: ProjectCloneTracker.ProjectCloneHooks = {
    createProject: (input) =>
      Effect.sync(() => {
        created.push({ projectId: input.projectId, workspaceRoot: input.workspaceRoot });
      }),
    onCloned: (input) => Effect.sync(() => void cloned.push(input.projectId)),
  };
  const layer = trackerLayer(
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      prepareClone: (input) =>
        Effect.succeed({
          destinationPath: input.destinationPath,
          remoteUrl: (input.remoteUrl ?? "").replace("user:s3cret@", ""),
          cloneUrl: input.remoteUrl ?? "",
          repository: null,
        }),
      cloneRepository:
        options?.clone ??
        ((input) =>
          Effect.succeed({
            cwd: input.destinationPath,
            remoteUrl: input.remoteUrl ?? "",
            repository: null,
          })),
      discardClone: (destination) => Effect.sync(() => void discarded.push(destination)),
    }),
  );
  return { layer, hooks, created, cloned, discarded };
}

describe("ProjectCloneTracker", () => {
  it.effect("creates the project first and reports the clone through the stream", () => {
    const release = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          yield* (
            options?.onProgress?.({ stage: "receiving", percent: 40, detail: "1 MiB" }) ??
              Effect.void
          );
          yield* Deferred.await(release);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const collected = yield* tracker.stream.pipe(
        Stream.takeUntil((clones) => clones[0]?.phase === "done"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const result = yield* tracker.start(startInput, harness.hooks);
      expect(result.cwd).toBe("/workspace/t3code");
      expect(harness.created).toEqual([{ projectId, workspaceRoot: "/workspace/t3code" }]);

      yield* Effect.yieldNow;
      const running = yield* tracker.get(projectId);
      expect(running).toMatchObject({ phase: "running", stage: "receiving", percent: 40 });

      yield* Deferred.succeed(release, undefined);
      const lists = yield* Fiber.join(collected);
      const final = lists.at(-1)?.[0];
      expect(final).toMatchObject({ phase: "done", percent: 100 });
      expect(harness.cloned).toEqual([projectId]);

      yield* TestClock.adjust("31 seconds");
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("flags a clone stalled when git goes quiet and clears it when git speaks", () => {
    const release = Deferred.makeUnsafe<void>();
    const resumed = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          const report = options?.onProgress ?? (() => Effect.void);
          yield* report({ stage: "receiving", percent: 24, detail: "168.80 MiB | 20.69 MiB/s" });
          yield* Deferred.await(resumed);
          yield* report({ stage: "receiving", percent: 25, detail: "170.00 MiB | 1.00 MiB/s" });
          yield* Deferred.await(release);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);

      yield* TestClock.adjust("19 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(false);
      yield* TestClock.adjust("1 second");
      const stalled = yield* tracker.get(projectId);
      expect(stalled).toMatchObject({ stalled: true, percent: 24 });
      expect(projectCloneProgressSummary(stalled!)).toBe("Receiving objects · 24% · Stalled");

      yield* Deferred.succeed(resumed, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ stalled: false, percent: 25 });

      yield* TestClock.adjust("20 seconds");
      expect((yield* tracker.get(projectId))?.stalled).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({ phase: "done", stalled: false });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps a failed clone with git's own explanation and retries it", () => {
    const protocols: Array<SourceControlCloneProtocol | undefined> = [];
    const harness = makeHarness({
      clone: (input) =>
        Effect.suspend(() => {
          protocols.push(input.protocol);
          return protocols.length === 1
            ? Effect.fail(
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: SourceControlProviderKind.make("unknown"),
                  detail: "fatal: repository not found",
                }),
              )
            : Effect.succeed({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
              });
        }),
    });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start({ ...startInput, protocol: "ssh" }, harness.hooks);
      yield* Effect.yieldNow;
      const failed = yield* tracker.get(projectId);
      expect(failed).toMatchObject({ phase: "failed", error: "fatal: repository not found" });

      expect(yield* tracker.retry(projectId)).toBe(true);
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(protocols).toEqual(["ssh", "ssh"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("cancel interrupts the clone and removes the partial checkout", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;

      expect(yield* tracker.cancel(projectId)).toBe(true);
      expect((yield* tracker.get(projectId))?.phase).toBe("cancelled");
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(yield* tracker.retry(projectId)).toBe(true);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("a cancel that lands after git finished keeps the checkout", () => {
    const gate = Deferred.makeUnsafe<void>();
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      onCloned: () => Deferred.await(gate),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(yield* tracker.cancel(projectId)).toBe(false);
      expect(harness.discarded).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("hands git the credential-bearing URL while snapshots carry the redacted one", () => {
    const cloneUrls: Array<string> = [];
    const harness = makeHarness({
      clone: (input) =>
        Effect.sync(() => {
          cloneUrls.push(input.remoteUrl ?? "");
          return { cwd: input.destinationPath, remoteUrl: "", repository: null };
        }),
    });
    const layer = trackerLayer(
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
        prepareClone: (input) =>
          Effect.succeed({
            destinationPath: input.destinationPath,
            remoteUrl: "https://github.com/octocat/t3code.git",
            cloneUrl: "https://user:s3cret@github.com/octocat/t3code.git",
            repository: null,
          }),
        cloneRepository: (input) =>
          Effect.sync(() => {
            cloneUrls.push(input.remoteUrl ?? "");
            return { cwd: input.destinationPath, remoteUrl: "", repository: null };
          }),
        discardClone: () => Effect.void,
      }),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect(result.remoteUrl).toBe("https://github.com/octocat/t3code.git");
      expect(cloneUrls).toEqual(["https://user:s3cret@github.com/octocat/t3code.git"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("discard forgets a project's clone when the project is deleted", () => {
    const harness = makeHarness({ clone: () => Effect.never });
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      yield* tracker.discard(projectId);
      expect(yield* tracker.get(projectId)).toBeNull();
      expect(harness.discarded).toEqual(["/workspace/t3code"]);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("releases the claim when project creation fails", () => {
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: () =>
        Effect.fail(new OrchestrationDispatchCommandError({ message: "workspace root exists" })),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, hooks));
      expect(error.message).toContain("workspace root exists");
      expect(yield* tracker.get(projectId)).toBeNull();
      yield* tracker.start(startInput, harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("clones for the project that already owns the empty destination", () => {
    const owner = ProjectId.make("project-stranded");
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: (input) =>
        Effect.fail(
          new ProjectConflictError({
            projectId: input.projectId,
            workspaceRoot: input.workspaceRoot,
            conflictingProjectId: owner,
          }),
        ),
    };
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(startInput, hooks);
      expect(result.projectId).toBe(owner);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(owner)).toMatchObject({
        projectId: owner,
        destinationPath: "/workspace/t3code",
        phase: "done",
      });
      expect(harness.cloned).toEqual([owner]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("does not create a project when the clone cannot be prepared", () => {
    const harness = makeHarness();
    const layer = trackerLayer(
      Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
        prepareClone: () =>
          Effect.fail(
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: SourceControlProviderKind.make("unknown"),
              detail: "Destination path already exists and is not empty.",
            }),
          ),
      }),
    );
    return Effect.gen(function* () {
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const error = yield* Effect.flip(tracker.start(startInput, harness.hooks));
      expect(error.message).toContain("not empty");
      expect(harness.created).toEqual([]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});

describe("ProjectCloneTracker workspace clones", () => {
  const repositories = [
    { path: "api", remoteUrl: "https://user:s3cret@github.com/acme/api.git" },
    { path: "web", remoteUrl: "git@github.com:acme/web.git" },
    { path: "libs/core", remoteUrl: "git@github.com:acme/core.git" },
  ];
  const workspaceInput = (destinationPath: string) => ({
    projectId,
    title: "acme",
    createdAt: "2026-01-01T00:00:00.000Z",
    destinationPath,
    repositories,
  });
  const memberFolder = (destination: string, root: string) => destination.slice(root.length + 1);
  const repositoryError = (detail: string) =>
    new SourceControlRepositoryError({
      operation: "cloneRepository",
      provider: SourceControlProviderKind.make("unknown"),
      detail,
    });
  const makeRoot = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs
        .makeTempDirectoryScoped()
        .pipe(Effect.map((directory) => ({ fs, root: `${directory}/acme` }))),
    ),
  );

  it.effect("writes the manifest first, then clones each member in order", () => {
    const cloneOrder: Array<string> = [];
    const manifestAtFirstClone = Deferred.makeUnsafe<string>();
    const gates = [Deferred.makeUnsafe<void>(), Deferred.makeUnsafe<void>()] as const;
    let root = "";
    const harness = makeHarness({
      clone: (input, options) =>
        Effect.gen(function* () {
          const member = memberFolder(input.destinationPath, root);
          cloneOrder.push(member);
          yield* (
            options?.onProgress?.({ stage: "receiving", percent: 10, detail: null }) ?? Effect.void
          );
          if (cloneOrder.length === 1) {
            const fs = yield* FileSystem.FileSystem;
            const manifest = yield* fs.readFileString(`${root}/par3.json`).pipe(Effect.orDie);
            yield* Deferred.succeed(manifestAtFirstClone, manifest);
          }
          const gate = gates[cloneOrder.length - 1];
          if (gate) yield* Deferred.await(gate);
          return { cwd: input.destinationPath, remoteUrl: input.remoteUrl ?? "", repository: null };
        }).pipe(Effect.provide(NodeServices.layer)),
    });
    return Effect.gen(function* () {
      const created = yield* makeRoot;
      root = created.root;
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const result = yield* tracker.start(workspaceInput(root), harness.hooks);
      expect(result.cwd).toBe(root);
      expect(harness.created).toEqual([{ projectId, workspaceRoot: root }]);

      expect(JSON.parse(yield* Deferred.await(manifestAtFirstClone))).toEqual({
        $schema: PAR3_PROJECT_FILE_SCHEMA_URL,
        repositories: [
          { path: "api", url: "https://github.com/acme/api.git" },
          { path: "web", url: "git@github.com:acme/web.git" },
          { path: "libs/core", url: "git@github.com:acme/core.git" },
        ],
      });
      const first = yield* tracker.get(projectId);
      expect(first).toMatchObject({
        phase: "running",
        destinationPath: root,
        remoteUrl: "https://github.com/acme/api.git",
        member: { path: "api", index: 1, count: 3 },
      });
      expect(projectCloneProgressSummary(first!)).toBe("api (1/3) · Receiving objects · 10%");

      yield* Deferred.succeed(gates[0], undefined);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({
        phase: "running",
        remoteUrl: "git@github.com:acme/web.git",
        member: { path: "web", index: 2, count: 3 },
      });
      expect(harness.cloned).toEqual([]);

      yield* Deferred.succeed(gates[1], undefined);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(cloneOrder).toEqual(["api", "web", "libs/core"]);
      expect(harness.cloned).toEqual([projectId]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("a failing member names itself, and retry resumes from it", () => {
    const attempts: Array<string> = [];
    let root = "";
    const harness = makeHarness({
      clone: (input) =>
        Effect.suspend(() => {
          const member = memberFolder(input.destinationPath, root);
          attempts.push(member);
          return member === "web" && attempts.filter((name) => name === "web").length === 1
            ? Effect.fail(repositoryError("fatal: repository not found"))
            : Effect.succeed({
                cwd: input.destinationPath,
                remoteUrl: input.remoteUrl ?? "",
                repository: null,
              });
        }),
    });
    return Effect.gen(function* () {
      root = (yield* makeRoot).root;
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(workspaceInput(root), harness.hooks);
      yield* Effect.yieldNow;
      expect(yield* tracker.get(projectId)).toMatchObject({
        phase: "failed",
        error: "web: fatal: repository not found",
        member: { path: "web", index: 2, count: 3 },
      });
      expect(attempts).toEqual(["api", "web"]);
      expect(harness.cloned).toEqual([]);

      expect(yield* tracker.retry(projectId)).toBe(true);
      expect(harness.discarded).toEqual([`${root}/web`]);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.phase).toBe("done");
      expect(attempts).toEqual(["api", "web", "web", "libs/core"]);
      expect(harness.cloned).toEqual([projectId]);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("cancel removes only the member in progress", () => {
    let root = "";
    const harness = makeHarness({
      clone: (input) =>
        memberFolder(input.destinationPath, root) === "web"
          ? Effect.never
          : Effect.succeed({
              cwd: input.destinationPath,
              remoteUrl: input.remoteUrl ?? "",
              repository: null,
            }),
    });
    return Effect.gen(function* () {
      const created = yield* makeRoot;
      root = created.root;
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* tracker.start(workspaceInput(root), harness.hooks);
      yield* Effect.yieldNow;
      expect((yield* tracker.get(projectId))?.member?.path).toBe("web");

      expect(yield* tracker.cancel(projectId)).toBe(true);
      expect((yield* tracker.get(projectId))?.phase).toBe("cancelled");
      expect(harness.discarded).toEqual([`${root}/web`]);
      expect(yield* created.fs.exists(`${root}/par3.json`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("rejects a workspace that also names a remote, or repeats a path", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const { root } = yield* makeRoot;
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const invalid = [
        { ...workspaceInput(root), remoteUrl: "git@github.com:acme/api.git" },
        { ...workspaceInput(root), repositories: [repositories[0]!, repositories[0]!] },
      ];
      for (const input of invalid) {
        const error = yield* Effect.flip(tracker.start(input, harness.hooks));
        expect(error._tag).toBe("SourceControlRepositoryError");
      }
      expect(harness.created).toEqual([]);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });

  it.effect("removes the manifest when the project cannot be created", () => {
    const harness = makeHarness();
    const hooks: ProjectCloneTracker.ProjectCloneHooks = {
      ...harness.hooks,
      createProject: () =>
        Effect.fail(new OrchestrationDispatchCommandError({ message: "workspace root exists" })),
    };
    return Effect.gen(function* () {
      const { fs, root } = yield* makeRoot;
      const tracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      yield* Effect.flip(tracker.start(workspaceInput(root), hooks));
      expect(yield* fs.exists(`${root}/par3.json`)).toBe(false);
      expect(yield* tracker.get(projectId)).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(harness.layer));
  });
});

describe("parseGitCloneProgressLine", () => {
  it("parses git's transfer counters and ignores other output", () => {
    expect(
      parseGitCloneProgressLine("Receiving objects:  45% (4500/10000), 12.30 MiB | 5.00 MiB/s"),
    ).toEqual({ stage: "receiving", percent: 45, detail: "12.30 MiB | 5.00 MiB/s" });
    expect(
      parseGitCloneProgressLine("Receiving objects: 100% (5/5), 40.00 MiB | 1.40 MiB/s, done."),
    ).toEqual({ stage: "receiving", percent: 100, detail: "40.00 MiB | 1.40 MiB/s" });
    expect(parseGitCloneProgressLine("Resolving deltas: 100% (700/700), done.")).toEqual({
      stage: "resolving",
      percent: 100,
      detail: null,
    });
    expect(parseGitCloneProgressLine("remote: Compressing objects:  12% (3/25)")).toEqual({
      stage: "counting",
      percent: 12,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Updating files:  78% (2104/2700)")).toEqual({
      stage: "checkout",
      percent: 78,
      detail: null,
    });
    expect(parseGitCloneProgressLine("remote: Enumerating objects: 10, done.")).toEqual({
      stage: "counting",
      percent: null,
      detail: null,
    });
    expect(parseGitCloneProgressLine("Cloning into 't3code'...")).toBeNull();
    expect(parseGitCloneProgressLine("fatal: repository not found")).toBeNull();
  });
});
