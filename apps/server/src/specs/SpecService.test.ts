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

const STATUS_COMMENT = "# draft | review | approved | in-progress | blocked | implemented | done";
const baseTemplate = `---
id: <slug>
status: draft            ${STATUS_COMMENT}
---
# <Title>

## Context

## Acceptance criteria

## Open questions

## Assumptions
`;
const baseSlug = "PROJ-123_short-kebab";
const baseSpec = (status = "draft", extra = "") => `---
id: ${baseSlug}
status: ${status}            ${STATUS_COMMENT}
updated: 2026-10-20
epic:
  status: done
---
# Example

## Context
Save and restore a setting. See [notes](https://example.test/notes).

### Detail
Sub-heading content stays inside Context.

## Acceptance criteria
- [ ] AC-1: The setting is saved.
- [x] AC-2: The setting is restored.

## Open questions
- [ ] Q1 [MEDIUM] Which store holds it?
- [x] Q2 [HIGH] Is a migration needed?

## Assumptions
- [x] The store exists.
${extra}`;
const withStatus = (spec: string, status: string) =>
  spec.replace(/^status: \S+/m, `status: ${status}`);

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

const baseWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* scopedWorkspace;
  yield* fs.writeFileString(`${workspaceRoot}/.base`, "");
  yield* fs.makeDirectory(`${workspaceRoot}/specs/${baseSlug}`, { recursive: true });
  yield* fs.writeFileString(`${workspaceRoot}/specs/_template.md`, baseTemplate);
  yield* fs.writeFileString(`${workspaceRoot}/specs/constitution.md`, "# Unused constitution\n");
  yield* fs.writeFileString(`${workspaceRoot}/specs/${baseSlug}/spec.md`, baseSpec());
  return workspaceRoot;
});

