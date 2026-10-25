/**
 * The child repositories a thread edited when its project folder is not itself a repository; each is
 * then shown through the ordinary per-folder VCS requests. Paths come from recorded file changes,
 * so edits made only through shell commands are not seen.
 */
import {
  type VcsThreadRepositoriesInput,
  type VcsThreadRepositoriesResult,
  type VcsThreadRepository,
  VcsThreadRepositoriesError,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

/** Bounds the git probes one request can start; each probe runs git. */
const MAX_PROBED_DIRECTORIES = 64;

export class ThreadRepositories extends Context.Service<
  ThreadRepositories,
  {
    readonly list: (
      input: VcsThreadRepositoriesInput,
    ) => Effect.Effect<VcsThreadRepositoriesResult, VcsThreadRepositoriesError>;
  }
>()("t3/vcs/ThreadRepositories") {}

/** The path of `target` below `root`, or null when it is `root` itself or outside it. */
export function pathBelow(path: Path.Path, root: string, target: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative;
}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const below = (root: string, target: string) => pathBelow(path, root, target);

  const fail = (detail: string) => new VcsThreadRepositoriesError({ detail });

  // The panel refreshes after every settled edit, and most edited folders of a plain project
  // folder are not repositories, which the registry does not remember. A short cache keeps those
  // refreshes from probing the same folders again; a new `git init` shows up within a minute.
  // A folder git cannot open (deleted, or no permission) belongs to no repository.
  const repositoryRoots = yield* Cache.make({
    capacity: 1024,
    timeToLive: "1 minute",
    lookup: (cwd: string) =>
      vcs.detect({ cwd }).pipe(
        Effect.map((handle) => handle?.repository.rootPath ?? null),
        Effect.orElseSucceed(() => null),
      ),
  });
  const repositoryRoot = (cwd: string) => Cache.get(repositoryRoots, path.resolve(cwd));

  const list: ThreadRepositories["Service"]["list"] = Effect.fn("ThreadRepositories.list")(
    function* (input) {
      const thread = yield* projections
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(() => fail("The thread could not be read.")));
      if (thread === null) return yield* fail("The thread no longer exists.");
      const project = yield* projects
        .getShell(thread.projectId)
        .pipe(Effect.mapError(() => fail("The thread's project could not be read.")));
      if (Option.isNone(project)) return { repositories: [] };
      const base = thread.worktreePath ?? project.value.workspaceRoot;
      if ((yield* repositoryRoot(base)) !== null) return { repositories: [] };
      // Git reports physical paths, so a root reached through a symlink, junction or differently
      // cased path is compared against the folder's real path too.
      const realBase = yield* fileSystem.realPath(base).pipe(Effect.orElseSucceed(() => base));
      const belowBase = (target: string) => below(base, target) ?? below(realBase, target);

      const editedPaths = yield* projections
        .getThreadEditedPaths(input.threadId)
        .pipe(Effect.mapError(() => fail("The thread's file changes could not be read.")));
      const directories = [
        ...new Set(editedPaths.map((file) => path.dirname(path.resolve(base, file)))),
      ]
        .filter((directory) => belowBase(directory) !== null)
        .toSorted();
      // Containment is checked on paths relative to the folder, because git reports a root's
      // physical path while the edited paths keep the folder's recorded spelling.
      const found: VcsThreadRepository[] = [];
      const insideFound = (relativePath: string) =>
        found.some(
          (repository) =>
            relativePath === repository.relativePath ||
            relativePath.startsWith(`${repository.relativePath}${path.sep}`),
        );
      let probes = 0;
      for (const directory of directories) {
        if (insideFound(belowBase(directory)!)) continue;
        if (probes === MAX_PROBED_DIRECTORIES) {
          yield* Effect.logWarning("Stopped looking for a thread's repositories at the probe cap", {
            threadId: input.threadId,
            probedDirectories: probes,
            editedDirectories: directories.length,
          });
          break;
        }
        probes += 1;
        const root = yield* repositoryRoot(directory);
        if (root === null) continue;
        const cwd = path.resolve(root);
        // The contract takes trimmed paths, so a path with edge spaces would fail the whole reply.
        const relativePath = belowBase(cwd);
        if (relativePath === null || cwd.trim() !== cwd || relativePath.trim() !== relativePath)
          continue;
        if (!insideFound(relativePath)) found.push({ cwd, relativePath });
      }

      const repositories = found.toSorted((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      );
      return { repositories };
    },
  );

  return ThreadRepositories.of({ list });
});

export const layer = Layer.effect(ThreadRepositories, make);
