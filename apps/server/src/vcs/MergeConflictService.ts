import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import {
  GitCommandError,
  MergeConflictError,
  MergeConflictStaleError,
  type MergeConflictAutoResolveInput,
  type MergeConflictAutoResolveResult,
  type MergeConflictAutoResolveSkipReason,
  type MergeConflictFileLevelReason,
  type MergeConflictLabels,
  type MergeConflictListInput,
  type MergeConflictListResult,
  type MergeConflictMutationResult,
  type MergeConflictOperation,
  type MergeConflictOperationRunInput,
  type MergeConflictOperationRunResult,
  type MergeConflictReadInput,
  type MergeConflictReadResult,
  type MergeConflictReopenInput,
  type MergeConflictResolveInput,
  type MergeConflictRpcError,
  type MergeConflictStageOids,
  type MergeConflictStartLocalMergeInput,
  type MergeConflictStartLocalMergeResult,
  type VcsConflictKind,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  computeMerge3,
  convertLineEndings,
  detectLineEnding,
  isBinaryContent,
} from "@t3tools/shared/merge3";

import * as WorkspaceBoundCwd from "../workspace/WorkspaceBoundCwd.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import {
  detectGitOperation,
  GIT_OPERATION_REV_PARSE_ARGS,
  type DetectedGitOperation,
} from "./gitOperation.ts";
import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";

export class MergeConflictService extends Context.Service<
  MergeConflictService,
  {
    readonly list: (
      input: MergeConflictListInput,
    ) => Effect.Effect<MergeConflictListResult, MergeConflictRpcError>;
    readonly read: (
      input: MergeConflictReadInput,
    ) => Effect.Effect<MergeConflictReadResult, MergeConflictRpcError>;
    readonly resolve: (
      input: MergeConflictResolveInput,
    ) => Effect.Effect<MergeConflictMutationResult, MergeConflictRpcError>;
    readonly autoResolve: (
      input: MergeConflictAutoResolveInput,
    ) => Effect.Effect<MergeConflictAutoResolveResult, MergeConflictRpcError>;
    readonly reopen: (
      input: MergeConflictReopenInput,
    ) => Effect.Effect<MergeConflictMutationResult, MergeConflictRpcError>;
    readonly runOperation: (
      input: MergeConflictOperationRunInput,
    ) => Effect.Effect<MergeConflictOperationRunResult, MergeConflictRpcError>;
    readonly startLocalMerge: (
      input: MergeConflictStartLocalMergeInput,
    ) => Effect.Effect<MergeConflictStartLocalMergeResult, MergeConflictRpcError>;
  }
>()("t3/vcs/MergeConflictService") {}

/** A resolved result can hold both sides of a file, so writes get more room than reads. */
const MAX_WRITE_BYTES = FILE_TEXT_PREVIEW_MAX_BYTES * 3;
const MAX_ERROR_DETAIL_CHARS = 2_000;
const MAX_LABEL_CHARS = 200;
const OPERATION_TIMEOUT_MS = 120_000;
const BATCH_OUTPUT_SLACK_BYTES = 1_024;

interface StageEntry {
  readonly mode: string;
  readonly oid: string;
}
type Stages = Partial<Record<1 | 2 | 3, StageEntry>>;

interface Repository {
  readonly cwd: string;
  readonly root: string;
}

type StageText =
  | { readonly _tag: "text"; readonly text: string }
  | { readonly _tag: "binary" }
  | { readonly _tag: "too-large" };

const conflictKindForStages = (stages: Stages): VcsConflictKind => {
  if (stages[2] && stages[3]) return stages[1] ? "both-modified" : "both-added";
  if (stages[2]) return stages[1] ? "deleted-by-them" : "added-by-us";
  if (stages[3]) return stages[1] ? "deleted-by-us" : "added-by-them";
  return "both-deleted";
};

const stageOids = (stages: Stages): MergeConflictStageOids => ({
  base: stages[1]?.oid ?? null,
  ours: stages[2]?.oid ?? null,
  theirs: stages[3]?.oid ?? null,
});

const sameOids = (left: MergeConflictStageOids, right: MergeConflictStageOids) =>
  left.base === right.base && left.ours === right.ours && left.theirs === right.theirs;

/** Symlinks (120000) and submodules (160000) have no text to merge. */
const hasSpecialMode = (stages: Stages) =>
  Object.values(stages).some((entry) => entry.mode === "120000" || entry.mode === "160000");

const MARKER_START = /^<{7}(?: |\r?$)/m;
const MARKER_MIDDLE = /^={7}\r?$/m;
const MARKER_END = /^>{7}(?: |\r?$)/m;
const hasConflictMarkers = (text: string) =>
  MARKER_START.test(text) && MARKER_MIDDLE.test(text) && MARKER_END.test(text);

const parseUnmerged = (stdout: string) => {
  const files = new Map<string, Stages>();
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    const stageNumber = Number(stage);
    if (!mode || !oid || (stageNumber !== 1 && stageNumber !== 2 && stageNumber !== 3)) continue;
    const filePath = record.slice(tab + 1);
    const stages: Stages = files.get(filePath) ?? {};
    stages[stageNumber] = { mode, oid };
    files.set(filePath, stages);
  }
  return files;
};

