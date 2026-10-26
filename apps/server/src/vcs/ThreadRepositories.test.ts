import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadRepositories from "./ThreadRepositories.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

/** Runs `list` for a project at `/work` whose repositories are the given folders below it. */
const listRepositories = (input: {
  readonly editedPaths: ReadonlyArray<string>;
  readonly repositories: ReadonlyArray<string>;
  readonly rootIsRepository?: boolean;
  readonly threadExists?: boolean;
}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const root = path.resolve("/work");
    const repositoryRoots = input.repositories.map((name) => path.join(root, name));
    const probed: string[] = [];
    const layer = ThreadRepositories.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () =>
              Effect.succeed(
                input.threadExists === false ? null : ({ projectId, worktreePath: null } as never),
              ),
            getThreadEditedPaths: () => Effect.succeed(input.editedPaths),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            getShell: () => Effect.succeedSome({ workspaceRoot: root } as never),
          }),
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: ({ cwd }) => {
              probed.push(cwd);
              if (cwd === root)
                return Effect.succeed(
                  input.rootIsRepository ? ({ repository: { rootPath: root } } as never) : null,
                );
              const rootPath = repositoryRoots.find(
                (candidate) =>
                  candidate === cwd || ThreadRepositories.pathBelow(path, candidate, cwd) !== null,
              );
              return Effect.succeed(
                rootPath === undefined ? null : ({ repository: { rootPath } } as never),
              );
            },
          }),
          NodeServices.layer,
        ),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const service = yield* ThreadRepositories.ThreadRepositories;
      return yield* service.list({ threadId });
    }).pipe(Effect.provide(layer), Effect.result);
    return { root, probed, result };
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("lists each child repository the thread edited once, by relative path", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { root, result, probed } = yield* listRepositories({
      repositories: ["apis", "services/config", "..hidden"],
      editedPaths: [
        "apis/src/a.ts",
        path.resolve("/work/apis/src/b.ts"),
        "services/config/x.yaml",
        "services/config/sub/y.yaml",
        "..hidden/c.ts",
        "notes/IPSTMAKE-1.md",
        "top-level.md",
        path.resolve("/elsewhere/z.ts"),
      ],
    });
    assert.deepStrictEqual(result._tag === "Success" ? result.success.repositories : result, [
      { cwd: path.join(root, "..hidden"), relativePath: "..hidden" },
      { cwd: path.join(root, "apis"), relativePath: "apis" },
      {
        cwd: path.join(root, "services/config"),
        relativePath: path.join("services", "config"),
      },
    ]);
    // Folders inside a known repository are not probed again, and nothing outside the root is.
    assert.isFalse(probed.includes(path.join(root, "services/config/sub")));
    assert.isFalse(probed.some((cwd) => cwd.startsWith(path.resolve("/elsewhere"))));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("lists nothing when the thread's folder is itself a repository", () =>
  Effect.gen(function* () {
    const { result } = yield* listRepositories({
      repositories: ["apis"],
      rootIsRepository: true,
      editedPaths: ["apis/src/a.ts"],
    });
    assert.deepStrictEqual(result._tag === "Success" ? result.success.repositories : result, []);
  }),
);

it.effect("fails with a readable error when the thread no longer exists", () =>
  Effect.gen(function* () {
    const { result } = yield* listRepositories({
      repositories: [],
      editedPaths: [],
      threadExists: false,
    });
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "VcsThreadRepositoriesError");
    }
  }),
);
