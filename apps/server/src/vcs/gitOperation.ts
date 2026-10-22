import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { VcsConflictKind, VcsOperationKind } from "@t3tools/contracts";

/**
 * Marker files git leaves behind while an operation is in progress. Rebase wins over the
 * others because a rebase replays commits with the cherry-pick machinery.
 */
const OPERATION_MARKERS = [
  { name: "rebase-merge", kind: "rebase" },
  { name: "rebase-apply", kind: "rebase" },
  { name: "CHERRY_PICK_HEAD", kind: "cherry-pick" },
  { name: "REVERT_HEAD", kind: "revert" },
  { name: "MERGE_HEAD", kind: "merge" },
] as const satisfies ReadonlyArray<{ name: string; kind: VcsOperationKind }>;

/**
 * `git rev-parse` arguments that print the index path, then the marker paths, one per line.
 * Asking for them in one call keeps operation detection free of extra processes.
 */
export const GIT_OPERATION_REV_PARSE_ARGS = [
  "rev-parse",
  "--git-path",
  "index",
  ...OPERATION_MARKERS.flatMap((marker) => ["--git-path", marker.name]),
] as const;

export interface DetectedGitOperation {
  readonly kind: VcsOperationKind;
  /** Absolute path of the marker that identified it (`rebase-merge` is a directory). */
  readonly markerPath: string;
}

/** `revParseStdout` is the output of `GIT_OPERATION_REV_PARSE_ARGS`. */
export const detectGitOperation = Effect.fn("gitOperation.detect")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly cwd: string;
  readonly revParseStdout: string;
}) {
  const lines = input.revParseStdout.trim().split("\n");
  for (const [index, marker] of OPERATION_MARKERS.entries()) {
    const line = lines[index + 1]?.trim();
    if (!line) continue;
    const markerPath = input.path.resolve(input.cwd, line);
    const present = yield* input.fileSystem
      .exists(markerPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (present) return { kind: marker.kind, markerPath } satisfies DetectedGitOperation;
  }
  return null;
});

/** Porcelain v2 `u` record XY code to conflict kind; null for codes git does not emit. */
export function conflictKindFromPorcelainCode(code: string): VcsConflictKind | null {
  switch (code) {
    case "UU":
      return "both-modified";
    case "AA":
      return "both-added";
    case "DD":
      return "both-deleted";
    case "AU":
      return "added-by-us";
    case "UA":
      return "added-by-them";
    case "DU":
      return "deleted-by-us";
    case "UD":
      return "deleted-by-them";
    default:
      return null;
  }
}
