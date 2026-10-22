import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";

/**
 * Builds the check every client-supplied repository `cwd` passes before a service touches it:
 * inside the configured workspace root, or inside a known workspace (project, managed worktree).
 * `detail` is the user-facing reason when the check fails.
 */
export const makeWorkspaceBoundCwdAssertion = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const canonicalizePath = (operation: string, value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: `${operation}.canonicalizePath`,
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  return Effect.fn("WorkspaceBoundCwd.assert")(function* (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly detail: string;
  }) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(input.operation, input.cwd),
      canonicalizePath(input.operation, config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation: input.operation,
      cwd: input.cwd,
      detail: input.detail,
    });
  });
});
