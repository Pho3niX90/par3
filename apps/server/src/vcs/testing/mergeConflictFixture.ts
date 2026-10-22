import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../GitVcsDriver.ts";

export interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs git without failing on a non-zero exit, because a conflicting merge exits 1. */
export const runGit = Effect.fn("mergeConflictFixture.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* driver.execute({
    operation: "mergeConflictFixture.runGit",
    cwd,
    args,
    allowNonZeroExit: true,
    timeoutMs: 20_000,
    ...(env ? { env } : {}),
  });
  return {
    exitCode: Number(result.exitCode),
    stdout: result.stdout,
    stderr: result.stderr,
  } satisfies GitRun;
});

export const gitOut = Effect.fn("mergeConflictFixture.gitOut")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
) {
  return (yield* runGit(cwd, args)).stdout.trim();
});

export const writeRepoFile = Effect.fn("mergeConflictFixture.writeRepoFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

export const readRepoFile = Effect.fn("mergeConflictFixture.readRepoFile")(function* (
  cwd: string,
  relativePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(cwd, relativePath));
});

export const commitAll = Effect.fn("mergeConflictFixture.commitAll")(function* (
  cwd: string,
  message: string,
) {
  yield* runGit(cwd, ["add", "-A"]);
  yield* runGit(cwd, ["commit", "-m", message]);
});

/**
 * An empty repository whose local config rules out the machine's git settings (signing,
 * autocrlf, rerere, conflict style), so a test sees the same markers and stages everywhere.
 */
export const initConflictRepo = Effect.fn("mergeConflictFixture.initConflictRepo")(function* (
  cwd: string,
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  yield* driver.initRepo({ cwd });
  for (const [key, value] of [
    ["user.email", "test@test.com"],
    ["user.name", "Test"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
    ["rerere.enabled", "false"],
    ["merge.conflictstyle", "merge"],
    ["advice.mergeConflict", "false"],
  ] as const) {
    yield* runGit(cwd, ["config", key, value]);
  }
});

const RENAME_BODY = Array.from({ length: 12 }, (_, index) => `rename line ${index}`).join("\n");

/**
 * Commits a base on the initial branch, then leaves `ours` checked out with one commit on each
 * of `ours` and `theirs` touching the same files in every way git can conflict on them.
 */
export const buildConflictBranches = Effect.fn("mergeConflictFixture.buildConflictBranches")(
  function* (cwd: string) {
    yield* initConflictRepo(cwd);
    yield* writeRepoFile(cwd, "f.txt", "one\ntwo\nthree\n");
    yield* writeRepoFile(cwd, "w.txt", "call(a, b)\n");
    yield* writeRepoFile(cwd, "del-us.txt", "keep\nme\nplease\n");
    yield* writeRepoFile(cwd, "del-them.txt", "keep\nme\nplease\n");
    yield* writeRepoFile(cwd, "rr.txt", `${RENAME_BODY}\n`);
    yield* writeRepoFile(cwd, "clean.txt", "untouched\n");
    yield* commitAll(cwd, "base");
    const base = yield* gitOut(cwd, ["branch", "--show-current"]);

    yield* runGit(cwd, ["checkout", "-b", "theirs"]);
    yield* writeRepoFile(cwd, "f.txt", "one\ntheirs\nthree\n");
    yield* writeRepoFile(cwd, "w.txt", "call(a, y)\n");
    yield* writeRepoFile(cwd, "both.txt", "theirs added\n");
    yield* writeRepoFile(cwd, "del-us.txt", "keep\nme\nplease, edited\n");
    yield* runGit(cwd, ["rm", "-q", "del-them.txt"]);
    yield* runGit(cwd, ["mv", "rr.txt", "rr-theirs.txt"]);
    yield* commitAll(cwd, "theirs change");

    yield* runGit(cwd, ["checkout", base]);
    yield* runGit(cwd, ["checkout", "-b", "ours"]);
    yield* writeRepoFile(cwd, "f.txt", "one\nours\nthree\n");
    yield* writeRepoFile(cwd, "w.txt", "call(x, b)\n");
    yield* writeRepoFile(cwd, "both.txt", "ours added\n");
    yield* runGit(cwd, ["rm", "-q", "del-us.txt"]);
    yield* writeRepoFile(cwd, "del-them.txt", "keep\nme\nplease, edited\n");
    yield* runGit(cwd, ["mv", "rr.txt", "rr-ours.txt"]);
    yield* commitAll(cwd, "ours change");
    return { base };
  },
);

/** Merges `theirs` into `ours`, which stops with every conflict kind in place. */
export const startConflictingMerge = Effect.fn("mergeConflictFixture.startConflictingMerge")(
  function* (cwd: string) {
    yield* buildConflictBranches(cwd);
    yield* runGit(cwd, ["merge", "--no-edit", "theirs"]);
  },
);
