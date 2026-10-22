import { SpecError, type SpecFinding } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ProcessRunner from "../processRunner.ts";
import {
  appendApproval,
  approvedStatusJson,
  detectIndent,
  parseJsonObject,
  readStatusTableStatus,
  serializeJson,
  setStatusTableStatus,
  validatorErrors,
} from "./baseFiles.ts";
import {
  countFrontmatterKey,
  readFrontmatterStatus,
  setFrontmatterStatus,
  setFrontmatterUpdated,
} from "./specFrontmatter.ts";

const failure = (reason: SpecError["reason"], message: string) =>
  new SpecError({ reason, message });

/** Lets tests act between the approval snapshot and its writes, or fail one write. */
export class ApprovalHooks extends Context.Reference<{
  readonly afterSnapshot: Effect.Effect<void>;
  readonly beforeWrite: (relative: string) => Effect.Effect<void, SpecError>;
}>("t3/specs/ApprovalHooks", {
  defaultValue: () => ({ afterSnapshot: Effect.void, beforeWrite: () => Effect.void }),
}) {}

export interface BaseEnv {
  readonly fs: FileSystem.FileSystem;
  readonly safePath: (root: string, relative: string) => Effect.Effect<string, SpecError>;
  readonly sha256: (bytes: Uint8Array) => Effect.Effect<string, SpecError>;
}

interface PlannedWrite {
  readonly relative: string;
  readonly absolute: string;
  readonly before: Uint8Array | null;
  readonly after: Uint8Array;
}

export interface ApprovalPlan {
  /** Every file the plan read; none may differ when the writes start. */
  readonly snapshot: ReadonlyArray<{
    readonly relative: string;
    readonly absolute: string;
    readonly before: Uint8Array | null;
  }>;
  readonly writes: ReadonlyArray<PlannedWrite>;
  /** spec.md as it will be on disk, without a leading byte order mark. */
  readonly specContent: string;
}

const MAX_FILE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const BOM = "﻿";

const sameBytes = (left: Uint8Array | null, right: Uint8Array | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]));

