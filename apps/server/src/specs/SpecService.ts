import {
  SpecDocument,
  SpecError,
  SpecMutationInput,
  SpecQueryInput,
  SpecQueryResult,
  SpecRole,
  ThreadId,
  type ProjectId,
  type RunId,
  specRoleSupported,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Hex from "effect/encoding/Hex";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  acceptanceCriteria,
  checkCriterionHistory,
  checkReady,
  checkTasks,
  evidenceComplete,
  taskDefinitions,
  transitionAllowed,
} from "./specValidation.ts";

export type SpecCaller =
  | { readonly kind: "human"; readonly subject: string; readonly label: string }
  | { readonly kind: "agent"; readonly threadId: ThreadId };
export interface Binding {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspacePath: string;
  readonly slug: string;
  readonly role: SpecRole;
}
interface RecordRow {
  readonly document_json: string;
  readonly pending_files_json: string | null;
}
interface BindingRow {
  readonly thread_id: string;
  readonly project_id: ProjectId;
  readonly workspace_path: string;
  readonly slug: string;
  readonly role: SpecRole;
}
const failure = (reason: SpecError["reason"], message: string) =>
  new SpecError({ reason, message });
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const withoutError = (document: SpecDocument) => {
  const { error: _error, ...rest } = document;
  return rest;
};
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(SpecDocument));
const decodeFiles = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const readonlyRoles = new Set<SpecRole>(["requirements", "researcher", "verifier"]);
export const isReadOnlyRole = (role: SpecRole) => readonlyRoles.has(role);

export class SpecService extends Context.Service<
  SpecService,
  {
    readonly query: (input: SpecQueryInput) => Effect.Effect<SpecQueryResult, SpecError>;
    readonly mutate: (
      input: SpecMutationInput,
      caller: SpecCaller,
    ) => Effect.Effect<SpecDocument, SpecError>;
    readonly subscribe: (input: SpecQueryInput) => Stream.Stream<SpecQueryResult, SpecError>;
    readonly binding: (threadId: ThreadId) => Effect.Effect<Binding | undefined, SpecError>;
    readonly inherit: (parent: ThreadId, child: ThreadId) => Effect.Effect<void, SpecError>;
    readonly beforeRun: (input: {
      threadId: ThreadId;
      runId?: RunId;
      driver?: string;
    }) => Effect.Effect<{ document: SpecDocument; role: SpecRole } | undefined, SpecError>;
    readonly invalidations: Stream.Stream<readonly ThreadId[]>;
  }
