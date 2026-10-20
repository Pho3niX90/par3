import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type SpecMutationInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpecService from "./SpecService.ts";

const now = "2026-10-20T00:00:00.000Z";
const human = { kind: "human" as const, subject: "reviewer-1", label: "Reviewer" };
const content = `# Example

## Summary
Save and restore a setting.

## Scope
Persist the setting between sessions.

## Users and scenarios
An operator enables the feature and returns later.

## Acceptance criteria
- AC-1: The setting is saved.
- AC-2: The setting is restored.

## Constraints
Use the existing settings store.

## Open questions
None.

## Design notes
Keep the setting project scoped.
`;

const threads = new Map<
  string,
  { projectId: ProjectId; workspacePath: string; activeRunId: string | null }
>();
const layerProjectionStore = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
  getThreadRecords: (threadId: ThreadId) => {
    const thread = threads.get(threadId);
    if (!thread) return Effect.die(`Unexpected test thread ${threadId}`);
    return Effect.succeed({
      thread: {
        projectId: thread.projectId,
        worktreePath: thread.workspacePath,
        activeRunId: thread.activeRunId,
      },
      runs: [],
    });
  },
} as never);

const layerTest = SpecService.layer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(layerProjectionStore),
  Layer.provideMerge(ServerSettings.layerTest({ specModeEnabled: true })),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const createProject = (projectId: ProjectId, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`event:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: "Spec test project",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  });

const mutation = (
  action: SpecMutationInput["action"],
  projectId: ProjectId,
  slug: string,
  commandId: string,
  expectedRevision: number,
  fields: Record<string, unknown> = {},
) =>
  ({
    action,
    projectId,
    slug,
    commandId: CommandId.make(commandId),
    expectedRevision,
    ...fields,
  }) as SpecMutationInput;

const createSpec = (projectId: ProjectId, slug: string, commandId: string, body = content) =>
  mutation("create", projectId, slug, commandId, 0, {
    title: "Example",
    content: body,
  });

const reviewAndApprove = Effect.fn("SpecServiceTest.reviewAndApprove")(function* (
  service: SpecService.SpecService["Service"],
  projectId: ProjectId,
  slug: string,
  revision: number,
  suffix: string,
) {
  const review = yield* service.mutate(
    mutation("request-review", projectId, slug, `command:${suffix}:review`, revision),
    human,
  );
  return yield* service.mutate(
    mutation("approve", projectId, slug, `command:${suffix}:approve`, review.revision),
    human,
  );
});

const bind = (
  service: SpecService.SpecService["Service"],
  projectId: ProjectId,
  threadId: ThreadId,
  slug: string,
  role: "requirements" | "implementation" | "test" | "researcher" | "verifier",
  revision: number,
  suffix: string,
) =>
  service.mutate(
    mutation("bind", projectId, slug, `command:${suffix}:bind`, revision, { threadId, role }),
    human,
  );

const queryAfterServiceRestart = (input: { projectId: ProjectId; slug: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const dependencies = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, fs),
      Layer.succeed(Path.Path, path),
      Layer.succeed(Crypto.Crypto, crypto),
      Layer.succeed(SqlClient.SqlClient, sql),
      Layer.succeed(ProjectStore.ProjectStoreV2, projects),
      Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
      Layer.succeed(ServerSettings.ServerSettingsService, settings),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          Layer.fresh(SpecService.layer).pipe(Layer.provide(dependencies)),
        );
        return yield* Context.get(context, SpecService.SpecService).query(input);
      }),
    );
  });

const scopedWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-spec-service-" });
});

it.layer(layerTest)("SpecService", (it) => {
  it.effect("creates, reviews, and approves a spec with a human decision", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:spec-approval");
      yield* createProject(projectId, workspaceRoot);

      const created = yield* service.mutate(
        createSpec(projectId, "setting-lifecycle", "command:spec:create"),
        human,
      );
      assert.equal(created.status, "draft");
      assert.equal(created.revision, 1);
      assert.isFalse(created.approvalValid);

      const approval = yield* reviewAndApprove(
        service,
        projectId,
        created.slug,
        created.revision,
        "approval",
      );
      assert.equal(approval.status, "approved");
      assert.isTrue(approval.approvalValid);
      assert.equal(approval.approval?.subject, human.subject);
      assert.equal(approval.approval?.revision, approval.revision);
    }),
  );

  it.effect("rejects agent approval and forged approval metadata", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:spec-forged-approval");
      const threadId = ThreadId.make("thread:spec-forged-approval");
      yield* createProject(projectId, workspaceRoot);
      threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });

      const created = yield* service.mutate(
        createSpec(projectId, "forged-approval", "command:forged:create"),
        human,
      );
      const bound = yield* bind(
        service,
        projectId,
        threadId,
        created.slug,
        "implementation",
        created.revision,
        "forged",
      );
      const agent = { kind: "agent" as const, threadId };
      const approvalAttempt = yield* Effect.flip(
        service.mutate(
          mutation(
            "approve",
            projectId,
            created.slug,
            "command:forged:agent-approve",
            bound.revision,
            { threadId },
          ),
          agent,
        ),
      );
      assert.equal(approvalAttempt.reason, "forbidden");

      const approvalFile = `${workspaceRoot}/specs/${created.slug}/approval.json`;
      yield* fs.writeFileString(
        approvalFile,
        JSON.stringify({
          version: 1,
          approval: {
            subject: "attacker",
            label: "Attacker",
            approvedAt: now,
            revision: bound.revision,
            specHash: created.specHash,
            constitutionHash: null,
          },
        }),
      );
      const run = yield* Effect.flip(service.beforeRun({ threadId, driver: "codex" }));
      assert.equal(run.reason, "inconsistent");
    }),
  );

  it.effect("rejects stale revisions and makes repeated commands idempotent", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:spec-revision");
      yield* createProject(projectId, workspaceRoot);

      const create = createSpec(projectId, "revision-check", "command:revision:create");
      const first = yield* service.mutate(create, human);
      const repeated = yield* service.mutate(create, human);
      assert.equal(repeated.revision, first.revision);

      const stale = yield* Effect.flip(
        service.mutate(
          mutation("update", projectId, first.slug, "command:revision:stale", 0, {
            content,
          }),
          human,
        ),
      );
      assert.equal(stale.reason, "conflict");

      const duplicateCommand = yield* Effect.flip(
        service.mutate(
          createSpec(projectId, "revision-check", "command:revision:create", `${content}\nMore.`),
          human,
        ),
      );
      assert.equal(duplicateCommand.reason, "conflict");
    }),
  );

  it.effect("revokes approval and evidence when requirements change", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:spec-requirements-change");
      yield* createProject(projectId, workspaceRoot);

      const created = yield* service.mutate(
        createSpec(projectId, "requirements-change", "command:requirements:create"),
        human,
      );
      const approved = yield* reviewAndApprove(
        service,
        projectId,
        created.slug,
        created.revision,
        "requirements",
      );
      const updated = yield* service.mutate(
        mutation(
          "update",
          projectId,
          created.slug,
          "command:requirements:update",
          approved.revision,
          {
            content: content.replace(
              "The setting is restored.",
              "The setting is restored after restart.",
            ),
          },
        ),
        human,
      );
      assert.equal(updated.status, "review");
      assert.isFalse(updated.approvalValid);
      assert.isNull(updated.approval);
      assert.deepEqual(updated.evidence, []);
    }),
  );

  it.effect("refreshes bound requirements and publishes the threads requiring interruption", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:spec-bound-refresh");
      const threadId = ThreadId.make("thread:spec-bound-refresh");
      yield* createProject(projectId, workspaceRoot);
      threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });
      const created = yield* service.mutate(
        createSpec(projectId, "bound-refresh", "command:bound-refresh:create"),
        human,
      );
      const approved = yield* reviewAndApprove(
        service,
        projectId,
        created.slug,
        created.revision,
        "bound-refresh",
      );
      yield* bind(
        service,
        projectId,
        threadId,
        created.slug,
        "implementation",
        approved.revision,
        "bound-refresh",
      );
      const invalidation = yield* service.invalidations.pipe(
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* fs.writeFileString(
        path.join(workspaceRoot, "specs", created.slug, "spec.md"),
        `${content}\nChanged requirements.`,
      );

      yield* service.refreshBindings;

      assert.deepEqual(yield* Fiber.join(invalidation), Option.some([threadId]));
      const result = yield* service.query({ projectId, slug: created.slug });
      assert.isFalse(result.detail?.approvalValid);
      assert.isNull(result.detail?.approval);
      assert.equal(result.detail?.status, "review");
    }),
  );

  it.effect("rebuilds the service from the same SQLite and checkout files", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:spec-restart");
      yield* createProject(projectId, workspaceRoot);
      const created = yield* service.mutate(
        createSpec(projectId, "restart-state", "command:restart:create"),
        human,
      );
      const approved = yield* reviewAndApprove(
        service,
        projectId,
        created.slug,
        created.revision,
        "restart",
      );

      const restarted = yield* queryAfterServiceRestart({ projectId, slug: created.slug });
      assert.equal(restarted.detail?.status, "approved");
      assert.isTrue(restarted.detail?.approvalValid);
      assert.equal(restarted.detail?.approval?.subject, human.subject);
      assert.equal(restarted.detail?.specHash, approved.specHash);
    }),
  );

  it.effect(
    "keeps approval for task progress changes and clears evidence when task definitions change",
    () =>
      Effect.gen(function* () {
        const service = yield* SpecService.SpecService;
        const workspaceRoot = yield* scopedWorkspace;
        const projectId = ProjectId.make("project:spec-task-hashes");
        const threadId = ThreadId.make("thread:spec-task-hashes");
        yield* createProject(projectId, workspaceRoot);
        threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });

        const created = yield* service.mutate(
          createSpec(projectId, "task-hashes", "command:tasks:create"),
          human,
        );
        const approved = yield* reviewAndApprove(
          service,
          projectId,
          created.slug,
          created.revision,
          "tasks",
        );
        const bound = yield* bind(
          service,
          projectId,
          threadId,
          created.slug,
          "implementation",
          approved.revision,
          "tasks",
        );
        const agent = { kind: "agent" as const, threadId };
        const definitions = [
          {
            id: "save",
            title: "Save setting",
            acs: ["AC-1"],
            dependsOn: [],
            verify: "Run save check",
            status: "pending" as const,
          },
          {
            id: "restore",
            title: "Restore setting",
            acs: ["AC-2"],
            dependsOn: ["save"],
            verify: "Run restore check",
            status: "pending" as const,
          },
        ];
        const planned = yield* service.mutate(
          mutation("tasks", projectId, created.slug, "command:tasks:plan", bound.revision, {
            threadId,
            tasks: definitions,
          }),
          agent,
        );
        const progress = yield* service.mutate(
          mutation("tasks", projectId, created.slug, "command:tasks:progress", planned.revision, {
            threadId,
            tasks: definitions.map((task) =>
              task.id === "save" ? { ...task, status: "passed" as const } : task,
            ),
          }),
          agent,
        );
        assert.isTrue(progress.approvalValid);
        assert.equal(progress.taskHash, planned.taskHash);
        assert.equal(progress.tasks[0]?.status, "passed");

        const withEvidence = yield* service.mutate(
          mutation(
            "evidence",
            projectId,
            created.slug,
            "command:tasks:evidence",
            progress.revision,
            {
              threadId,
              evidence: [
                {
                  id: "save-check",
                  acs: ["AC-1"],
                  kind: "automated",
                  description: "Save test passed",
                  checkpoint: "checkpoint-1",
                  requirementsHash: progress.specHash,
                  taskHash: progress.taskHash,
                  passed: true,
                },
              ],
            },
          ),
          agent,
        );
        const changedDefinitions = yield* service.mutate(
          mutation(
            "tasks",
            projectId,
            created.slug,
            "command:tasks:definition",
            withEvidence.revision,
            {
              threadId,
              tasks: definitions.map((task) =>
                task.id === "save" ? { ...task, verify: "Run save test and lint" } : task,
              ),
            },
          ),
          agent,
        );
        assert.isTrue(changedDefinitions.approvalValid);
        assert.notEqual(changedDefinitions.taskHash, withEvidence.taskHash);
        assert.deepEqual(changedDefinitions.evidence, []);
      }),
  );

  it.effect(
    "keeps a failed file write pending and blocks beforeRun until the checkout is repaired",
    () =>
      Effect.gen(function* () {
        const service = yield* SpecService.SpecService;
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const workspaceRoot = yield* scopedWorkspace;
        const projectId = ProjectId.make("project:spec-pending-files");
        const threadId = ThreadId.make("thread:spec-pending-files");
        yield* createProject(projectId, workspaceRoot);
        threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });

        const created = yield* service.mutate(
          createSpec(projectId, "pending-files", "command:pending:create"),
          human,
        );
        const approved = yield* reviewAndApprove(
          service,
          projectId,
          created.slug,
          created.revision,
          "pending",
        );
        yield* bind(
          service,
          projectId,
          threadId,
          created.slug,
          "implementation",
          approved.revision,
          "pending",
        );

        const blockedArtifact = `${workspaceRoot}/specs/${created.slug}/evidence/verification.md`;
        yield* fs.makeDirectory(blockedArtifact, { recursive: true });
        const artifactWrite = yield* Effect.flip(
          service.mutate(
            mutation(
              "artifact",
              projectId,
              created.slug,
              "command:pending:artifact",
              approved.revision + 1,
              {
                threadId,
                path: "evidence/verification.md",
                content: "Verification details.",
              },
            ),
            { kind: "agent", threadId },
          ),
        );
        assert.equal(artifactWrite.reason, "io");
        const pending = yield* sql<{ pending_files_json: string | null }>`
        SELECT pending_files_json FROM spec_documents WHERE slug = ${created.slug}
      `;
        assert.isNotNull(pending[0]?.pending_files_json);
        const blockedRun = yield* Effect.flip(service.beforeRun({ threadId, driver: "codex" }));
        assert.equal(blockedRun.reason, "io");

        yield* fs.remove(blockedArtifact, { recursive: true });
        const run = yield* service.beforeRun({ threadId, driver: "codex" });
        assert.isTrue(run?.document.approvalValid);
        assert.equal(
          yield* fs.readFileString(
            `${workspaceRoot}/specs/${created.slug}/evidence/verification.md`,
          ),
          "Verification details.",
        );
      }),
  );

  it.effect("imports copied spec files into another checkout without their human approval", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* scopedWorkspace;
      const copiedWorkspace = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:spec-copy");
      const threadId = ThreadId.make("thread:spec-copy");
      yield* createProject(projectId, workspaceRoot);

      const created = yield* service.mutate(
        createSpec(projectId, "copied-spec", "command:copy:create"),
        human,
      );
      const approved = yield* reviewAndApprove(
        service,
        projectId,
        created.slug,
        created.revision,
        "copy",
      );
      const sourceFolder = `${workspaceRoot}/specs/${created.slug}`;
      const copiedFolder = `${copiedWorkspace}/specs/${created.slug}`;
      yield* fs.makeDirectory(copiedFolder, { recursive: true });
      for (const name of ["spec.md", "status.json", "tasks.json", "approval.json"]) {
        yield* fs.copyFile(`${sourceFolder}/${name}`, `${copiedFolder}/${name}`);
      }
      threads.set(threadId, { projectId, workspacePath: copiedWorkspace, activeRunId: null });

      const imported = yield* service.query({ projectId, threadId, slug: created.slug });
      assert.isFalse(imported.detail?.approvalValid);
      assert.isNull(imported.detail?.approval);
      assert.match(imported.detail?.error ?? "", /no trusted approval/i);
      assert.equal(approved.status, "approved");
    }),
  );
});