export const makeBaseWorkflow = (env: BaseEnv) => {
  const { fs } = env;

  const readBytes = Effect.fn("BaseWorkflow.readBytes")(function* (absolute: string) {
    const exists = yield* fs
      .exists(absolute)
      .pipe(Effect.mapError(() => failure("io", "Could not inspect spec files.")));
    if (!exists) return null;
    const stat = yield* fs
      .stat(absolute)
      .pipe(Effect.mapError(() => failure("io", "Could not inspect spec files.")));
    if (Number(stat.size) > MAX_FILE_BYTES)
      return yield* failure("invalid", "Spec files must be at most 1 MiB.");
    return yield* fs
      .readFile(absolute)
      .pipe(Effect.mapError(() => failure("io", "Could not read spec files.")));
  });

  // Keeps a byte order mark as a character so the file can be written back as it was.
  const decode = (relative: string, bytes: Uint8Array) =>
    Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () => failure("invalid", `${relative} is not valid UTF-8.`),
    });

  const writeAtomic = Effect.fn("BaseWorkflow.writeAtomic")(function* (
    absolute: string,
    bytes: Uint8Array,
  ) {
    const temp = `${absolute}.par3-tmp`;
    yield* fs.writeFile(temp, bytes);
    yield* fs.rename(temp, absolute);
  });

  const planApproval = Effect.fn("BaseWorkflow.planApproval")(function* (input: {
    readonly workspace: string;
    readonly slug: string;
    readonly confirmedAt: string;
    readonly confirmedBy: string;
  }) {
    const { workspace, slug, confirmedAt, confirmedBy } = input;
    const snapshot: Array<ApprovalPlan["snapshot"][number]> = [];
    const read = Effect.fn("BaseWorkflow.planApproval.read")(function* (relative: string) {
      const absolute = yield* env.safePath(workspace, relative);
      const before = yield* readBytes(absolute);
      snapshot.push({ relative, absolute, before });
      return { relative, absolute, before };
    });
    const specFile = yield* read(`specs/${slug}/spec.md`);
    const statusFile = yield* read(`specs/${slug}/status.json`);
    const approvalFile = yield* read(`specs/${slug}/approval.json`);
    const testPlanFile = yield* read(`specs/${slug}/test-plan.json`);
    const tableFile = yield* read("specs/_status.md");

    const text = (file: { relative: string; before: Uint8Array }) =>
      decode(file.relative, file.before);

    if (specFile.before === null) return yield* failure("not-found", "The spec file is missing.");
    const specText = yield* text({ relative: specFile.relative, before: specFile.before });
    const bom = specText.startsWith(BOM) ? BOM : "";
    const specBody = bom ? specText.slice(1) : specText;
    if (
      countFrontmatterKey(specBody, "status") !== 1 ||
      readFrontmatterStatus(specBody) !== "review"
    )
      return yield* failure(
        "invalid",
        "spec.md needs a single frontmatter status of review to be approved.",
      );

    if (statusFile.before === null)
      return yield* failure("invalid", `specs/${slug}/status.json is missing.`);
    const statusJson = parseJsonObject(
      yield* text({ relative: statusFile.relative, before: statusFile.before }),
    );
    if (!statusJson)
      return yield* failure("invalid", `specs/${slug}/status.json must be a JSON object.`);

    if (tableFile.before === null) return yield* failure("invalid", "specs/_status.md is missing.");
    const tableText = yield* text({ relative: tableFile.relative, before: tableFile.before });
    const rowStatus = readStatusTableStatus(tableText, slug);
    if (rowStatus === undefined)
      return yield* failure("invalid", `specs/_status.md has no row for ${slug}.`);
    if (rowStatus !== "review")
      return yield* failure(
        "invalid",
        `specs/_status.md lists ${slug} as ${rowStatus || "empty"}, not review.`,
      );

    const specAfter =
      bom + setFrontmatterUpdated(setFrontmatterStatus(specBody, "approved"), confirmedAt);
    const specAfterBytes = encoder.encode(specAfter);
    const artifacts: Record<string, string> = { "spec.md": yield* env.sha256(specAfterBytes) };
    const writes: PlannedWrite[] = [];

    if (testPlanFile.before !== null) {
      const testPlanText = yield* text({
        relative: testPlanFile.relative,
        before: testPlanFile.before,
      });
      const plan = parseJsonObject(testPlanText);
      if (
        !plan ||
        plan.spec !== slug ||
        !["draft", "review", "approved"].includes(String(plan.status)) ||
        !Array.isArray(plan.cases) ||
        plan.cases.length === 0
      )
        return yield* failure(
          "invalid",
          `specs/${slug}/test-plan.json is not a valid test plan for this spec. Fix or remove it before approving.`,
        );
      if (plan.status === "approved") {
        artifacts["test-plan.json"] = yield* env.sha256(testPlanFile.before);
      } else {
        const after = encoder.encode(
          serializeJson({ ...plan, status: "approved" }, detectIndent(testPlanText)),
        );
        artifacts["test-plan.json"] = yield* env.sha256(after);
        writes.push({ ...testPlanFile, after });
      }
    }

    const approvalText =
      approvalFile.before === null
        ? null
        : yield* text({ relative: approvalFile.relative, before: approvalFile.before });
    const approvalAfter = appendApproval(approvalText, {
      confirmedBy,
      confirmedAt,
      source: "button",
      artifacts,
    });
    if (approvalAfter === undefined)
      return yield* failure(
        "invalid",
        `specs/${slug}/approval.json is not an approval log with an approvals list.`,
      );
    writes.push({ ...approvalFile, after: encoder.encode(approvalAfter) });
    writes.push({
      ...statusFile,
      after: encoder.encode(
        serializeJson(
          approvedStatusJson(statusJson, confirmedAt),
          detectIndent(yield* text({ relative: statusFile.relative, before: statusFile.before })),
        ),
      ),
    });
    writes.push({
      ...tableFile,
      after: encoder.encode(setStatusTableStatus(tableText, slug, "approved")!),
    });
    writes.push({ ...specFile, after: specAfterBytes });
    return {
      snapshot,
      writes,
      specContent: bom ? specAfter.slice(1) : specAfter,
    } satisfies ApprovalPlan;
  });

  /**
   * Writes the plan once nothing it read has changed. Each file lands by temp file and rename; if
   * one fails the files already written are put back, so approval is all or nothing.
   */
  const applyApproval = Effect.fn("BaseWorkflow.applyApproval")(function* (plan: ApprovalPlan) {
    const hooks = yield* ApprovalHooks;
    yield* hooks.afterSnapshot;
    for (const file of plan.snapshot) {
      const now = yield* readBytes(file.absolute);
      if (!sameBytes(now, file.before))
        return yield* failure(
          "conflict",
          `${file.relative} changed after the approval was requested. Review the spec and approve again.`,
        );
    }
    const done: PlannedWrite[] = [];
    const restore = Effect.fn("BaseWorkflow.applyApproval.restore")(function* (file: PlannedWrite) {
      yield* (
        file.before === null
          ? fs.remove(file.absolute, { force: true })
          : writeAtomic(file.absolute, file.before)
      ).pipe(Effect.ignore);
      yield* fs.remove(`${file.absolute}.par3-tmp`, { force: true }).pipe(Effect.ignore);
    });
    for (const file of plan.writes) {
      const written = yield* hooks
        .beforeWrite(file.relative)
        .pipe(
          Effect.andThen(
            writeAtomic(file.absolute, file.after).pipe(
              Effect.mapError(() => failure("io", `Could not write ${file.relative}.`)),
            ),
          ),
          Effect.exit,
        );
      if (written._tag === "Success") {
        done.push(file);
        continue;
      }
      yield* Effect.forEach([file, ...done.toReversed()], restore, { discard: true });
      return yield* failure(
        "io",
        `Could not write ${file.relative}. The approval was rolled back; nothing changed.`,
      );
    }
  });

  /** Mirrors a status change into the project's `_status.md` row; a project without one is left alone. */
  const syncStatusTable = Effect.fn("BaseWorkflow.syncStatusTable")(function* (
    workspace: string,
    slug: string,
    status: string,
  ) {
    const absolute = yield* env.safePath(workspace, "specs/_status.md");
    const before = yield* readBytes(absolute);
    if (before === null) return;
    const text = yield* decode("specs/_status.md", before);
    const after = setStatusTableStatus(text, slug, status);
    if (after === undefined || after === text) return;
    yield* writeAtomic(absolute, encoder.encode(after)).pipe(
      Effect.mapError(() => failure("io", "Could not update specs/_status.md.")),
    );
  });

  return { readBytes, planApproval, applyApproval, syncStatusTable };
};