>()("t3/specs/SpecService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const scope = yield* Scope.Scope;
  const changes = yield* PubSub.unbounded<void>();
  const invalidated = yield* PubSub.unbounded<readonly ThreadId[]>();
  // Completed once any thread is bound to a spec; polling waits for it.
  const firstBinding = yield* Deferred.make<void>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const db = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(() => failure("io", "Could not access spec state.")));
  const lockFor = Effect.fn("SpecService.lockFor")(function* (key: string) {
    const existing = locks.get(key);
    if (existing) return existing;
    const lock = yield* Semaphore.make(1);
    locks.set(key, lock);
    return lock;
  });
  const locked = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    lockFor(key).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => failure("io", "Could not hash the spec.")),
    );
  const parse = (value: string) =>
    decodeDocument(value).pipe(
      Effect.mapError(() => failure("inconsistent", "Stored spec data is invalid.")),
    );
  const binding = Effect.fn("SpecService.binding")(function* (threadId: ThreadId) {
    const rows = yield* db(
      sql<BindingRow>`SELECT * FROM spec_bindings WHERE thread_id = ${threadId}`,
    );
    const row = rows[0];
    return row
      ? {
          threadId: ThreadId.make(row.thread_id),
          projectId: row.project_id,
          workspacePath: row.workspace_path,
          slug: row.slug,
          role: row.role,
        }
      : undefined;
  });
  const resolve = Effect.fn("SpecService.resolve")(function* (input: {
    projectId: ProjectId;
    threadId?: ThreadId;
  }) {
    const project = yield* db(projects.get(input.projectId));
    if (Option.isNone(project) || project.value.deletedAt)
      return yield* failure("not-found", "Project not found.");
    if (!input.threadId) return path.resolve(project.value.workspaceRoot);
    const projection = yield* db(projections.getThreadRecords(input.threadId, ["runs"]));
    if (projection.thread.projectId !== input.projectId)
      return yield* failure("forbidden", "The thread belongs to another project.");
    return path.resolve(projection.thread.worktreePath ?? project.value.workspaceRoot);
  });
  const readOptional = Effect.fn("SpecService.readOptional")(function* (file: string) {
    const exists = yield* fs
      .exists(file)
      .pipe(Effect.mapError(() => failure("io", "Could not inspect spec files.")));
    if (!exists) return null;
    const stat = yield* fs
      .stat(file)
      .pipe(Effect.mapError(() => failure("io", "Could not inspect spec files.")));
    if (Number(stat.size) > 1024 * 1024)
      return yield* failure("invalid", "Spec files must be at most 1 MiB.");
    return yield* fs
      .readFileString(file)
      .pipe(Effect.mapError(() => failure("io", "Could not read spec files.")));
  });
  const safePath = Effect.fn("SpecService.safePath")(function* (root: string, relative: string) {
    const absolute = path.resolve(root, relative);
    const within = path.relative(root, absolute);
    if (within.startsWith("..") || path.isAbsolute(within))
      return yield* failure("invalid", "Spec paths must stay inside the checkout.");
    let cursor = root;
    for (const segment of within.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (
        yield* fs
          .exists(cursor)
          .pipe(Effect.mapError(() => failure("io", "Could not inspect the spec path.")))
      ) {
        const resolved = yield* fs
          .realPath(cursor)
          .pipe(Effect.mapError(() => failure("io", "Could not inspect the spec path.")));
        const resolvedRoot = yield* fs
          .realPath(root)
          .pipe(Effect.mapError(() => failure("io", "Could not inspect the checkout.")));
        const relativeResolved = path.relative(resolvedRoot, resolved);
        if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved))
          return yield* failure(
            "invalid",
            "Spec files cannot traverse symbolic links outside the checkout.",
          );
      }
    }
    return absolute;
  });
  const hashes = Effect.fn("SpecService.hashes")(function* (workspace: string, slug: string) {
    const contentPath = yield* safePath(workspace, `specs/${slug}/spec.md`);
    const constitutionPath = yield* safePath(workspace, "specs/constitution.md");
    const content = yield* readOptional(contentPath);
    if (content === null)
      return yield* failure("not-found", "The spec requirements file is missing.");
    const constitution = yield* readOptional(constitutionPath);
    return {
      content,
      specHash: yield* hash(content),
      constitutionHash: constitution === null ? null : yield* hash(constitution),
    };
  });
  const readRow = (workspace: string, slug: string) =>
    db(
      sql<RecordRow>`SELECT document_json, pending_files_json FROM spec_documents WHERE workspace_path = ${workspace} AND slug = ${slug}`,
    );
  const persistFiles = Effect.fn("SpecService.persistFiles")(function* (
    workspace: string,
    slug: string,
  ) {
    const row = (yield* readRow(workspace, slug))[0];
    if (!row?.pending_files_json) return;
    const files = yield* decodeFiles(row.pending_files_json).pipe(
      Effect.mapError(() => failure("inconsistent", "Pending spec files are invalid.")),
    );
    for (const [relative, content] of Object.entries(files)) {
      const destination = yield* safePath(workspace, relative);
      yield* fs
        .makeDirectory(path.dirname(destination), { recursive: true })
        .pipe(Effect.mapError(() => failure("io", "Could not create the spec directory.")));
      const temp = `${destination}.par3-pending`;
      yield* safePath(workspace, path.relative(workspace, temp));
      yield* fs
        .writeFileString(temp, content)
        .pipe(Effect.mapError(() => failure("io", "Could not stage spec files.")));
      yield* fs
        .rename(temp, destination)
        .pipe(Effect.mapError(() => failure("io", "Could not replace spec files.")));
    }
    yield* db(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE spec_documents SET pending_files_json = NULL WHERE workspace_path = ${workspace} AND slug = ${slug}`;
          yield* sql`UPDATE spec_mutations SET completed = 1 WHERE workspace_path = ${workspace} AND slug = ${slug} AND completed = 0`;
        }),
      ),
    );
  });
  const filesFor = (document: SpecDocument) => {
    const prefix = `specs/${document.slug}/`;
    return {
      [`${prefix}spec.md`]: document.content,
      [`${prefix}status.json`]:
        json({
          version: 1,
          title: document.title,
          status: document.status,
          revision: document.revision,
          updatedAt: document.updatedAt,
          supersedes: document.supersedes,
        }) + "\n",
      [`${prefix}tasks.json`]:
        json({ version: 1, tasks: document.tasks, evidence: document.evidence }) + "\n",
      [`${prefix}approval.json`]: json({ version: 1, approval: document.approval }) + "\n",
    };
  };
  const save = Effect.fn("SpecService.save")(function* (
    projectId: ProjectId,
    document: SpecDocument,
    files = filesFor(document),
    command?: { id: string; hash: string },
  ) {
    yield* db(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO spec_documents (project_id, workspace_path, slug, document_json, pending_files_json)
        VALUES (${projectId}, ${document.workspacePath}, ${document.slug}, ${json(document)}, ${json(files)})
        ON CONFLICT(workspace_path, slug) DO UPDATE SET document_json = excluded.document_json, pending_files_json = excluded.pending_files_json`;
          if (command)
            yield* sql`INSERT INTO spec_mutations (command_id, request_hash, workspace_path, slug, result_json)
        VALUES (${command.id}, ${command.hash}, ${document.workspacePath}, ${document.slug}, ${json(document)})`;
        }),
      ),
    );
    yield* persistFiles(document.workspacePath, document.slug);
    yield* PubSub.publish(changes, undefined);
  });
  const hydrateBindings = (document: SpecDocument) =>
    db(
      sql<BindingRow>`SELECT * FROM spec_bindings WHERE workspace_path = ${document.workspacePath} AND slug = ${document.slug}`,
    ).pipe(
      Effect.map((rows) => ({
        ...document,
        bindings: rows.map((row) => ({ threadId: ThreadId.make(row.thread_id), role: row.role })),
      })),
    );
  const refresh = Effect.fn("SpecService.refresh")(function* (
    projectId: ProjectId,
    workspace: string,
    slug: string,
  ) {
    yield* persistFiles(workspace, slug);
    const row = (yield* readRow(workspace, slug))[0];
    if (!row) return yield* failure("not-found", "Spec not found.");
    let document = yield* parse(row.document_json);
    const current = yield* hashes(workspace, slug);
    if (
      document.specHash !== current.specHash ||
      document.constitutionHash !== current.constitutionHash
    ) {
      const history = checkCriterionHistory(document.content, current.content);
      document = {
        ...withoutError(document),
        ...current,
        revision: document.revision + 1,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
        approvalValid: false,
        approval: null,
        evidence: [],
        status: document.status === "draft" ? "draft" : "review",
        findings: checkReady(current.content),
        ...(history ? { error: history } : {}),
      };
      const affected = yield* hydrateBindings(document);
      yield* save(projectId, document);
      yield* PubSub.publish(
        invalidated,
        affected.bindings.map((item) => item.threadId),
      );
    }
    for (const [relative, expected] of Object.entries(filesFor(document)).filter(
      ([relative]) => !relative.endsWith("spec.md"),
    )) {
      const actual = yield* readOptional(yield* safePath(workspace, relative));
      if (actual !== expected)
        document = {
          ...document,
          approvalValid: false,
          error:
            document.error ??
            "Spec metadata was edited outside Par3. Use Reopen to restore server-owned metadata before continuing.",
        };
    }
    return yield* hydrateBindings(document);
  });
  const discover = Effect.fn("SpecService.discover")(function* (
    projectId: ProjectId,
    workspace: string,
  ) {
    const directory = yield* safePath(workspace, "specs");
    if (
      !(yield* fs
        .exists(directory)
        .pipe(Effect.mapError(() => failure("io", "Could not inspect specs."))))
    )
      return;
    const names = yield* fs
      .readDirectory(directory)
      .pipe(Effect.mapError(() => failure("io", "Could not list specs.")));
    for (const slug of names.filter(
      (name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 80,
    )) {
      if ((yield* readRow(workspace, slug)).length) continue;
      const specPath = yield* safePath(workspace, `specs/${slug}/spec.md`);
      if (
        !(yield* fs
          .exists(specPath)
          .pipe(Effect.mapError(() => failure("io", "Could not inspect spec files."))))
      )
        continue;
      const current = yield* hashes(workspace, slug);
      const document: SpecDocument = {
        version: 1,
        slug,
        title: current.content.match(/^#\s+(.+)$/m)?.[1] ?? slug,
        status: "draft",
        revision: 0,
        workspacePath: workspace,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
        approvalValid: false,
        ...current,
        tasks: [],
        evidence: [],
        approval: null,
        findings: checkReady(current.content),
        taskHash: yield* hash("[]"),
        bindings: [],
        error: "Imported spec has no trusted approval. Reopen to initialize its metadata.",
      };
      yield* db(
        sql`INSERT OR IGNORE INTO spec_documents (project_id, workspace_path, slug, document_json) VALUES (${projectId}, ${workspace}, ${slug}, ${json(document)})`,
      );
    }
  });
  const query = Effect.fn("SpecService.query")(function* (input: SpecQueryInput) {
    const workspace = yield* resolve(input);
    return yield* locked(
      workspace,
      Effect.gen(function* () {
        yield* discover(input.projectId, workspace);
        const rows = yield* db(
          sql<{
            slug: string;
          }>`SELECT slug FROM spec_documents WHERE workspace_path = ${workspace} ORDER BY slug LIMIT ${Math.min(input.limit ?? 50, 200) + 1} OFFSET ${input.offset ?? 0}`,
        );
        const summaries: SpecQueryResult["specs"][number][] = [];
        for (const row of rows.slice(0, input.limit ?? 50)) {
          const result = yield* Effect.result(refresh(input.projectId, workspace, row.slug));
          const document =
            result._tag === "Success"
              ? result.success
              : {
                  ...(yield* parse((yield* readRow(workspace, row.slug))[0]!.document_json)),
                  approvalValid: false,
                  error: result.failure.message,
                };
          const {
            content: _content,
            tasks: _tasks,
            evidence: _evidence,
            approval: _approval,
            findings: _findings,
            specHash: _hash,
            constitutionHash: _constitution,
            taskHash: _taskHash,
            bindings: _bindings,
            version: _version,
            ...summary
          } = document;
          summaries.push(summary);
        }
        const currentBinding = input.threadId ? yield* binding(input.threadId) : undefined;
        const selected = input.slug ?? currentBinding?.slug;
        const detail = selected ? yield* refresh(input.projectId, workspace, selected) : undefined;
        return {
          specs: summaries,
          ...(detail ? { detail } : {}),
          ...(rows.length > (input.limit ?? 50)
            ? { nextOffset: (input.offset ?? 0) + (input.limit ?? 50) }
            : {}),
        };
      }),
    );
  });
  const mutate = Effect.fn("SpecService.mutate")(function* (
    input: SpecMutationInput,
    caller: SpecCaller,
  ) {
    const workspace = yield* resolve(input);
    return yield* locked(
      workspace,
      Effect.gen(function* () {
        const requestHash = yield* hash(json({ input, caller }));
        const receipt = (yield* db(
          sql<{
            request_hash: string;
            result_json: string;
          }>`SELECT request_hash, result_json FROM spec_mutations WHERE command_id = ${input.commandId}`,
        ))[0];
        if (receipt) {
          if (receipt.request_hash !== requestHash)
            return yield* failure(
              "conflict",
              "This command ID was already used for another operation.",
            );
          yield* persistFiles(workspace, input.slug);
          return yield* parse(receipt.result_json);
        }
        let callerRole: SpecRole | "human" = "human";
        if (caller.kind === "agent") {
          const own = yield* binding(caller.threadId);
          if (
            !own ||
            own.projectId !== input.projectId ||
            own.workspacePath !== workspace ||
            own.slug !== input.slug ||
            input.threadId !== caller.threadId
          )
            return yield* failure(
              "forbidden",
              "Agents may change only their bound spec in their own checkout.",
            );
          callerRole = own.role;
          if (
            [
              "approve",
              "reject",
              "request-changes",
              "reopen",
              "confirm-evidence",
              "bind",
              "unbind",
            ].includes(input.action)
          )
            return yield* failure("forbidden", "This spec action requires a human client.");
        }
        const existing = (yield* readRow(workspace, input.slug))[0];
        let document: SpecDocument;
        if (input.action === "create") {
          if (
            existing ||
            (yield* fs
              .exists(yield* safePath(workspace, `specs/${input.slug}`))
              .pipe(Effect.mapError(() => failure("io", "Could not inspect the spec directory."))))
          )
            return yield* failure("conflict", "That spec already exists. Choose another slug.");
          const config = yield* db(settings.getSettings);
          if (
            !(
              config.projectSettingsOverrides[input.projectId]?.specModeEnabled ??
              config.specModeEnabled
            )
          )
            return yield* failure("disabled", "Enable Spec mode in project Settings first.");
          if (input.expectedRevision !== 0)
            return yield* failure("conflict", "New specs start at revision zero.");
          const constitution = yield* readOptional(
            yield* safePath(workspace, "specs/constitution.md"),
          );
          document = {
            version: 1,
            slug: input.slug,
            title: input.title,
            status: "draft",
            revision: 1,
            workspacePath: workspace,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
            approvalValid: false,
            content: input.content,
            specHash: yield* hash(input.content),
            constitutionHash: constitution === null ? null : yield* hash(constitution),
            taskHash: yield* hash("[]"),
            tasks: [],
            evidence: [],
            approval: null,
            findings: checkReady(input.content),
            bindings: [],
            ...(input.supersedes ? { supersedes: input.supersedes } : {}),
          };
        } else {
          if (!existing) return yield* failure("not-found", "Spec not found.");
          document =
            input.action === "reopen"
              ? yield* parse(existing.document_json)
              : yield* refresh(input.projectId, workspace, input.slug);
          if (document.revision !== input.expectedRevision)
            return yield* failure("conflict", "This spec changed. Reload before trying again.");
          if (
            document.error &&
            input.action !== "reopen" &&
            input.action !== "update" &&
            input.action !== "unbind"
          )
            return yield* failure("inconsistent", document.error);
          document = {
            ...document,
            revision: document.revision + 1,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          switch (input.action) {
            case "update": {
              if (callerRole !== "human" && callerRole !== "requirements")
                return yield* failure(
                  "forbidden",
                  "Only Requirements agents or humans can edit requirements.",
                );
              if (document.status === "done")
                return yield* failure(
                  "invalid",
                  "Create a superseding spec to change completed requirements.",
                );
              const invalid = checkCriterionHistory(document.content, input.content);
              if (invalid) return yield* failure("invalid", invalid);
              const changed = input.content !== document.content;
              document = {
                ...withoutError(document),
                content: input.content,
                title: input.title ?? document.title,
                specHash: yield* hash(input.content),
                findings: checkReady(input.content),
                ...(changed
                  ? {
                      approvalValid: false,
                      approval: null,
                      evidence: [],
                      status: document.status === "draft" ? "draft" : "review",
                    }
                  : {}),
              };
              if (changed)
                yield* PubSub.publish(
                  invalidated,
                  document.bindings.map((item) => item.threadId),
                );
              break;
            }
            case "request-review":
              if (callerRole !== "human" && callerRole !== "requirements")
                return yield* failure("forbidden", "Only Requirements agents can request review.");
              if (!["draft", "review"].includes(document.status) || document.findings.length)
                return yield* failure(
                  "invalid",
                  "Resolve readiness findings before requesting review.",
                );
              document = { ...document, status: "review" };
              break;
            case "approve": {
              if (
                caller.kind !== "human" ||
                document.status !== "review" ||
                document.findings.length
              )
                return yield* failure(
                  "forbidden",
                  "Only a human can approve a ready spec under review.",
                );
              document = {
                ...document,
                status: "approved",
                approvalValid: true,
                approval: {
                  subject: caller.subject,
                  label: caller.label,
                  approvedAt: DateTime.formatIso(yield* DateTime.now),
                  revision: document.revision,
                  specHash: document.specHash,
                  constitutionHash: document.constitutionHash,
                },
              };
              break;
            }
            case "reject":
            case "request-changes":
              if (document.status !== "review")
                return yield* failure(
                  "invalid",
                  "Only a spec under review can receive this decision.",
                );
              document = {
                ...document,
                status: input.action === "reject" ? "rejected" : "draft",
                approval: null,
                approvalValid: false,
              };
              break;
            case "reopen": {
              const current = yield* hashes(workspace, input.slug);
              const unchanged =
                current.specHash === document.specHash &&
                current.constitutionHash === document.constitutionHash;
              document = {
                ...withoutError(document),
                ...current,
                findings: checkReady(current.content),
                status:
                  unchanged && document.approvalValid && document.approval
                    ? "in-progress"
                    : "draft",
                ...(unchanged ? {} : { approval: null, approvalValid: false, evidence: [] }),
              };
              break;
            }
            case "transition": {
              if (!transitionAllowed(document.status, input.status, callerRole))
                return yield* failure(
                  "forbidden",
                  "This role cannot make that lifecycle transition.",
                );
              if (!document.approvalValid || !document.approval)
                return yield* failure(
                  "approval-required",
                  "Approve the current requirements before implementation.",
                );
              if (["in-progress", "implemented", "done"].includes(input.status)) {
                const problem = checkTasks(document.content, document.tasks);
                if (problem) return yield* failure("invalid", problem);
              }
              if (
                ["implemented", "done"].includes(input.status) &&
                document.tasks.some((task) => task.status !== "passed")
              )
                return yield* failure("invalid", "Every task must pass its verification first.");
              if (input.status === "done" && !evidenceComplete(document))
                return yield* failure(
                  "invalid",
                  "Every active criterion needs current passing evidence, with human confirmation for manual checks.",
                );
              document = { ...document, status: input.status };
              break;
            }
            case "tasks": {
              if (callerRole !== "human" && callerRole !== "implementation")
                return yield* failure("forbidden", "Only Implementation agents can update tasks.");
              if (!document.approvalValid)
                return yield* failure(
                  "approval-required",
                  "Approve requirements before planning implementation tasks.",
                );
              const problem = checkTasks(document.content, input.tasks);
              if (problem) return yield* failure("invalid", problem);
              const taskHash = yield* hash(json(taskDefinitions(input.tasks)));
              document = {
                ...document,
                tasks: input.tasks,
                taskHash,
                ...(taskHash !== document.taskHash
                  ? { evidence: [], status: "approved" as const }
                  : {}),
              };
              break;
            }
            case "evidence": {
              if (
                callerRole !== "human" &&
                callerRole !== "test" &&
                callerRole !== "implementation"
              )
                return yield* failure(
                  "forbidden",
                  "This role cannot record verification evidence.",
                );
              if (!document.approvalValid)
                return yield* failure(
                  "approval-required",
                  "Approval must be current to record evidence.",
                );
              const active = new Set(
                acceptanceCriteria(document.content)
                  .filter((item) => !item.retired)
                  .map((item) => item.id),
              );
              if (
                new Set(input.evidence.map((item) => item.id)).size !== input.evidence.length ||
                input.evidence.some(
                  (item) =>
                    !item.acs.length ||
                    item.acs.some((id) => !active.has(id)) ||
                    item.requirementsHash !== document.specHash ||
                    item.taskHash !== document.taskHash,
                )
              )
                return yield* failure(
                  "invalid",
                  "Evidence must have unique IDs and reference the current requirements, tasks, and active criteria.",
                );
              document = {
                ...document,
                evidence: input.evidence.map((item) => ({
                  id: item.id,
                  acs: item.acs,
                  kind: item.kind,
                  description: item.description,
                  checkpoint: item.checkpoint,
                  requirementsHash: item.requirementsHash,
                  taskHash: item.taskHash,
                  passed: item.passed,
                })),
              };
              break;
            }
            case "confirm-evidence": {
              if (caller.kind !== "human")
                return yield* failure("forbidden", "Manual checks need human confirmation.");
              if (
                !document.evidence.some(
                  (item) => item.id === input.evidenceId && item.kind === "manual",
                )
              )
                return yield* failure("not-found", "Manual evidence not found.");
              document = {
                ...document,
                evidence: document.evidence.map((item) =>
                  item.id === input.evidenceId ? { ...item, confirmedBy: caller.subject } : item,
                ),
              };
              break;
            }
            case "bind": {
              if (!input.threadId)
                return yield* failure("invalid", "Choose a thread before binding a spec.");
              const projection = yield* db(projections.getThreadRecords(input.threadId, ["runs"]));
              if (
                projection.runs.some((run) =>
                  ["preparing", "starting", "running", "waiting"].includes(run.status),
                )
              )
                return yield* failure("conflict", "Stop the thread before changing its spec role.");
              yield* db(
                sql`INSERT INTO spec_bindings (thread_id, project_id, workspace_path, slug, role) VALUES (${input.threadId}, ${input.projectId}, ${workspace}, ${input.slug}, ${input.role}) ON CONFLICT(thread_id) DO UPDATE SET workspace_path=excluded.workspace_path, slug=excluded.slug, role=excluded.role`,
              );
              yield* Deferred.succeed(firstBinding, undefined);
              break;
            }
            case "unbind":
              if (!input.threadId)
                return yield* failure("invalid", "Choose a thread before leaving Spec mode.");
              if (
                (yield* db(projections.getThreadRecords(input.threadId, ["runs"]))).runs.some(
                  (run) => ["preparing", "starting", "running", "waiting"].includes(run.status),
                )
              )
                return yield* failure("conflict", "Stop the thread before leaving Spec mode.");
              yield* db(sql`DELETE FROM spec_bindings WHERE thread_id = ${input.threadId}`);
              break;
            case "artifact":
              if (
                callerRole !== "human" &&
                callerRole !== "implementation" &&
                callerRole !== "test"
              )
                return yield* failure(
                  "forbidden",
                  "This role cannot write implementation artifacts.",
                );
              if (!document.approvalValid)
                return yield* failure(
                  "approval-required",
                  "Approve requirements before writing implementation artifacts.",
                );
              if (
                !/^(?:test-plan\.md|decisions\.md|evidence\/[a-zA-Z0-9_-]+\.(?:md|txt|json))$/.test(
                  input.path,
                )
              )
                return yield* failure(
                  "invalid",
                  "Choose test-plan.md, decisions.md, or an evidence file.",
                );
              break;
          }
        }
        document = yield* hydrateBindings(document);
        const files = {
          ...filesFor(document),
          ...(input.action === "artifact"
            ? { [`specs/${input.slug}/${input.path}`]: input.content }
            : {}),
        };
        yield* save(input.projectId, document, files, { id: input.commandId, hash: requestHash });
        return document;
      }),
    );
  });
  const beforeRun = Effect.fn("SpecService.beforeRun")(function* (input: {
    threadId: ThreadId;
    runId?: RunId;
    driver?: string;
  }) {
    const linked = yield* binding(input.threadId);
    if (!linked) return undefined;
    const workspace = yield* resolve({ projectId: linked.projectId, threadId: input.threadId });
    if (workspace !== linked.workspacePath)
      return yield* failure(
        "approval-required",
        "The thread changed checkouts. Review and bind the spec in its destination checkout.",
      );
    return yield* locked(
      workspace,
      Effect.gen(function* () {
        if (input.driver !== undefined && !specRoleSupported(input.driver, linked.role))
          return yield* failure(
            "unsupported-provider",
            "This provider cannot enforce the selected Spec role. Select a supported provider.",
          );
        const document = yield* refresh(linked.projectId, workspace, linked.slug);
        if (document.error) return yield* failure("inconsistent", document.error);
        if (
          !isReadOnlyRole(linked.role) &&
          (!document.approvalValid ||
            !document.approval ||
            !["approved", "in-progress", "implemented"].includes(document.status))
        )
          return yield* failure(
            "approval-required",
            "Implementation is blocked until these requirements have current human approval.",
          );
        if (input.runId)
          yield* db(
            sql`INSERT OR REPLACE INTO spec_run_bindings (run_id, thread_id, workspace_path, slug, role, requirements_hash, revision) VALUES (${input.runId}, ${input.threadId}, ${workspace}, ${linked.slug}, ${linked.role}, ${document.specHash}, ${document.revision})`,
          );
        return { document, role: linked.role };
      }),
    );
  });
  const inherit = Effect.fn("SpecService.inherit")(function* (parent: ThreadId, child: ThreadId) {
    const source = yield* binding(parent);
    if (!source) return;
    const workspace = yield* resolve({ projectId: source.projectId, threadId: child });
    yield* db(
      sql`INSERT OR IGNORE INTO spec_bindings (thread_id, project_id, workspace_path, slug, role) VALUES (${child}, ${source.projectId}, ${workspace}, ${source.slug}, ${source.role})`,
    );
    yield* Deferred.succeed(firstBinding, undefined);
  });
  const pending = yield* db(
    sql<{
      project_id: ProjectId;
      workspace_path: string;
      slug: string;
    }>`SELECT project_id, workspace_path, slug FROM spec_documents`,
  );
  for (const record of pending)
    yield* persistFiles(record.workspace_path, record.slug).pipe(Effect.catch(() => Effect.void));
  // Poll instead of fs.watch: watchers hold directory handles that block deleting worktrees on Windows,
  // and only specs bound to a thread can have work to interrupt.
  const pollBound = Effect.gen(function* () {
    const bound = yield* db(
      sql<{
        project_id: ProjectId;
        workspace_path: string;
        slug: string;
      }>`SELECT DISTINCT project_id, workspace_path, slug FROM spec_bindings`,
    );
    for (const row of bound)
      yield* locked(row.workspace_path, refresh(row.project_id, row.workspace_path, row.slug)).pipe(
        Effect.catch(() => Effect.void),
      );
  }).pipe(Effect.catch(() => Effect.void));
  // Most servers never bind a spec, so they never poll.
  const existingBindings = yield* db(sql`SELECT 1 FROM spec_bindings LIMIT 1`).pipe(
    Effect.orElseSucceed(() => []),
  );
  if (existingBindings.length > 0) yield* Deferred.succeed(firstBinding, undefined);
  yield* Deferred.await(firstBinding).pipe(
    Effect.andThen(pollBound.pipe(Effect.repeat(Schedule.spaced("2 seconds")))),
    Effect.forkIn(scope),
  );
  return SpecService.of({
    query,
    mutate,
    binding,
    beforeRun,
    inherit,
    invalidations: Stream.fromPubSub(invalidated),
    subscribe: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.fromEffect(query(input)).pipe(
            Stream.concat(
              Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => query(input))),
            ),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(SpecService, make);

/** For harnesses that never bind threads to specs. */
export const layerDisabled = Layer.succeed(
  SpecService,
  SpecService.of({
    query: () => Effect.fail(failure("disabled", "Spec mode is unavailable.")),
    mutate: () => Effect.fail(failure("disabled", "Spec mode is unavailable.")),
    subscribe: () => Stream.fail(failure("disabled", "Spec mode is unavailable.")),
    binding: () => Effect.succeed(undefined),
    inherit: () => Effect.void,
    beforeRun: () => Effect.succeed(undefined),
    invalidations: Stream.empty,
  }),
);
