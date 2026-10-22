import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type {
  MergeConflictReadResult,
  MergeConflictResolution,
  VcsStatusLocalResult,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as MergeConflictService from "./MergeConflictService.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import {
  buildConflictBranches,
  commitAll,
  gitOut,
  initConflictRepo,
  readRepoFile,
  runGit,
  startConflictingMerge,
  writeRepoFile,
} from "./testing/mergeConflictFixture.ts";

const WORKSPACE_PREFIX = "merge-conflict-test-";

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-merge-conflict-test-",
});

const statusStub: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const makeTmpDir = Effect.fn("test.makeTmpDir")(function* (prefix = WORKSPACE_PREFIX) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

/** Builds the service over a real git driver; temp dirs with `WORKSPACE_PREFIX` count as known workspaces. */
const withService = <A, E, R>(
  body: (context: {
    readonly service: MergeConflictService.MergeConflictService["Service"];
    readonly refreshes: Ref.Ref<ReadonlyArray<string>>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const refreshes = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = MergeConflictService.layer.pipe(
      Layer.provideMerge(
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: (cwd) =>
            Ref.update(refreshes, (current) => [...current, cwd]).pipe(Effect.as(statusStub)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(KnownWorkspaces.KnownWorkspaces)({
          contains: (realPath) => Effect.succeed(realPath.includes(WORKSPACE_PREFIX)),
        }),
      ),
      Layer.provideMerge(GitVcsDriver.layer),
      Layer.provideMerge(layerServerConfig),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.gen(function* () {
      const service = yield* MergeConflictService.MergeConflictService;
      return yield* body({ service, refreshes });
    }).pipe(Effect.provide(layer));
  });

type Service = MergeConflictService.MergeConflictService["Service"];

const resolveFrom = (
  service: Service,
  cwd: string,
  read: MergeConflictReadResult,
  resolution: MergeConflictResolution,
) => service.resolve({ cwd, path: read.path, expected: read.expected, resolution });

const resolveWith = Effect.fn("test.resolveWith")(function* (
  service: Service,
  cwd: string,
  filePath: string,
  resolution: MergeConflictResolution,
) {
  const read = yield* service.read({ cwd, path: filePath });
  return yield* resolveFrom(service, cwd, read, resolution);
});

const resolveEverythingWithOurs = Effect.fn("test.resolveEverythingWithOurs")(function* (
  service: Service,
  cwd: string,
) {
  const { conflicts } = yield* service.list({ cwd });
  for (const conflict of conflicts) {
    yield* resolveWith(service, cwd, conflict.path, { _tag: "side", side: "ours" });
  }
});

const unmergedPaths = Effect.fn("test.unmergedPaths")(function* (cwd: string) {
  const output = yield* gitOut(cwd, ["ls-files", "-u", "--format=%(path)"]);
  return [...new Set(output.split("\n").filter((line) => line.length > 0))];
});

const staged = (cwd: string, filePath: string) => gitOut(cwd, ["show", `:${filePath}`]);

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.flip(effect);

describe("MergeConflictService", () => {
  describe("list and read", () => {
    it.effect("lists every conflict and labels a merge", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);

          const result = yield* service.list({ cwd });
          assert.deepStrictEqual(result.operation, { kind: "merge" });
          assert.deepStrictEqual(result.labels, { ours: "ours", theirs: "theirs" });
          assert.strictEqual(result.conflictCount, 8);
          assert.deepStrictEqual(
            result.conflicts.map((conflict) => `${conflict.path}:${conflict.kind}`),
            [
              "both.txt:both-added",
              "del-them.txt:deleted-by-them",
              "del-us.txt:deleted-by-us",
              "f.txt:both-modified",
              "rr-ours.txt:added-by-us",
              "rr-theirs.txt:added-by-them",
              "rr.txt:both-deleted",
              "w.txt:both-modified",
            ],
          );
        }),
      ),
    );

    it.effect("lists entries a client can resolve without reading the file", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          yield* writeRepoFile(cwd, "w.txt", "call(x, y)\n");
          yield* writeRepoFile(cwd, ".gitattributes", "both.txt filter=probe\n");

          const { conflicts } = yield* service.list({ cwd });
          const byPath = new Map(conflicts.map((entry) => [entry.path, entry]));
          assert.strictEqual(byPath.get("f.txt")?.rerereResolved, false);
          assert.strictEqual(byPath.get("w.txt")?.rerereResolved, true);
          assert.strictEqual(byPath.get("both.txt")?.fileLevelReason, "filter");
          assert.isUndefined(byPath.get("del-us.txt")?.rerereResolved);

          const read = yield* service.read({ cwd, path: "f.txt" });
          assert.deepStrictEqual(byPath.get("f.txt")?.expected, read.expected);
          const entry = byPath.get("w.txt")!;
          const result = yield* service.resolve({
            cwd,
            path: entry.path,
            expected: entry.expected,
            resolution: { _tag: "workingCopy" },
          });
          assert.strictEqual(result.remaining, 7);
          const sideEntry = byPath.get("del-them.txt")!;
          yield* service.resolve({
            cwd,
            path: sideEntry.path,
            expected: sideEntry.expected,
            resolution: { _tag: "side", side: "ours" },
          });
          assert.strictEqual(yield* staged(cwd, "del-them.txt"), "keep\nme\nplease, edited");
        }),
      ),
    );

    it.effect("lists nothing outside an operation", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* buildConflictBranches(cwd);

          const result = yield* service.list({ cwd });
          assert.isUndefined(result.operation);
          assert.deepStrictEqual(result.conflicts, []);
          assert.strictEqual(result.conflictCount, 0);
        }),
      ),
    );

    it.effect("reads the three stages, the working copy and the expected state", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);

          const read = yield* service.read({ cwd, path: "f.txt" });
          assert.strictEqual(read.kind, "both-modified");
          assert.strictEqual(read.base, "one\ntwo\nthree\n");
          assert.strictEqual(read.ours, "one\nours\nthree\n");
          assert.strictEqual(read.theirs, "one\ntheirs\nthree\n");
          assert.include(read.workingCopy ?? "", "<<<<<<<");
          assert.isTrue(read.workingCopyHasMarkers);
          assert.isFalse(read.rerereResolved);
          assert.isUndefined(read.fileLevelReason);
          assert.strictEqual(read.lineEnding, "lf");
          const stageOids = (yield* gitOut(cwd, ["ls-files", "-u", "--", "f.txt"]))
            .split("\n")
            .map((line) => line.split(" ")[1]);
          assert.deepStrictEqual(read.expected.stages, {
            base: stageOids[0] ?? null,
            ours: stageOids[1] ?? null,
            theirs: stageOids[2] ?? null,
          });
          assert.isString(read.expected.workingCopyHash);

          const deleted = yield* service.read({ cwd, path: "del-us.txt" });
          assert.strictEqual(deleted.kind, "deleted-by-us");
          assert.isNull(deleted.ours);
          assert.strictEqual(deleted.theirs, "keep\nme\nplease, edited\n");
        }),
      ),
    );

    it.effect("swaps the labels but not the sides during a rebase", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initConflictRepo(cwd);
          yield* writeRepoFile(cwd, "f.txt", "one\ntwo\nthree\n");
          yield* commitAll(cwd, "base");
          const base = yield* gitOut(cwd, ["branch", "--show-current"]);
          yield* runGit(cwd, ["checkout", "-b", "feature"]);
          yield* writeRepoFile(cwd, "f.txt", "one\nfeature\nthree\n");
          yield* commitAll(cwd, "feature change");
          yield* runGit(cwd, ["checkout", base]);
          yield* writeRepoFile(cwd, "f.txt", "one\nmain\nthree\n");
          yield* commitAll(cwd, "main change");
          yield* runGit(cwd, ["checkout", "feature"]);
          yield* runGit(cwd, ["rebase", base]);

          const list = yield* service.list({ cwd });
          assert.deepStrictEqual(list.operation, {
            kind: "rebase",
            step: { current: 1, total: 1 },
          });
          assert.strictEqual(list.labels.ours, base);
          assert.include(list.labels.theirs, "feature");
          assert.include(list.labels.theirs, "feature change");

          // Stage 2 is the branch being rebased onto, so "ours" holds main's text here.
          const read = yield* service.read({ cwd, path: "f.txt" });
          assert.strictEqual(read.ours, "one\nmain\nthree\n");
          assert.strictEqual(read.theirs, "one\nfeature\nthree\n");
          yield* resolveFrom(service, cwd, read, { _tag: "side", side: "ours" });
          assert.strictEqual(yield* staged(cwd, "f.txt"), "one\nmain\nthree");
        }),
      ),
    );

    it.effect("rejects paths that are not unmerged and never reaches outside the repository", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          for (const filePath of ["clean.txt", "../escape.txt", "nope/missing.txt"]) {
            const error = yield* failureOf(service.read({ cwd, path: filePath }));
            assert.strictEqual(error._tag, "MergeConflictError");
            if (error._tag === "MergeConflictError")
              assert.strictEqual(error.reason, "not-unmerged");
          }
          const f = yield* service.read({ cwd, path: "f.txt" });
          const escape = yield* failureOf(
            service.resolve({
              cwd,
              path: "../escape.txt",
              expected: f.expected,
              resolution: { _tag: "content", content: "pwned\n" },
            }),
          );
          assert.strictEqual(escape._tag, "MergeConflictError");
          assert.isFalse(yield* fileSystem.exists(path.join(path.dirname(cwd), "escape.txt")));
          assert.strictEqual(yield* readRepoFile(cwd, "clean.txt"), "untouched\n");
        }),
      ),
    );

    it.effect("refuses a cwd outside the known workspaces", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir("unrelated-test-");
          yield* startConflictingMerge(cwd);

          const error = yield* failureOf(service.list({ cwd }));
          assert.strictEqual(error._tag, "VcsRepositoryDetectionError");
        }),
      ),
    );
  });

  describe("resolve", () => {
    it.effect("stages edited content and refreshes status", () =>
      withService(({ service, refreshes }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);

          const result = yield* resolveWith(service, cwd, "f.txt", {
            _tag: "content",
            content: "one\nboth\nthree\n",
          });
          assert.strictEqual(result.remaining, 7);
          assert.notInclude(yield* unmergedPaths(cwd), "f.txt");
          assert.strictEqual(yield* staged(cwd, "f.txt"), "one\nboth\nthree");
          assert.strictEqual(yield* readRepoFile(cwd, "f.txt"), "one\nboth\nthree\n");
          assert.include(yield* Ref.get(refreshes), cwd);
        }),
      ),
    );

    it.effect("resolves by side, treating a missing side as a deletion", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);

          yield* resolveWith(service, cwd, "f.txt", { _tag: "side", side: "ours" });
          yield* resolveWith(service, cwd, "w.txt", { _tag: "side", side: "theirs" });
          assert.strictEqual(yield* staged(cwd, "f.txt"), "one\nours\nthree");
          assert.strictEqual(yield* staged(cwd, "w.txt"), "call(a, y)");

          // deleted-by-us: "ours" is gone, so choosing ours deletes and theirs restores
          yield* resolveWith(service, cwd, "del-us.txt", { _tag: "side", side: "ours" });
          yield* resolveWith(service, cwd, "del-them.txt", { _tag: "side", side: "theirs" });
          assert.strictEqual(yield* gitOut(cwd, ["ls-files", "--", "del-us.txt"]), "");
          assert.strictEqual(yield* gitOut(cwd, ["ls-files", "--", "del-them.txt"]), "");
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          assert.isFalse(yield* fileSystem.exists(path.join(cwd, "del-us.txt")));

          yield* resolveWith(service, cwd, "both.txt", { _tag: "side", side: "theirs" });
          assert.strictEqual(yield* staged(cwd, "both.txt"), "theirs added");
          yield* resolveWith(service, cwd, "rr-ours.txt", { _tag: "side", side: "ours" });
          yield* resolveWith(service, cwd, "rr-theirs.txt", { _tag: "delete" });
          yield* resolveWith(service, cwd, "rr.txt", { _tag: "delete" });
          assert.deepStrictEqual(yield* unmergedPaths(cwd), []);
        }),
      ),
    );

    it.effect("keeps theirs when the other side deleted the file", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);

          yield* resolveWith(service, cwd, "del-us.txt", { _tag: "side", side: "theirs" });
          assert.strictEqual(yield* staged(cwd, "del-us.txt"), "keep\nme\nplease, edited");
        }),
      ),
    );

    it.effect("rejects a resolve when a stage changed after the read", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          const read = yield* service.read({ cwd, path: "f.txt" });

          const driver = yield* GitVcsDriver.GitVcsDriver;
          const blob = yield* driver.execute({
            operation: "test.hash-object",
            cwd,
            args: ["hash-object", "-w", "--stdin"],
            stdin: "someone else's version\n",
          });
          yield* driver.execute({
            operation: "test.index-info",
            cwd,
            args: ["update-index", "--index-info"],
            stdin: `100644 ${blob.stdout.trim()} 3\tf.txt\n`,
          });

          const error = yield* failureOf(
            resolveFrom(service, cwd, read, { _tag: "side", side: "ours" }),
          );
          assert.strictEqual(error._tag, "MergeConflictStaleError");
          assert.include(yield* unmergedPaths(cwd), "f.txt");
        }),
      ),
    );

    it.effect("rejects a resolve when the working copy changed after the read", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          const read = yield* service.read({ cwd, path: "f.txt" });
          yield* writeRepoFile(cwd, "f.txt", "edited by someone else\n");

          const error = yield* failureOf(
            resolveFrom(service, cwd, read, { _tag: "content", content: "mine\n" }),
          );
          assert.strictEqual(error._tag, "MergeConflictStaleError");
          assert.strictEqual(yield* readRepoFile(cwd, "f.txt"), "edited by someone else\n");
          assert.include(yield* unmergedPaths(cwd), "f.txt");
        }),
      ),
    );

    it.effect("keeps the working copy's CRLF line endings", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initConflictRepo(cwd);
          yield* writeRepoFile(cwd, "crlf.txt", "a\r\nb\r\nc\r\n");
          yield* commitAll(cwd, "base");
          const base = yield* gitOut(cwd, ["branch", "--show-current"]);
          yield* runGit(cwd, ["checkout", "-b", "theirs"]);
          yield* writeRepoFile(cwd, "crlf.txt", "a\r\ntheirs\r\nc\r\n");
          yield* commitAll(cwd, "theirs");
          yield* runGit(cwd, ["checkout", base]);
          yield* writeRepoFile(cwd, "crlf.txt", "a\r\nours\r\nc\r\n");
          yield* commitAll(cwd, "ours");
          yield* runGit(cwd, ["merge", "--no-edit", "theirs"]);

          const read = yield* service.read({ cwd, path: "crlf.txt" });
          assert.strictEqual(read.lineEnding, "crlf");
          assert.strictEqual(read.ours, "a\r\nours\r\nc\r\n");
          yield* resolveFrom(service, cwd, read, {
            _tag: "content",
            content: "a\nresolved\nc\n",
          });
          assert.strictEqual(yield* readRepoFile(cwd, "crlf.txt"), "a\r\nresolved\r\nc\r\n");
        }),
      ),
    );

    it.effect("keeps the executable bit of the file it rewrites", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          if ((yield* HostProcess.Platform) === "win32") return;
          const cwd = yield* makeTmpDir();
          yield* initConflictRepo(cwd);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const script = path.join(cwd, "run.sh");
          // The server test setup forces core.filemode=false through the environment, so modes
          // are recorded with a command-line override. The assertion is on the file on disk,
          // which is what the atomic rename could drop whatever core.fileMode says.
          const withMode = (args: ReadonlyArray<string>) =>
            runGit(cwd, ["-c", "core.fileMode=true", ...args]);
          const commit = Effect.fn("test.commitWithMode")(function* (message: string) {
            yield* withMode(["add", "-A"]);
            yield* withMode(["commit", "-m", message]);
          });
          yield* writeRepoFile(cwd, "run.sh", "echo base\n");
          yield* fileSystem.chmod(script, 0o755);
          yield* commit("base");
          const base = yield* gitOut(cwd, ["branch", "--show-current"]);
          yield* runGit(cwd, ["checkout", "-b", "theirs"]);
          yield* writeRepoFile(cwd, "run.sh", "echo theirs\n");
          yield* commit("theirs");
          yield* runGit(cwd, ["checkout", base]);
          yield* writeRepoFile(cwd, "run.sh", "echo ours\n");
          yield* commit("ours");
          yield* withMode(["merge", "--no-edit", "theirs"]);
          const executable = (yield* fileSystem.stat(script)).mode & 0o111;
          assert.notStrictEqual(executable, 0);

          yield* resolveWith(service, cwd, "run.sh", { _tag: "content", content: "echo both\n" });
          assert.strictEqual(yield* readRepoFile(cwd, "run.sh"), "echo both\n");
          assert.strictEqual((yield* fileSystem.stat(script)).mode & 0o111, executable);
        }),
      ),
    );

    it.effect("offers only file-level resolution for filtered paths", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initConflictRepo(cwd);
          yield* runGit(cwd, ["config", "filter.probe.clean", "cat"]);
          yield* runGit(cwd, ["config", "filter.probe.smudge", "cat"]);
          yield* writeRepoFile(cwd, ".gitattributes", "*.dat filter=probe\n");
          yield* writeRepoFile(cwd, "asset.dat", "base\n");
          yield* commitAll(cwd, "base");
          const base = yield* gitOut(cwd, ["branch", "--show-current"]);
          yield* runGit(cwd, ["checkout", "-b", "theirs"]);
          yield* writeRepoFile(cwd, "asset.dat", "theirs\n");
          yield* commitAll(cwd, "theirs");
          yield* runGit(cwd, ["checkout", base]);
          yield* writeRepoFile(cwd, "asset.dat", "ours\n");
          yield* commitAll(cwd, "ours");
          yield* runGit(cwd, ["merge", "--no-edit", "theirs"]);

          const read = yield* service.read({ cwd, path: "asset.dat" });
          assert.strictEqual(read.fileLevelReason, "filter");
          assert.isNull(read.base);
          assert.isNull(read.workingCopy);

          const error = yield* failureOf(
            resolveFrom(service, cwd, read, { _tag: "content", content: "mine\n" }),
          );
          assert.strictEqual(error._tag, "MergeConflictError");
          if (error._tag === "MergeConflictError")
            assert.strictEqual(error.reason, "file-level-only");

          const auto = yield* service.autoResolve({ cwd });
          assert.deepStrictEqual(auto.skipped, [{ path: "asset.dat", reason: "filter" }]);

          yield* resolveFrom(service, cwd, read, { _tag: "side", side: "theirs" });
          assert.deepStrictEqual(yield* unmergedPaths(cwd), []);
        }),
      ),
    );

    it.effect("treats binary conflicts as file-level only", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initConflictRepo(cwd);
          yield* writeRepoFile(cwd, "blob.bin", "a\0base\n");
          yield* commitAll(cwd, "base");
          const base = yield* gitOut(cwd, ["branch", "--show-current"]);
          yield* runGit(cwd, ["checkout", "-b", "theirs"]);
          yield* writeRepoFile(cwd, "blob.bin", "a\0theirs\n");
          yield* commitAll(cwd, "theirs");
          yield* runGit(cwd, ["checkout", base]);
          yield* writeRepoFile(cwd, "blob.bin", "a\0ours\n");
          yield* commitAll(cwd, "ours");
          yield* runGit(cwd, ["merge", "--no-edit", "theirs"]);

          const read = yield* service.read({ cwd, path: "blob.bin" });
          assert.strictEqual(read.fileLevelReason, "binary");
          assert.isNull(read.ours);
        }),
      ),
    );

    it.effect("flags a working copy without markers so git's recorded resolution can be used", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          yield* writeRepoFile(cwd, "f.txt", "one\nrecorded resolution\nthree\n");

          const read = yield* service.read({ cwd, path: "f.txt" });
          assert.isFalse(read.workingCopyHasMarkers);
          assert.isTrue(read.rerereResolved);
          yield* resolveFrom(service, cwd, read, { _tag: "workingCopy" });
          assert.strictEqual(yield* staged(cwd, "f.txt"), "one\nrecorded resolution\nthree");
        }),
      ),
    );
  });

  describe("autoResolve and reopen", () => {
    it.effect("resolves the word-level case and keeps the real conflict", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);

          const result = yield* service.autoResolve({ cwd });
          assert.deepStrictEqual(result.resolved, ["w.txt"]);
          assert.strictEqual(result.remaining, 7);
          assert.deepStrictEqual(
            result.skipped.find((entry) => entry.path === "f.txt"),
            { path: "f.txt", reason: "conflicts-remain" },
          );
          assert.strictEqual(yield* staged(cwd, "w.txt"), "call(x, y)");
          assert.include(yield* unmergedPaths(cwd), "f.txt");
        }),
      ),
    );

    it.effect("only touches paths git lists as unmerged and skips custom merge drivers", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          yield* writeRepoFile(cwd, ".gitattributes", "w.txt merge=custom\n");

          const result = yield* service.autoResolve({ cwd, paths: ["w.txt", "clean.txt", "nope"] });
          assert.deepStrictEqual(result.resolved, []);
          assert.deepStrictEqual(result.skipped, [{ path: "w.txt", reason: "merge-driver" }]);
          assert.include(yield* unmergedPaths(cwd), "w.txt");
        }),
      ),
    );

    it.effect("leaves a file alone when its working copy was already edited", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          yield* writeRepoFile(cwd, "w.txt", "call(mine)\n");

          const result = yield* service.autoResolve({ cwd, paths: ["w.txt"] });
          assert.deepStrictEqual(result.skipped, [
            { path: "w.txt", reason: "working-copy-edited" },
          ]);
          assert.strictEqual(yield* readRepoFile(cwd, "w.txt"), "call(mine)\n");
        }),
      ),
    );

    it.effect("reopens a resolved file and refuses one git never saw conflict", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          yield* resolveWith(service, cwd, "f.txt", {
            _tag: "content",
            content: "one\nboth\nthree\n",
          });
          assert.notInclude(yield* unmergedPaths(cwd), "f.txt");

          const reopened = yield* service.reopen({ cwd, path: "f.txt" });
          assert.strictEqual(reopened.remaining, 8);
          assert.include(yield* unmergedPaths(cwd), "f.txt");
          assert.include(yield* readRepoFile(cwd, "f.txt"), "<<<<<<<");

          const error = yield* failureOf(service.reopen({ cwd, path: "clean.txt" }));
          assert.strictEqual(error._tag, "MergeConflictError");
          if (error._tag === "MergeConflictError")
            assert.strictEqual(error.reason, "not-reopenable");
        }),
      ),
    );
  });

  describe("runOperation", () => {
    it.effect("refuses to continue while conflicts remain, then commits the merge", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);

          const refused = yield* failureOf(service.runOperation({ cwd, action: "continue" }));
          assert.strictEqual(refused._tag, "MergeConflictError");
          if (refused._tag === "MergeConflictError") {
            assert.strictEqual(refused.reason, "conflicts-remain");
          }

          yield* resolveEverythingWithOurs(service, cwd);
          const result = yield* service.runOperation({ cwd, action: "continue" });
          assert.strictEqual(result.outcome, "completed");
          const parents = (yield* gitOut(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(
            " ",
          );
          assert.strictEqual(parents.length, 3);
          assert.strictEqual(yield* gitOut(cwd, ["status", "--porcelain"]), "");
          assert.isUndefined((yield* service.list({ cwd })).operation);
        }),
      ),
    );

    it.effect("reports a failing hook with its output instead of hanging", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          if ((yield* HostProcess.Platform) === "win32") return;
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          // A global core.hooksPath would otherwise send git somewhere else.
          yield* runGit(cwd, ["config", "core.hooksPath", path.join(cwd, ".git", "hooks")]);
          const hook = path.join(cwd, ".git", "hooks", "pre-commit");
          yield* fileSystem.writeFileString(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
          yield* fileSystem.chmod(hook, 0o755);
          yield* resolveEverythingWithOurs(service, cwd);

          const error = yield* failureOf(service.runOperation({ cwd, action: "continue" }));
          assert.strictEqual(error._tag, "MergeConflictError");
          if (error._tag === "MergeConflictError") {
            assert.strictEqual(error.reason, "operation-failed");
            assert.include(error.detail, "lint failed");
          }
          assert.isDefined((yield* service.list({ cwd })).operation);
        }),
      ),
    );

    it.effect("aborts back to the original HEAD", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* startConflictingMerge(cwd);
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const result = yield* service.runOperation({ cwd, action: "abort" });
          assert.strictEqual(result.outcome, "aborted");
          assert.strictEqual(yield* gitOut(cwd, ["log", "-1", "--format=%s"]), "ours change");
          assert.strictEqual(yield* gitOut(cwd, ["status", "--porcelain"]), "");
          assert.isFalse(yield* fileSystem.exists(path.join(cwd, ".git", "MERGE_HEAD")));

          const again = yield* failureOf(service.runOperation({ cwd, action: "abort" }));
          assert.strictEqual(again._tag, "MergeConflictError");
          if (again._tag === "MergeConflictError") assert.strictEqual(again.reason, "no-operation");
        }),
      ),
    );

    it.effect("walks a multi-step rebase, reporting each step's conflicts", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initConflictRepo(cwd);
          yield* writeRepoFile(cwd, "a.txt", "a\n");
          yield* writeRepoFile(cwd, "b.txt", "b\n");
          yield* commitAll(cwd, "base");
          const base = yield* gitOut(cwd, ["branch", "--show-current"]);
          yield* runGit(cwd, ["checkout", "-b", "feature"]);
          yield* writeRepoFile(cwd, "a.txt", "a feature\n");
          yield* commitAll(cwd, "feature a");
          yield* writeRepoFile(cwd, "b.txt", "b feature\n");
          yield* commitAll(cwd, "feature b");
          yield* runGit(cwd, ["checkout", base]);
          yield* writeRepoFile(cwd, "a.txt", "a main\n");
          yield* writeRepoFile(cwd, "b.txt", "b main\n");
          yield* commitAll(cwd, "main change");
          yield* runGit(cwd, ["checkout", "feature"]);
          yield* runGit(cwd, ["rebase", base]);

          assert.deepStrictEqual((yield* service.list({ cwd })).operation, {
            kind: "rebase",
            step: { current: 1, total: 2 },
          });
          const firstRead = yield* service.read({ cwd, path: "a.txt" });
          yield* resolveFrom(service, cwd, firstRead, { _tag: "side", side: "theirs" });
          const next = yield* service.runOperation({ cwd, action: "continue" });
          assert.strictEqual(next.outcome, "conflicts");

          const second = yield* service.list({ cwd });
          assert.deepStrictEqual(second.operation, {
            kind: "rebase",
            step: { current: 2, total: 2 },
          });
          assert.deepStrictEqual(
            second.conflicts.map((conflict) => conflict.path),
            ["b.txt"],
          );
          // The stages moved with the step, so a read taken earlier can no longer be applied.
          const secondRead = yield* service.read({ cwd, path: "b.txt" });
          assert.strictEqual(secondRead.theirs, "b feature\n");
          yield* resolveFrom(service, cwd, secondRead, { _tag: "side", side: "theirs" });
          const done = yield* service.runOperation({ cwd, action: "continue" });
          assert.strictEqual(done.outcome, "completed");
          assert.strictEqual(yield* gitOut(cwd, ["log", "-1", "--format=%s"]), "feature b");
        }),
      ),
    );
  });

  describe("startLocalMerge", () => {
    it.effect("refuses a dirty working tree", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* buildConflictBranches(cwd);
          yield* writeRepoFile(cwd, "clean.txt", "locally modified\n");

          const error = yield* failureOf(service.startLocalMerge({ cwd, baseRefName: "theirs" }));
          assert.strictEqual(error._tag, "MergeConflictError");
          if (error._tag === "MergeConflictError") {
            assert.strictEqual(error.reason, "dirty-working-tree");
          }
          assert.isUndefined((yield* service.list({ cwd })).operation);
        }),
      ),
    );

    it.effect("reports conflicts, a clean merge, and an up-to-date branch", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const { base } = yield* buildConflictBranches(cwd);

          const conflicted = yield* service.startLocalMerge({ cwd, baseRefName: "theirs" });
          assert.deepStrictEqual(conflicted, { outcome: "conflicts", mergedRef: "theirs" });
          const listed = yield* service.list({ cwd });
          assert.deepStrictEqual(listed.operation, { kind: "merge" });
          assert.strictEqual(listed.labels.theirs, "theirs");
          yield* service.runOperation({ cwd, action: "abort" });

          yield* runGit(cwd, ["checkout", "-b", "extra", base]);
          yield* writeRepoFile(cwd, "extra.txt", "extra\n");
          yield* commitAll(cwd, "extra");
          yield* runGit(cwd, ["checkout", "ours"]);
          const merged = yield* service.startLocalMerge({ cwd, baseRefName: "extra" });
          assert.deepStrictEqual(merged, { outcome: "merged", mergedRef: "extra" });
          assert.isUndefined((yield* service.list({ cwd })).operation);

          const upToDate = yield* service.startLocalMerge({ cwd, baseRefName: base });
          assert.deepStrictEqual(upToDate, { outcome: "up-to-date", mergedRef: base });
        }),
      ),
    );

    it.effect("fetches the base from the remote and labels the incoming side with it", () =>
      withService(({ service }) =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir();
          const other = yield* makeTmpDir();
          yield* runGit(remote, ["init", "--bare"]);
          yield* initConflictRepo(cwd);
          yield* writeRepoFile(cwd, "f.txt", "one\ntwo\nthree\n");
          yield* commitAll(cwd, "base");
          const base = yield* gitOut(cwd, ["branch", "--show-current"]);
          yield* runGit(cwd, ["remote", "add", "origin", remote]);
          yield* runGit(cwd, ["push", "-u", "origin", base]);
          yield* runGit(cwd, ["checkout", "-b", "feature"]);
          yield* writeRepoFile(cwd, "f.txt", "one\nfeature\nthree\n");
          yield* commitAll(cwd, "feature");

          yield* runGit(other, ["clone", remote, "."]);
          yield* runGit(other, ["config", "user.email", "test@test.com"]);
          yield* runGit(other, ["config", "user.name", "Test"]);
          yield* writeRepoFile(other, "f.txt", "one\nupstream\nthree\n");
          yield* commitAll(other, "upstream");
          yield* runGit(other, ["push", "origin", base]);

          const result = yield* service.startLocalMerge({ cwd, baseRefName: base });
          assert.deepStrictEqual(result, { outcome: "conflicts", mergedRef: `origin/${base}` });
          const listed = yield* service.list({ cwd });
          assert.strictEqual(listed.labels.ours, "feature");
          assert.strictEqual(listed.labels.theirs, `origin/${base}`);
        }),
      ),
    );

    it.effect(
      "refuses to start while another operation is in progress and rejects option-like refs",
      () =>
        withService(({ service }) =>
          Effect.gen(function* () {
            const cwd = yield* makeTmpDir();
            yield* startConflictingMerge(cwd);

            const busy = yield* failureOf(service.startLocalMerge({ cwd, baseRefName: "theirs" }));
            assert.strictEqual(busy._tag, "MergeConflictError");
            if (busy._tag === "MergeConflictError") {
              assert.strictEqual(busy.reason, "operation-in-progress");
            }
            const option = yield* failureOf(
              service.startLocalMerge({ cwd, baseRefName: "--upload-pack=evil" }),
            );
            assert.strictEqual(option._tag, "MergeConflictError");
          }),
        ),
    );
  });
});