const VALIDATOR_TIMEOUT = "60 seconds";
const INTERPRETERS: ReadonlyArray<ReadonlyArray<string>> = [
  ["python3"],
  ["python"],
  ["uv", "run", "python"],
];
// Where BASE projects keep their validators, relative to the workspace root.
const SPEC_VALIDATOR = "specs/validate_spec.py";
const STATUS_VALIDATOR = ".github/skills/spec-status/validate_status.py";

// On Windows `python3` and `python` may be the Microsoft Store alias: it starts, exits 9009 or says
// Python was not found, and never runs the script. A script that ran and failed is anything else.
const STORE_STUB_MESSAGE = /Python was not found/i;
const interpreterMissing = Effect.fn("BaseValidators.interpreterMissing")(function* (output: {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}) {
  if (output.code === 0) return false;
  return (
    output.code === 9009 ||
    STORE_STUB_MESSAGE.test(output.stderr) ||
    STORE_STUB_MESSAGE.test(output.stdout) ||
    (yield* ProcessRunner.isWindowsCommandNotFound(output.code, output.stderr))
  );
});

export interface ValidatorReport {
  readonly ran: boolean;
  readonly errors: ReadonlyArray<SpecFinding>;
  readonly warnings: ReadonlyArray<string>;
}

export const PYTHON_MISSING = "Python is needed to run the BASE validators.";