/** `git check-attr -z` prints `path NUL attribute NUL value NUL` triples. */
const parseAttributes = (stdout: string) => {
  const byPath = new Map<string, Map<string, string>>();
  const fields = stdout.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const attributes = byPath.get(fields[index]!) ?? new Map<string, string>();
    attributes.set(fields[index + 1]!, fields[index + 2]!);
    byPath.set(fields[index]!, attributes);
  }
  return byPath;
};

const isAttributeSet = (value: string | undefined) =>
  value !== undefined && value !== "unspecified" && value !== "unset";

/** `merge` values git applies itself, so they do not indicate a custom driver. */
const isBuiltinMergeAttribute = (value: string | undefined) =>
  value === undefined || value === "unspecified" || value === "set" || value === "text";

const boundedDetail = (text: string, fallback: string) => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.length > MAX_ERROR_DETAIL_CHARS
    ? `${trimmed.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
    : trimmed;
};

const clampLabel = (label: string) => label.trim().slice(0, MAX_LABEL_CHARS);

const stripRefPrefix = (ref: string) =>
  ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");

const shortenOid = (value: string) => (/^[0-9a-f]{40,64}$/.test(value) ? value.slice(0, 7) : value);

const OPERATION_ARGUMENT: Record<MergeConflictOperation["kind"], string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
  revert: "revert",
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const statusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const assertWorkspaceBoundCwd = yield* WorkspaceBoundCwd.makeWorkspaceBoundCwdAssertion;
  const locks = yield* KeyedLock.make<string>();

  const runGit = Effect.fn("MergeConflictService.runGit")(function* (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
      readonly appendTruncationMarker?: boolean;
    } = {},
  ) {
    const result = yield* git.execute({
      operation,
      cwd,
      args: [...args],
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: options.appendTruncationMarker }
        : {}),
      allowNonZeroExit: true,
    });
    if (options.allowNonZeroExit !== true && result.exitCode !== 0) {
      return yield* new GitCommandError({
        operation,
        command: "git",
        cwd,
        argumentCount: args.length,
        exitCode: result.exitCode,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        detail: boundedDetail(result.stderr, "Git command exited with a non-zero status."),
      });
    }
    return result;
  });

  const fileFailure =
    (filePath: string, action: string) =>
    (cause: PlatformError.PlatformError): MergeConflictError =>
      new MergeConflictError({
        reason: "operation-failed",
        path: filePath,
        detail: `Could not ${action} ${filePath}.`,
        cause,
      });

  const repositoryFor = Effect.fn("MergeConflictService.repository")(function* (
    operation: string,
    cwd: string,
  ) {
    yield* assertWorkspaceBoundCwd({
      operation,
      cwd,
      detail: "Merge conflict cwd must stay within the configured workspace root.",
    });
    const top = yield* runGit(`${operation}.toplevel`, cwd, ["rev-parse", "--show-toplevel"]);
    return { cwd, root: top.stdout.trim() } satisfies Repository;
  });

  const currentOperation = Effect.fn("MergeConflictService.currentOperation")(function* (
    repo: Repository,
  ) {
    const result = yield* runGit("MergeConflictService.operation", repo.root, [
      ...GIT_OPERATION_REV_PARSE_ARGS,
    ]);
    return yield* detectGitOperation({
      fileSystem,
      path,
      cwd: repo.root,
      revParseStdout: result.stdout,
    });
  });

  const listUnmerged = Effect.fn("MergeConflictService.listUnmerged")(function* (
    repo: Repository,
    filePath?: string,
  ) {
    const result = yield* runGit("MergeConflictService.listUnmerged", repo.root, [
      "--literal-pathspecs",
      "ls-files",
      "-u",
      "-z",
      "--full-name",
      ...(filePath === undefined ? [] : ["--", filePath]),
    ]);
    return parseUnmerged(result.stdout);
  });

  /** Paths come from clients; anything but a plain repository-relative path is not a conflict. */
  const assertRepositoryRelative = (filePath: string) =>
    path.isAbsolute(filePath) || filePath.includes("\0") || filePath.split(/[\\/]/).includes("..")
      ? new MergeConflictError({
          reason: "not-unmerged",
          path: filePath,
          detail: `${filePath} is not a path inside this repository.`,
        })
      : null;

  const requireUnmerged = Effect.fn("MergeConflictService.requireUnmerged")(function* (
    repo: Repository,
    filePath: string,
  ) {
    const invalid = assertRepositoryRelative(filePath);
    if (invalid !== null) return yield* invalid;
    const stages = (yield* listUnmerged(repo, filePath)).get(filePath);
    if (stages === undefined) {
      return yield* new MergeConflictError({
        reason: "not-unmerged",
        path: filePath,
        detail: `${filePath} has no merge conflict to resolve.`,
      });
    }
    return stages;
  });

  const gitLine = Effect.fn("MergeConflictService.gitLine")(function* (
    repo: Repository,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runGit("MergeConflictService.gitLine", repo.root, args, {
      allowNonZeroExit: true,
    });
    const line = result.stdout.trim();
    return result.exitCode === 0 && line.length > 0 ? line : null;
  });

  const readText = (filePath: string) =>
    fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));

  const commitSummary = (repo: Repository, revision: string) =>
    gitLine(repo, ["log", "-1", "--format=%h %s", revision, "--"]);

  const describeOperation = Effect.fn("MergeConflictService.describeOperation")(function* (
    repo: Repository,
    detected: DetectedGitOperation | null,
  ) {
    const branch = yield* gitLine(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const head = branch ?? (yield* gitLine(repo, ["rev-parse", "--short", "HEAD"])) ?? "HEAD";
    if (detected === null) {
      return {
        operation: undefined,
        labels: { ours: clampLabel(head), theirs: "Incoming" },
      } satisfies { operation: MergeConflictOperation | undefined; labels: MergeConflictLabels };
    }

    if (detected.kind === "rebase") {
      // git replays the commit onto the new base, so stage 2 ("ours") is the base being rebased
      // onto and stage 3 ("theirs") is the commit being replayed. The API keeps ours = stage 2;
      // only these labels reflect the swap.
      const dir = detected.markerPath;
      const [headName, onto, msgnum, end, next, last] = yield* Effect.all(
        ["head-name", "onto", "msgnum", "end", "next", "last"].map((name) =>
          readText(path.join(dir, name)),
        ),
      );
      const current = Number((msgnum ?? next ?? "").trim());
      const total = Number((end ?? last ?? "").trim());
      const ontoRef = onto?.trim();
      const ontoName = ontoRef
        ? ((yield* gitLine(repo, ["name-rev", "--name-only", "--no-undefined", ontoRef])) ??
          (yield* gitLine(repo, ["rev-parse", "--short", ontoRef])) ??
          ontoRef)
        : "Upstream";
      const branchName = stripRefPrefix(headName?.trim() ?? "");
      const commit = yield* commitSummary(repo, "REBASE_HEAD");
      const theirs =
        branchName && commit
          ? `${branchName} (${commit})`
          : branchName || commit || "Rebased commit";
      return {
        operation: {
          kind: "rebase",
          ...(Number.isInteger(current) && Number.isInteger(total) && total > 0
            ? { step: { current, total } }
            : {}),
        },
        labels: {
          ours: clampLabel(ontoName.replace(/^remotes\//, "")),
          theirs: clampLabel(theirs),
        },
      } satisfies { operation: MergeConflictOperation; labels: MergeConflictLabels };
    }

    if (detected.kind === "merge") {
      const message = yield* readText(path.join(path.dirname(detected.markerPath), "MERGE_MSG"));
      const named = /^Merge (?:remote-tracking branch|branch|commit|tag) '([^']+)'/.exec(
        message?.split("\n")[0] ?? "",
      )?.[1];
      const theirs =
        named !== undefined
          ? shortenOid(named)
          : ((yield* gitLine(repo, ["rev-parse", "--short", "MERGE_HEAD"])) ?? "Incoming branch");
      return {
        operation: { kind: "merge" },
        labels: { ours: clampLabel(head), theirs: clampLabel(theirs) },
      } satisfies { operation: MergeConflictOperation; labels: MergeConflictLabels };
    }

    const marker = detected.kind === "cherry-pick" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD";
    const commit = (yield* commitSummary(repo, marker)) ?? "commit";
    return {
      operation: { kind: detected.kind },
      labels: {
        ours: clampLabel(head),
        theirs: clampLabel(detected.kind === "revert" ? `Parent of ${commit}` : commit),
      },
    } satisfies { operation: MergeConflictOperation; labels: MergeConflictLabels };
  });

  const checkAttributes = Effect.fn("MergeConflictService.checkAttributes")(function* (
    repo: Repository,
    paths: ReadonlyArray<string>,
  ) {
    if (paths.length === 0) return new Map<string, Map<string, string>>();
    const result = yield* runGit(
      "MergeConflictService.checkAttributes",
      repo.root,
      ["--literal-pathspecs", "check-attr", "-z", "--stdin", "filter", "merge"],
      { stdin: `${paths.join("\0")}\0`, allowNonZeroExit: true },
    );
    return result.exitCode === 0
      ? parseAttributes(result.stdout)
      : new Map<string, Map<string, string>>();
  });

  /**
   * Reads the stage blobs with one `git cat-file --batch`. The output arrives UTF-8 decoded, so
   * a replacement character means a blob was not valid UTF-8 and the sizes in the headers can
   * no longer be trusted; such a file is treated as binary.
   */
  const readBlobs = Effect.fn("MergeConflictService.readBlobs")(function* (
    repo: Repository,
    oids: ReadonlyArray<string>,
  ) {
    const unique = [...new Set(oids)];
    const blobs = new Map<string, StageText>();
    if (unique.length === 0) return blobs;
    const result = yield* runGit(
      "MergeConflictService.readBlobs",
      repo.root,
      ["cat-file", "--batch"],
      {
        stdin: `${unique.join("\n")}\n`,
        maxOutputBytes:
          unique.length * (FILE_TEXT_PREVIEW_MAX_BYTES + 128) + BATCH_OUTPUT_SLACK_BYTES,
        appendTruncationMarker: true,
      },
    );
    if (result.stdoutTruncated) {
      for (const oid of unique) blobs.set(oid, { _tag: "too-large" });
      return blobs;
    }
    if (result.stdout.includes("\uFFFD")) {
      for (const oid of unique) blobs.set(oid, { _tag: "binary" });
      return blobs;
    }
    const bytes = new TextEncoder().encode(result.stdout);
    const decoder = new TextDecoder();
    let position = 0;
    for (const oid of unique) {
      const lineEnd = bytes.indexOf(10, position);
      if (lineEnd === -1) {
        blobs.set(oid, { _tag: "binary" });
        continue;
      }
      const header = decoder.decode(bytes.subarray(position, lineEnd)).split(" ");
      const size = Number(header[2]);
      if (header[1] !== "blob" || !Number.isInteger(size)) {
        blobs.set(oid, { _tag: "binary" });
        position = lineEnd + 1;
        continue;
      }
      const content = bytes.subarray(lineEnd + 1, lineEnd + 1 + size);
      position = lineEnd + 1 + size + 1;
      blobs.set(
        oid,
        size > FILE_TEXT_PREVIEW_MAX_BYTES
          ? { _tag: "too-large" }
          : isBinaryContent(content)
            ? { _tag: "binary" }
            : { _tag: "text", text: decoder.decode(content) },
      );
    }
    return blobs;
  });

  const absolutePath = (repo: Repository, filePath: string) => path.join(repo.root, filePath);

  /** Null when the file is missing or not a regular file. */
  const workingFileInfo = Effect.fn("MergeConflictService.workingFileInfo")(function* (
    absolute: string,
  ) {
    return yield* fileSystem.stat(absolute).pipe(
      Effect.map((info) =>
        info.type === "File" ? { size: Number(info.size), mode: info.mode } : null,
      ),
      Effect.orElseSucceed(() => null),
    );
  });

  /** Blob id of the file as it is on disk, with no clean filters applied. */
  const hashWorkingCopy = Effect.fn("MergeConflictService.hashWorkingCopy")(function* (
    repo: Repository,
    filePath: string,
  ) {
    const info = yield* workingFileInfo(absolutePath(repo, filePath));
    if (info === null) return null;
    return yield* gitLine(repo, ["hash-object", "--no-filters", "--", filePath]);
  });

  const fileLevelReasonFor = (
    stages: Stages,
    attributes: Map<string, string> | undefined,
  ): MergeConflictFileLevelReason | null => {
    if (hasSpecialMode(stages)) return "special-file";
    // Stage blobs hold the clean form, so a filtered file (LFS and friends) cannot be merged as text.
    if (isAttributeSet(attributes?.get("filter"))) return "filter";
    return null;
  };

  const countUnmerged = Effect.fn("MergeConflictService.countUnmerged")(function* (
    repo: Repository,
  ) {
    return (yield* listUnmerged(repo)).size;
  });

  const refreshStatus = (cwd: string) =>
    statusBroadcaster.refreshLocalStatus(cwd).pipe(Effect.ignore({ log: true }));

  /** Serializes mutations per repository and refreshes status however they end. */
  const mutating = <A, E, R>(repo: Repository, effect: Effect.Effect<A, E, R>) =>
    locks.withLock(repo.root, effect).pipe(Effect.ensuring(refreshStatus(repo.cwd)));

  const RERERE_SCAN_LIMIT = 1_000;

  /** One `hash-object` for every existing regular file; paths git's line protocol cannot carry fall back. */
  const hashWorkingCopies = Effect.fn("MergeConflictService.hashWorkingCopies")(function* (
    repo: Repository,
    filePaths: ReadonlyArray<string>,
  ) {
    const hashes = new Map<string, string>();
    const batchable = filePaths.filter((filePath) => !filePath.includes("\n"));
    if (batchable.length > 0) {
      const result = yield* runGit(
        "MergeConflictService.hashWorkingCopies",
        repo.root,
        ["hash-object", "--no-filters", "--stdin-paths"],
        { stdin: `${batchable.join("\n")}\n`, allowNonZeroExit: true },
      );
      const lines = result.stdout.split("\n");
      if (result.exitCode === 0 && lines.length >= batchable.length) {
        batchable.forEach((filePath, index) => hashes.set(filePath, lines[index]!.trim()));
      }
    }
    for (const filePath of filePaths) {
      if (hashes.has(filePath)) continue;
      const hash = yield* hashWorkingCopy(repo, filePath);
      if (hash !== null) hashes.set(filePath, hash);
    }
    return hashes;
  });

  const list: MergeConflictService["Service"]["list"] = Effect.fn("MergeConflictService.list")(
    function* (input) {
      const repo = yield* repositoryFor("MergeConflictService.list", input.cwd);
      const unmerged = yield* listUnmerged(repo);
      const described = yield* describeOperation(repo, yield* currentOperation(repo));
      const paths = [...unmerged.keys()].toSorted((a, b) => a.localeCompare(b));
      const attributes = yield* checkAttributes(repo, paths);
      // Taken once up front, so each entry's hash and its marker scan describe the same moment.
      const infos = yield* Effect.forEach(
        paths,
        (filePath) => workingFileInfo(absolutePath(repo, filePath)),
        { concurrency: 16 },
      );
      const regular = paths.filter((_, index) => infos[index] !== null);
      const hashes = yield* hashWorkingCopies(repo, regular);
      const conflicts = yield* Effect.forEach(
        paths,
        (filePath, index) =>
          Effect.gen(function* () {
            const stages = unmerged.get(filePath)!;
            const kind = conflictKindForStages(stages);
            const fileLevelReason = fileLevelReasonFor(stages, attributes.get(filePath));
            const info = infos[index];
            let rerereResolved: boolean | undefined;
            if (
              fileLevelReason === null &&
              index < RERERE_SCAN_LIMIT &&
              (kind === "both-modified" || kind === "both-added") &&
              info !== null &&
              info !== undefined &&
              info.size <= FILE_TEXT_PREVIEW_MAX_BYTES
            ) {
              const text = yield* readText(absolutePath(repo, filePath));
              rerereResolved = text !== null && !hasConflictMarkers(text);
            }
            return {
              path: filePath,
              kind,
              expected: {
                stages: stageOids(stages),
                workingCopyHash: hashes.get(filePath) ?? null,
              },
              ...(fileLevelReason === null ? {} : { fileLevelReason }),
              ...(rerereResolved === undefined ? {} : { rerereResolved }),
            };
          }),
        { concurrency: 16 },
      );
      return {
        ...(described.operation ? { operation: described.operation } : {}),
        labels: described.labels,
        conflicts,
        conflictCount: conflicts.length,
      };
    },
  );

  const read: MergeConflictService["Service"]["read"] = Effect.fn("MergeConflictService.read")(
    function* (input) {
      const repo = yield* repositoryFor("MergeConflictService.read", input.cwd);
      const stages = yield* requireUnmerged(repo, input.path);
      const described = yield* describeOperation(repo, yield* currentOperation(repo));
      const attributes = (yield* checkAttributes(repo, [input.path])).get(input.path);
      const absolute = absolutePath(repo, input.path);
      const kind = conflictKindForStages(stages);
      // The hash is taken before the text so an edit in between makes the later resolve
      // stale rather than letting it overwrite a version the client never saw.
      const workingCopyHash = yield* hashWorkingCopy(repo, input.path);
      const base = {
        path: input.path,
        kind,
        ...(described.operation ? { operation: described.operation } : {}),
        labels: described.labels,
        expected: { stages: stageOids(stages), workingCopyHash },
      };
      const fileLevel = (reason: MergeConflictFileLevelReason): MergeConflictReadResult => ({
        ...base,
        base: null,
        ours: null,
        theirs: null,
        workingCopy: null,
        workingCopyHasMarkers: true,
        rerereResolved: false,
        lineEnding: "lf",
        fileLevelReason: reason,
      });

      const reason = fileLevelReasonFor(stages, attributes);
      if (reason !== null) return fileLevel(reason);

      const present = Object.values(stages).map((entry) => entry.oid);
      const blobs = yield* readBlobs(repo, present);
      const texts = (entry: StageEntry | undefined) =>
        entry === undefined ? null : (blobs.get(entry.oid) ?? null);
      const stageTexts = [texts(stages[1]), texts(stages[2]), texts(stages[3])];
      if (stageTexts.some((entry) => entry?._tag === "too-large")) return fileLevel("too-large");
      if (stageTexts.some((entry) => entry?._tag === "binary")) return fileLevel("binary");
      const textOf = (entry: StageText | null) => (entry?._tag === "text" ? entry.text : null);

      const info = yield* workingFileInfo(absolute);
      if (info !== null && info.size > FILE_TEXT_PREVIEW_MAX_BYTES) return fileLevel("too-large");
      let workingCopy: string | null = null;
      if (info !== null) {
        const bytes = yield* fileSystem
          .readFile(absolute)
          .pipe(Effect.mapError(fileFailure(input.path, "read")));
        if (isBinaryContent(bytes)) return fileLevel("binary");
        workingCopy = new TextDecoder().decode(bytes);
      }
      const markers = workingCopy !== null && hasConflictMarkers(workingCopy);
      return {
        ...base,
        base: textOf(stageTexts[0]!),
        ours: textOf(stageTexts[1]!),
        theirs: textOf(stageTexts[2]!),
        workingCopy,
        workingCopyHasMarkers: markers,
        rerereResolved:
          workingCopy !== null && !markers && (kind === "both-modified" || kind === "both-added"),
        lineEnding:
          workingCopy !== null && detectLineEnding(workingCopy) === "\r\n" ? "crlf" : "lf",
      };
    },
  );

  const assertNotStale = Effect.fn("MergeConflictService.assertNotStale")(function* (
    repo: Repository,
    filePath: string,
    stages: Stages,
    expected: MergeConflictResolveInput["expected"],
  ) {
    if (!sameOids(stageOids(stages), expected.stages)) {
      return yield* new MergeConflictStaleError({
        path: filePath,
        detail: `${filePath} changed since it was opened. Reopen it to see the current conflict.`,
      });
    }
    if ((yield* hashWorkingCopy(repo, filePath)) !== expected.workingCopyHash) {
      return yield* new MergeConflictStaleError({
        path: filePath,
        detail: `${filePath} was edited on disk since it was opened. Reopen it to see the current contents.`,
      });
    }
  });

  const stagePath = (repo: Repository, filePath: string) =>
    runGit("MergeConflictService.stage", repo.root, ["--literal-pathspecs", "add", "--", filePath]);

  const removePath = (repo: Repository, filePath: string) =>
    runGit("MergeConflictService.remove", repo.root, [
      "--literal-pathspecs",
      "rm",
      "-f",
      "--quiet",
      "--",
      filePath,
    ]);

  /** Keeps a write inside the repository even when a directory was swapped for a symlink. */
  const assertInsideRepository = Effect.fn("MergeConflictService.assertInsideRepository")(
    function* (repo: Repository, filePath: string) {
      const [realRoot, realParent] = yield* Effect.all([
        fileSystem.realPath(repo.root),
        fileSystem.realPath(path.dirname(absolutePath(repo, filePath))).pipe(
          // A missing directory is created by the write itself.
          Effect.orElseSucceed(() => null),
        ),
      ]).pipe(Effect.mapError(fileFailure(filePath, "resolve")));
      if (realParent === null) return;
      const relative = path.relative(realRoot, realParent);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return yield* new MergeConflictError({
          reason: "file-level-only",
          path: filePath,
          detail: `${filePath} resolves outside the repository, so it cannot be edited here.`,
        });
      }
    },
  );

  /** Writes `content` using the line ending the working copy already has, then stages it. */
  const writeResolvedContent = Effect.fn("MergeConflictService.writeResolvedContent")(function* (
    repo: Repository,
    filePath: string,
    content: string,
  ) {
    const absolute = absolutePath(repo, filePath);
    yield* assertInsideRepository(repo, filePath);
    const info = yield* workingFileInfo(absolute);
    let lineEnding: "\r\n" | "\n" | null = null;
    if (info !== null && info.size <= FILE_TEXT_PREVIEW_MAX_BYTES) {
      const existing = yield* fileSystem
        .readFileString(absolute)
        .pipe(Effect.mapError(fileFailure(filePath, "read")));
      lineEnding = detectLineEnding(existing);
    }
    const contents = lineEnding === null ? content : convertLineEndings(content, lineEnding);
    yield* writeFileStringAtomically({ filePath: absolute, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(fileFailure(filePath, "write")),
    );
    // The rename swaps in a fresh file, which would otherwise drop an executable bit.
    if (info !== null) {
      yield* fileSystem.chmod(absolute, info.mode & 0o7777).pipe(Effect.ignore({ log: true }));
    }
    yield* stagePath(repo, filePath);
  });

  const resolve: MergeConflictService["Service"]["resolve"] = Effect.fn(
    "MergeConflictService.resolve",
  )(function* (input) {
    const repo = yield* repositoryFor("MergeConflictService.resolve", input.cwd);
    return yield* mutating(
      repo,
      Effect.gen(function* () {
        const stages = yield* requireUnmerged(repo, input.path);
        yield* assertNotStale(repo, input.path, stages, input.expected);
        const resolution = input.resolution;

        if (resolution._tag === "content" || resolution._tag === "workingCopy") {
          const attributes = (yield* checkAttributes(repo, [input.path])).get(input.path);
          if (fileLevelReasonFor(stages, attributes) !== null) {
            return yield* new MergeConflictError({
              reason: "file-level-only",
              path: input.path,
              detail: `${input.path} can only be resolved by choosing a side or deleting it.`,
            });
          }
        }

        if (resolution._tag === "content") {
          if (new TextEncoder().encode(resolution.content).length > MAX_WRITE_BYTES) {
            return yield* new MergeConflictError({
              reason: "content-too-large",
              path: input.path,
              detail: `The resolved content for ${input.path} is too large to apply here.`,
            });
          }
          yield* writeResolvedContent(repo, input.path, resolution.content);
        } else if (resolution._tag === "workingCopy") {
          if ((yield* workingFileInfo(absolutePath(repo, input.path))) === null) {
            return yield* new MergeConflictError({
              reason: "file-level-only",
              path: input.path,
              detail: `${input.path} is missing from the working tree.`,
            });
          }
          yield* stagePath(repo, input.path);
        } else if (resolution._tag === "delete") {
          yield* removePath(repo, input.path);
        } else {
          // "ours" is always stage 2 and "theirs" stage 3, whatever the operation labels them.
          const chosen = resolution.side === "ours" ? stages[2] : stages[3];
          if (chosen === undefined) {
            yield* removePath(repo, input.path);
          } else {
            yield* runGit("MergeConflictService.checkoutSide", repo.root, [
              "--literal-pathspecs",
              "checkout",
              resolution.side === "ours" ? "--ours" : "--theirs",
              "--",
              input.path,
            ]);
            yield* stagePath(repo, input.path);
          }
        }
        return { path: input.path, remaining: yield* countUnmerged(repo) };
      }),
    );
  });

  const reopen: MergeConflictService["Service"]["reopen"] = Effect.fn(
    "MergeConflictService.reopen",
  )(function* (input) {
    const repo = yield* repositoryFor("MergeConflictService.reopen", input.cwd);
    const invalid = assertRepositoryRelative(input.path);
    if (invalid !== null) return yield* invalid;
    return yield* mutating(
      repo,
      Effect.gen(function* () {
        // A resolved path is no longer unmerged, but the index keeps what `checkout -m` needs.
        const undo = yield* runGit("MergeConflictService.resolveUndo", repo.root, [
          "--literal-pathspecs",
          "ls-files",
          "--resolve-undo",
          "-z",
          "--full-name",
          "--",
          input.path,
        ]);
        const stillUnmerged = (yield* listUnmerged(repo, input.path)).has(input.path);
        if (!stillUnmerged && undo.stdout.length === 0) {
          return yield* new MergeConflictError({
            reason: "not-reopenable",
            path: input.path,
            detail: `Git no longer remembers the conflict in ${input.path}, so it cannot be reopened.`,
          });
        }
        yield* runGit("MergeConflictService.reopenCheckout", repo.root, [
          "--literal-pathspecs",
          "checkout",
          "-m",
          "--",
          input.path,
        ]);
        return { path: input.path, remaining: yield* countUnmerged(repo) };
      }),
    );
  });

  const autoResolve: MergeConflictService["Service"]["autoResolve"] = Effect.fn(
    "MergeConflictService.autoResolve",
  )(function* (input) {
    const repo = yield* repositoryFor("MergeConflictService.autoResolve", input.cwd);
    return yield* mutating(
      repo,
      Effect.gen(function* () {
        const unmerged = yield* listUnmerged(repo);
        // Only paths git lists as unmerged are ever touched, whatever the client sent.
        const targets = (input.paths ?? [...unmerged.keys()]).filter((p) => unmerged.has(p));
        const attributes = yield* checkAttributes(repo, targets);
        const resolved: string[] = [];
        const skipped: Array<{ path: string; reason: MergeConflictAutoResolveSkipReason }> = [];

        for (const filePath of targets) {
          const stages = unmerged.get(filePath)!;
          const fileAttributes = attributes.get(filePath);
          const fileLevel = fileLevelReasonFor(stages, fileAttributes);
          if (fileLevel !== null) {
            skipped.push({ path: filePath, reason: fileLevel });
            continue;
          }
          if (!isBuiltinMergeAttribute(fileAttributes?.get("merge"))) {
            skipped.push({ path: filePath, reason: "merge-driver" });
            continue;
          }
          if (!stages[2] || !stages[3]) {
            skipped.push({ path: filePath, reason: "conflicts-remain" });
            continue;
          }
          const blobs = yield* readBlobs(
            repo,
            Object.values(stages).map((entry) => entry.oid),
          );
          const stageText = (entry: StageEntry | undefined) => {
            const blob = entry === undefined ? undefined : blobs.get(entry.oid);
            return entry === undefined ? "" : blob?._tag === "text" ? blob.text : null;
          };
          const [baseText, oursText, theirsText] = [
            stageText(stages[1]),
            stageText(stages[2]),
            stageText(stages[3]),
          ];
          if (baseText === null || oursText === null || theirsText === null) {
            const tooLarge = Object.values(stages).some(
              (entry) => blobs.get(entry.oid)?._tag === "too-large",
            );
            skipped.push({ path: filePath, reason: tooLarge ? "too-large" : "binary" });
            continue;
          }

          const absolute = absolutePath(repo, filePath);
          const info = yield* workingFileInfo(absolute);
          if (info !== null) {
            const existing =
              info.size > FILE_TEXT_PREVIEW_MAX_BYTES
                ? null
                : yield* fileSystem
                    .readFileString(absolute)
                    .pipe(Effect.mapError(fileFailure(filePath, "read")));
            // Without git's markers the file was already edited or resolved; leave it to the user.
            if (existing === null || !hasConflictMarkers(existing)) {
              skipped.push({ path: filePath, reason: "working-copy-edited" });
              continue;
            }
          }

          const merged = computeMerge3(
            { base: baseText, ours: oursText, theirs: theirsText },
            { resolveSimple: true },
          );
          if (merged.stats.conflicts > 0) {
            skipped.push({ path: filePath, reason: "conflicts-remain" });
            continue;
          }
          yield* writeResolvedContent(repo, filePath, merged.initialResult);
          resolved.push(filePath);
        }
        return { resolved, skipped, remaining: yield* countUnmerged(repo) };
      }),
    );
  });

  /** Failure detail for a git run that was supposed to finish an operation (hooks, signing). */
  const operationFailure = (
    result: { readonly stdout: string; readonly stderr: string },
    fallback: string,
  ) =>
    new MergeConflictError({
      reason: "operation-failed",
      detail: boundedDetail(result.stderr.trim() ? result.stderr : result.stdout, fallback),
    });

  const settledOutcome = Effect.fn("MergeConflictService.settledOutcome")(function* (
    repo: Repository,
  ) {
    const operation = yield* currentOperation(repo);
    if (operation === null) return "completed" as const;
    return (yield* countUnmerged(repo)) > 0 ? ("conflicts" as const) : ("paused" as const);
  });

  const runOperation: MergeConflictService["Service"]["runOperation"] = Effect.fn(
    "MergeConflictService.runOperation",
  )(function* (input) {
    const repo = yield* repositoryFor("MergeConflictService.runOperation", input.cwd);
    return yield* mutating(
      repo,
      Effect.gen(function* () {
        const operation = yield* currentOperation(repo);
        if (operation === null) {
          return yield* new MergeConflictError({
            reason: "no-operation",
            detail: "There is no merge, rebase, cherry-pick or revert in progress.",
          });
        }
        const editorEnv = { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };

        if (input.action === "abort") {
          const result = yield* runGit(
            "MergeConflictService.abort",
            repo.root,
            [OPERATION_ARGUMENT[operation.kind], "--abort"],
            { env: editorEnv, allowNonZeroExit: true, timeoutMs: OPERATION_TIMEOUT_MS },
          );
          if (result.exitCode !== 0) {
            return yield* operationFailure(result, `Could not abort the ${operation.kind}.`);
          }
          return { outcome: "aborted" as const };
        }

        if ((yield* countUnmerged(repo)) > 0) {
          return yield* new MergeConflictError({
            reason: "conflicts-remain",
            detail: "Resolve every conflicted file before continuing.",
          });
        }
        const args =
          operation.kind === "merge"
            ? ["commit", "--no-edit"]
            : [OPERATION_ARGUMENT[operation.kind], "--continue"];
        const result = yield* runGit("MergeConflictService.continue", repo.root, args, {
          env: editorEnv,
          allowNonZeroExit: true,
          timeoutMs: OPERATION_TIMEOUT_MS,
        });
        const outcome = yield* settledOutcome(repo);
        if (result.exitCode !== 0) {
          // A rebase that stops on the next commit exits non-zero with fresh conflicts in place.
          if (outcome === "conflicts") return { outcome };
          return yield* operationFailure(result, `Could not continue the ${operation.kind}.`);
        }
        return { outcome };
      }),
    );
  });

  const startLocalMerge: MergeConflictService["Service"]["startLocalMerge"] = Effect.fn(
    "MergeConflictService.startLocalMerge",
  )(function* (input) {
    const repo = yield* repositoryFor("MergeConflictService.startLocalMerge", input.cwd);
    return yield* mutating(
      repo,
      Effect.gen(function* () {
        if (input.baseRefName.startsWith("-")) {
          return yield* new MergeConflictError({
            reason: "operation-failed",
            detail: "That is not a valid base branch name.",
          });
        }
        if ((yield* currentOperation(repo)) !== null) {
          return yield* new MergeConflictError({
            reason: "operation-in-progress",
            detail: "Finish or abort the operation in progress before updating from the base.",
          });
        }
        // A merge can be aborted back to a clean tree only if the tree was clean to begin with.
        const dirty = yield* runGit("MergeConflictService.dirtyCheck", repo.root, [
          "status",
          "--porcelain",
          "--untracked-files=no",
          "-z",
        ]);
        if (dirty.stdout.length > 0) {
          return yield* new MergeConflictError({
            reason: "dirty-working-tree",
            detail: "Commit or stash your changes before updating from the base branch.",
          });
        }

        const fetched = yield* git.fetchWorktreeBaseCommit({
          cwd: repo.root,
          refName: input.baseRefName,
        });
        const target =
          fetched !== null
            ? { sha: fetched.commitSha, ref: fetched.remoteRefName, remote: true }
            : {
                sha: (yield* git.resolveCommit({
                  cwd: repo.root,
                  revision: input.baseRefName,
                })).commitSha,
                ref: input.baseRefName,
                remote: false,
              };

        const ancestor = yield* runGit(
          "MergeConflictService.isAncestor",
          repo.root,
          ["merge-base", "--is-ancestor", target.sha, "HEAD"],
          { allowNonZeroExit: true },
        );
        if (ancestor.exitCode === 0) {
          return { outcome: "up-to-date" as const, mergedRef: target.ref };
        }

        // Git's own wording for the subject, so the conflict labels can show the ref's name.
        const subject = `Merge ${target.remote ? "remote-tracking branch" : "branch"} '${target.ref}'`;
        const result = yield* runGit(
          "MergeConflictService.merge",
          repo.root,
          ["merge", "--no-edit", "-m", subject, target.sha],
          {
            env: { GIT_EDITOR: "true" },
            allowNonZeroExit: true,
            timeoutMs: OPERATION_TIMEOUT_MS,
          },
        );
        if (result.exitCode === 0) return { outcome: "merged" as const, mergedRef: target.ref };
        if ((yield* currentOperation(repo)) !== null && (yield* countUnmerged(repo)) > 0) {
          return { outcome: "conflicts" as const, mergedRef: target.ref };
        }
        return yield* operationFailure(result, `Could not merge ${target.ref}.`);
      }),
    );
  });

  return MergeConflictService.of({
    list,
    read,
    resolve,
    autoResolve,
    reopen,
    runOperation,
    startLocalMerge,
  });
});

export const layer = Layer.effect(MergeConflictService, make);