const ownedFiles = ["status.json", "tasks.json", "approval.json"];

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
  it.effect("discovers a BASE spec without writing or checking Par3 metadata files", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* baseWorkspace;
      const projectId = ProjectId.make("project:base-discover");
      yield* createProject(projectId, workspaceRoot);
      yield* fs.makeDirectory(`${workspaceRoot}/specs/Bad_Name`, { recursive: true });
      yield* fs.writeFileString(`${workspaceRoot}/specs/Bad_Name/spec.md`, baseSpec());

      const listed = yield* service.query({ projectId });
      assert.deepEqual(
        listed.specs.map((spec) => spec.slug),
        [baseSlug],
      );
      assert.equal(listed.layout, "base");
      assert.isUndefined(listed.template);
      assert.equal(
        (yield* service.query({ projectId, includeTemplate: true })).template,
        baseTemplate,
      );
      assert.equal(listed.specs[0]?.layout, "base");

      const detail = (yield* service.query({ projectId, slug: baseSlug })).detail;
      assert.equal(detail?.layout, "base");
      assert.equal(detail?.title, "Example");
      assert.equal(detail?.status, "draft");
      assert.isUndefined(detail?.error);
      assert.deepEqual(detail?.findings, []);
      assert.isNull(detail?.constitutionHash);
      assert.isFalse(detail?.approvalValid);

      for (const name of ownedFiles) {
        assert.isFalse(yield* fs.exists(`${workspaceRoot}/specs/${baseSlug}/${name}`));
      }
      assert.equal(
        yield* fs.readFileString(`${workspaceRoot}/specs/${baseSlug}/spec.md`),
        baseSpec(),
      );
    }),
  );

  it.effect("reports readiness against the BASE template and ignores sections it lacks", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* baseWorkspace;
      const projectId = ProjectId.make("project:base-readiness");
      yield* createProject(projectId, workspaceRoot);

      const slug = "PROJ-124_missing-section";
      const created = yield* service.mutate(
        createSpec(
          projectId,
          slug,
          "command:base-readiness:create",
          baseSpec().replace(
            "## Assumptions\n- [x] The store exists.\n",
            "## Epic checklist\n- [ ] Extra.\n",
          ),
        ),
        human,
      );
      assert.deepEqual(
        created.findings.map((finding) => finding.message),
        ["Add the Assumptions section."],
      );
      const ready = yield* service.mutate(
        mutation("update", projectId, slug, "command:base-readiness:fix", created.revision, {
          content: baseSpec("draft", "\n## Epic checklist\n### Epic follow-ups\n- [ ] Extra.\n"),
        }),
        human,
      );
      assert.deepEqual(ready.findings, []);
      assert.isFalse(yield* fs.exists(`${workspaceRoot}/specs/${slug}/status.json`));
    }),
  );

  it.effect("keeps the frontmatter status in sync without revoking approval", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* baseWorkspace;
      const projectId = ProjectId.make("project:base-sync");
      const threadId = ThreadId.make("thread:base-sync");
      yield* createProject(projectId, workspaceRoot);
      threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });
      const specFile = `${workspaceRoot}/specs/${baseSlug}/spec.md`;
      const query = () => service.query({ projectId, slug: baseSlug });

      const discovered = (yield* query()).detail!;
      const review = yield* service.mutate(
        mutation(
          "request-review",
          projectId,
          baseSlug,
          "command:base-sync:review",
          discovered.revision,
        ),
        human,
      );
      assert.equal(review.status, "review");
      assert.equal(yield* fs.readFileString(specFile), baseSpec("review"));
      assert.equal(review.specHash, discovered.specHash);

      const approved = yield* service.mutate(
        mutation("approve", projectId, baseSlug, "command:base-sync:approve", review.revision),
        human,
      );
      assert.equal(approved.status, "approved");
      assert.equal(approved.specHash, discovered.specHash);
      assert.equal(yield* fs.readFileString(specFile), baseSpec("approved"));
      const reread = (yield* query()).detail!;
      assert.isTrue(reread.approvalValid);
      assert.isUndefined(reread.error);
      assert.equal(reread.revision, approved.revision);

      const bound = yield* bind(
        service,
        projectId,
        threadId,
        baseSlug,
        "implementation",
        approved.revision,
        "base-sync",
      );
      const agent = { kind: "agent" as const, threadId };
      const tasks = [
        {
          id: "save",
          title: "Save",
          acs: ["AC-1", "AC-2"],
          dependsOn: [],
          verify: "Run checks",
          status: "pending" as const,
        },
      ];
      const planned = yield* service.mutate(
        mutation("tasks", projectId, baseSlug, "command:base-sync:tasks", bound.revision, {
          threadId,
          tasks,
        }),
        agent,
      );
      const started = yield* service.mutate(
        mutation("transition", projectId, baseSlug, "command:base-sync:start", planned.revision, {
          threadId,
          status: "in-progress",
        }),
        agent,
      );
      assert.equal(started.status, "in-progress");
      assert.isTrue(started.approvalValid);
      assert.equal(yield* fs.readFileString(specFile), baseSpec("in-progress"));

      const rewritten = yield* service.mutate(
        mutation("update", projectId, baseSlug, "command:base-sync:rewrite", started.revision, {
          threadId: undefined,
          content: withStatus(baseSpec("in-progress"), "done"),
        }),
        human,
      );
      assert.equal(rewritten.status, "in-progress");
      assert.isTrue(rewritten.approvalValid);
      assert.equal(yield* fs.readFileString(specFile), baseSpec("in-progress"));
      for (const name of ownedFiles) {
        assert.isFalse(yield* fs.exists(`${workspaceRoot}/specs/${baseSlug}/${name}`));
      }
    }),
  );

  it.effect("adopts only safe frontmatter status edits and never a requirements change", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* baseWorkspace;
      const projectId = ProjectId.make("project:base-adopt");
      yield* createProject(projectId, workspaceRoot);
      const specFile = `${workspaceRoot}/specs/${baseSlug}/spec.md`;
      const query = () =>
        service.query({ projectId, slug: baseSlug }).pipe(Effect.map((result) => result.detail!));

      const discovered = yield* query();
      yield* fs.writeFileString(specFile, baseSpec("bogus"));
      const ignored = yield* query();
      assert.equal(ignored.status, "draft");
      assert.equal(ignored.revision, discovered.revision);
      assert.isUndefined(ignored.error);

      yield* fs.writeFileString(specFile, baseSpec("approved"));
      assert.equal((yield* query()).status, "draft");
      yield* fs.writeFileString(specFile, baseSpec("done"));
      assert.equal((yield* query()).status, "draft");

      yield* fs.writeFileString(specFile, baseSpec("review"));
      const review = yield* query();
      assert.equal(review.status, "review");
      assert.equal(review.revision, discovered.revision + 1);
      assert.equal(review.specHash, discovered.specHash);
      assert.isUndefined(review.error);

      yield* fs.writeFileString(specFile, baseSpec("approved"));
      assert.equal((yield* query()).status, "review");

      const approved = yield* service.mutate(
        mutation("approve", projectId, baseSlug, "command:base-adopt:approve", review.revision),
        human,
      );
      yield* fs.writeFileString(specFile, baseSpec("draft"));
      const stillApproved = yield* query();
      assert.equal(stillApproved.status, "approved");
      assert.isTrue(stillApproved.approvalValid);
      assert.equal(stillApproved.revision, approved.revision);

      yield* fs.writeFileString(
        specFile,
        baseSpec("approved").replace("The setting is saved.", "The setting is saved twice."),
      );
      const changed = yield* query();
      assert.equal(changed.status, "review");
      assert.isFalse(changed.approvalValid);
      assert.isNull(changed.approval);
      assert.equal(
        yield* fs.readFileString(specFile),
        baseSpec("review").replace("The setting is saved.", "The setting is saved twice."),
      );
    }),
  );

  it.effect("keeps approval when BASE tooling edits only the status and updated lines", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* baseWorkspace;
      const projectId = ProjectId.make("project:base-volatile");
      yield* createProject(projectId, workspaceRoot);
      const specFile = `${workspaceRoot}/specs/${baseSlug}/spec.md`;
      const query = () =>
        service.query({ projectId, slug: baseSlug }).pipe(Effect.map((result) => result.detail!));
      const touchUpdated = (spec: string) =>
        spec.replace("updated: 2026-10-20", "updated: 2026-10-22T16:00:00+02:00");

      const discovered = yield* query();
      const review = yield* service.mutate(
        mutation(
          "request-review",
          projectId,
          baseSlug,
          "command:base-volatile:review",
          discovered.revision,
        ),
        human,
      );
      const approved = yield* service.mutate(
        mutation("approve", projectId, baseSlug, "command:base-volatile:approve", review.revision),
        human,
      );
      const onDisk = yield* fs.readFileString(specFile);

      yield* fs.writeFileString(specFile, touchUpdated(onDisk));
      const bumped = yield* query();
      assert.isTrue(bumped.approvalValid);
      assert.equal(bumped.status, "approved");
      assert.equal(bumped.revision, approved.revision);
      assert.equal(bumped.specHash, approved.specHash);
      assert.isUndefined(bumped.error);

      yield* fs.writeFileString(specFile, touchUpdated(withStatus(onDisk, "draft")));
      const both = yield* query();
      assert.isTrue(both.approvalValid);
      assert.equal(both.status, "approved");
      assert.equal(both.revision, approved.revision);

      yield* fs.writeFileString(specFile, onDisk.replace("id: ", "title: Renamed\nid: "));
      const retitled = yield* query();
      assert.isFalse(retitled.approvalValid);
      assert.isNull(retitled.approval);
      assert.equal(retitled.status, "review");
      assert.notEqual(retitled.specHash, approved.specHash);
    }),
  );

  it.effect("lets BASE agents write BASE files through artifacts, never approval or tasks", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* baseWorkspace;
      const projectId = ProjectId.make("project:base-artifacts");
      const threadId = ThreadId.make("thread:base-artifacts");
      yield* createProject(projectId, workspaceRoot);
      threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });
      const folder = `${workspaceRoot}/specs/${baseSlug}`;
      const agent = { kind: "agent" as const, threadId };
      const write = (path: string, revision: number, suffix: string, body = `${path} body`) =>
        service.mutate(
          mutation("artifact", projectId, baseSlug, `command:base-artifacts:${suffix}`, revision, {
            threadId,
            path,
            content: body,
          }),
          agent,
        );

      const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
      let revision = (yield* bind(
        service,
        projectId,
        threadId,
        baseSlug,
        "requirements",
        discovered.revision,
        "base-artifacts",
      )).revision;
      for (const path of ["prd.md", "tech-analysis.md", "status.json"]) {
        revision = (yield* write(path, revision, path)).revision;
        assert.equal(yield* fs.readFileString(`${folder}/${path}`), `${path} body`);
      }
      const unapproved = yield* Effect.flip(write("test-plan.md", revision, "plan-early"));
      assert.equal(unapproved.reason, "forbidden");

      const review = yield* service.mutate(
        mutation("request-review", projectId, baseSlug, "command:base-artifacts:review", revision, {
          threadId,
        }),
        agent,
      );
      const approved = yield* service.mutate(
        mutation("approve", projectId, baseSlug, "command:base-artifacts:approve", review.revision),
        human,
      );
      revision = (yield* bind(
        service,
        projectId,
        threadId,
        baseSlug,
        "implementation",
        approved.revision,
        "base-artifacts-impl",
      )).revision;
      for (const path of ["approval.json", "tasks.json", "notes.md", "../escape.md"]) {
        const refused = yield* Effect.flip(write(path, revision, `refuse:${path}`));
        assert.equal(refused.reason, "invalid");
        assert.isFalse(yield* fs.exists(`${folder}/${path}`));
      }
      revision = (yield* write("decisions.md", revision, "decisions")).revision;
      assert.isTrue(yield* fs.exists(`${folder}/decisions.md`));
      assert.isTrue((yield* service.query({ projectId, slug: baseSlug })).detail!.approvalValid);
    }),
  );

  it.effect("keeps the Par3 artifact allow-list free of BASE files", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:par3-artifacts");
      const threadId = ThreadId.make("thread:par3-artifacts");
      yield* createProject(projectId, workspaceRoot);
      threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });
      const agent = { kind: "agent" as const, threadId };

      const created = yield* service.mutate(
        createSpec(projectId, "par3-artifacts", "command:par3-artifacts:create"),
        human,
      );
      const approved = yield* reviewAndApprove(
        service,
        projectId,
        created.slug,
        created.revision,
        "par3-artifacts",
      );
      let revision = (yield* bind(
        service,
        projectId,
        threadId,
        created.slug,
        "implementation",
        approved.revision,
        "par3-artifacts",
      )).revision;
      for (const path of [
        "prd.md",
        "tech-analysis.md",
        "status.json",
        "approval.json",
        "tasks.json",
      ]) {
        const refused = yield* Effect.flip(
          service.mutate(
            mutation(
              "artifact",
              projectId,
              created.slug,
              `command:par3-artifacts:${path}`,
              revision,
              {
                threadId,
                path,
                content: "{}",
              },
            ),
            agent,
          ),
        );
        assert.equal(refused.reason, "invalid");
        assert.include(refused.message, "Choose test-plan.md, decisions.md, or an evidence file.");
      }
      const written = yield* service.mutate(
        mutation("artifact", projectId, created.slug, "command:par3-artifacts:plan", revision, {
          threadId,
          path: "test-plan.md",
          content: "Plan.",
        }),
        agent,
      );
      revision = written.revision;
      assert.equal(
        yield* fs.readFileString(`${workspaceRoot}/specs/${created.slug}/test-plan.md`),
        "Plan.",
      );
    }),
  );

  it.effect("accepts BASE folder names only in a BASE checkout", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const baseRoot = yield* baseWorkspace;
      const par3Root = yield* scopedWorkspace;
      const baseProject = ProjectId.make("project:base-slugs");
      const par3Project = ProjectId.make("project:base-slugs-par3");
      yield* createProject(baseProject, baseRoot);
      yield* createProject(par3Project, par3Root);

      const par3Attempt = yield* Effect.flip(
        service.mutate(createSpec(par3Project, baseSlug, "command:slugs:par3"), human),
      );
      assert.equal(par3Attempt.reason, "invalid");
      assert.equal((yield* service.query({ projectId: par3Project })).layout, "par3");
      assert.isUndefined(
        (yield* service.query({ projectId: par3Project, includeTemplate: true })).template,
      );

      const dated = yield* service.mutate(
        createSpec(baseProject, "2026-short-kebab", "command:slugs:dated", baseSpec()),
        human,
      );
      assert.equal(dated.layout, "base");
      const keyed = yield* service.mutate(
        createSpec(
          baseProject,
          "PROJ-125_new-thing",
          "command:slugs:keyed",
          "# No frontmatter\n\n- [ ] AC-1: Works.\n",
        ),
        human,
      );
      assert.equal(keyed.layout, "base");
      assert.equal(
        yield* fs.readFileString(`${baseRoot}/specs/PROJ-125_new-thing/spec.md`),
        "# No frontmatter\n\n- [ ] AC-1: Works.\n",
      );
      const wrongCase = yield* Effect.flip(
        service.mutate(createSpec(baseProject, "Proj-125_new-thing", "command:slugs:case"), human),
      );
      assert.equal(wrongCase.reason, "invalid");
    }),
  );
});