export const makeBaseValidators = (
  env: Pick<BaseEnv, "fs" | "safePath">,
  runner: ProcessRunner.ProcessRunner["Service"],
) => {
  const { fs } = env;

  const exists = (workspace: string, relative: string) =>
    env.safePath(workspace, relative).pipe(
      Effect.flatMap((absolute) => fs.exists(absolute)),
      Effect.orElseSucceed(() => false),
    );

  type Attempt =
    | { readonly kind: "ran"; readonly interpreter: number; readonly errors: string[] }
    | { readonly kind: "missing" }
    | { readonly kind: "timeout" };

  // The first interpreter that starts wins; later scripts reuse it instead of probing again.
  const attempt = Effect.fn("BaseValidators.attempt")(function* (
    workspace: string,
    args: ReadonlyArray<string>,
    from: number,
  ) {
    for (let index = from; index < INTERPRETERS.length; index += 1) {
      const [command, ...prefix] = INTERPRETERS[index]!;
      const result = yield* Effect.result(
        runner.run({
          command: command!,
          args: [...prefix, ...args],
          cwd: workspace,
          timeout: VALIDATOR_TIMEOUT,
          outputMode: "truncate",
          maxOutputBytes: 1024 * 1024,
        }),
      );
      if (result._tag === "Failure") {
        if (result.failure._tag === "ProcessTimeoutError") return { kind: "timeout" } as Attempt;
        if (result.failure._tag === "ProcessSpawnError") continue;
        return { kind: "ran", interpreter: index, errors: [result.failure.message] } as Attempt;
      }
      const output = result.success;
      if (output.timedOut) return { kind: "timeout" } as Attempt;
      if (yield* interpreterMissing(output)) continue;
      return {
        kind: "ran",
        interpreter: index,
        errors: validatorErrors(output),
      } as Attempt;
    }
    return { kind: "missing" } as Attempt;
  });

  const run = Effect.fn("BaseValidators.run")(function* (
    workspace: string,
    slug: string,
  ): Effect.fn.Return<ValidatorReport> {
    const scripts: Array<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [];
    if (yield* exists(workspace, SPEC_VALIDATOR))
      scripts.push({
        name: "validate_spec.py",
        args: [SPEC_VALIDATOR, `specs/${slug}`, "--json"],
      });
    if (yield* exists(workspace, STATUS_VALIDATOR))
      scripts.push({
        name: "validate_status.py",
        args: [STATUS_VALIDATOR, `specs/${slug}/status.json`],
      });
    if (!scripts.length) return { ran: false, errors: [], warnings: [] };

    const errors: SpecFinding[] = [];
    const warnings: string[] = [];
    let interpreter = 0;
    let ran = false;
    for (const script of scripts) {
      const result = yield* attempt(workspace, script.args, interpreter);
      if (result.kind === "missing")
        return { ran, errors, warnings: [...warnings, PYTHON_MISSING] };
      if (result.kind === "timeout") {
        warnings.push(`${script.name} did not finish within a minute and was skipped.`);
        continue;
      }
      ran = true;
      interpreter = result.interpreter;
      for (const message of result.errors) errors.push({ code: "validator", message });
    }
    return { ran, errors, warnings };
  });

  return { run };
};

export const validatorBlock = (errors: ReadonlyArray<SpecFinding>) =>
  errors.length
    ? `The project's validators reported errors: ${errors
        .slice(0, 3)
        .map((item) => item.message)
        .join(
          "; ",
        )}${errors.length > 3 ? `; and ${errors.length - 3} more` : ""}. Fix them (spec_validate shows all) and try again.`
    : undefined;
