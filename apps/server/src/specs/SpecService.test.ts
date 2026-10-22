import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SpecError,
  ThreadId,
  type ModelSelection,
  type SpecMutationInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import type * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Context from "effect/Context";

import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SpecRemarkService from "./SpecRemarkService.ts";
import * as SpecService from "./SpecService.ts";
import type { SpecDocumentMutationInput } from "./SpecService.ts";
import { ApprovalHooks, PYTHON_MISSING } from "./baseWorkflow.ts";

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
const baseSpec = (status = "draft", extra = "", updated = "2026-10-20") => `---
id: ${baseSlug}
status: ${status}            ${STATUS_COMMENT}
updated: ${updated}
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
  { projectId: ProjectId; workspacePath: string; activeRunId: string | null; runStatus?: string }
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
      runs: thread.runStatus ? [{ status: thread.runStatus }] : [],
    });
  },
} as never);

// Tests set these per case; the defaults are a developer with a git identity and no Python.
const git = { name: "Jane Doe" as string | null, email: "jane@example.com" as string | null };
const processCalls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string }> = [];
let processHandler: (
  input: ProcessRunner.ProcessRunInput,
) => ProcessRunner.ProcessRunOutput | null = () => null;
const processOutput = (stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: code as never,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
const layerGit = Layer.succeed(GitVcsDriver.GitVcsDriver, {
  readConfigValue: (_cwd: string, key: string) =>
    Effect.succeed(key === "user.name" ? git.name : git.email),
} as never);
const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) => {
    processCalls.push({
      command: input.command,
      args: input.args,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
    const output = processHandler(input);
    return output
      ? Effect.succeed(output)
      : Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cause: "not installed",
          }),
        );
  },
});

// The remarks send opens a thread through the launch service; the test records what it was asked.
const launches: ThreadLaunchService.ThreadLaunchInput[] = [];
const launchState = { fail: false };
const providerDrivers = { current: [{ instanceId: "codex", driver: "codex" }] };
const layerLaunch = Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
  launch: (input: ThreadLaunchService.ThreadLaunchInput) => {
    launches.push(input);
    return launchState.fail
      ? Effect.fail(
          new ThreadLaunchService.ThreadLaunchError({
            operation: "create-thread",
            commandId: input.commandId,
            projectId: input.projectId,
            cause: "boom",
          }),
        )
      : Effect.succeed({
          threadId: ThreadId.make("thread:remarks-opened"),
          projection: {} as never,
          resumed: false,
        });
  },
} as never);
const layerProviders = Layer.succeed(ProviderRegistry.ProviderRegistry, {
  getProviders: Effect.sync(() => providerDrivers.current),
} as never);
const codexModel = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as ModelSelection;

const layerSpecs = SpecService.layer.pipe(
  Layer.provideMerge(layerGit),
  Layer.provideMerge(layerProcessRunner),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(layerProjectionStore),
  Layer.provideMerge(ServerSettings.layerTest({ specModeEnabled: true })),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);
const layerTest = SpecRemarkService.layer.pipe(
  Layer.provideMerge(layerLaunch),
  Layer.provideMerge(layerProviders),
  Layer.provideMerge(layerSpecs),
);

const createProject = (
  projectId: ProjectId,
  workspaceRoot: string,
  defaultModelSelection: ModelSelection | null = null,
) =>
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
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  });

const mutation = (
  action: SpecDocumentMutationInput["action"],
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
  }) as SpecDocumentMutationInput;

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
      layerGit,
      layerProcessRunner,
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

// The files BASE keeps beside a spec: its tracker table and per-spec status. Approving in Par3 updates both.
const APPROVED_AT = "1970-01-01T00:00:00Z";
const sha256 = Effect.fn("SpecServiceTest.sha256")(function* (value: string | Uint8Array) {
  const crypto = yield* Crypto.Crypto;
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Hex.encode(yield* crypto.digest("SHA-256", bytes).pipe(Effect.orDie));
});
const baseTable = (status = "draft") => `# Spec status

| Spec | Status | Owner |
| --- | --- | --- |
| [PROJ-100_other-thing](./PROJ-100_other-thing/spec.md) | in-progress | Sam |
| [${baseSlug}](./${baseSlug}/spec.md) | ${status} | Jane |
| PROJ-101_third | review | Sam |
`;
const baseStatusJson = JSON.stringify(
  {
    version: 1,
    phase: "requirements",
    updated: "2026-10-20",
    requirements: { awaiting: "approval", owner: "Jane" },
  },
  null,
  4,
);
const baseApprovalWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const workspaceRoot = yield* baseWorkspace;
  yield* fs.writeFileString(
    `${workspaceRoot}/specs/${baseSlug}/status.json`,
    `${baseStatusJson}\n`,
  );
  yield* fs.writeFileString(`${workspaceRoot}/specs/_status.md`, baseTable());
  return workspaceRoot;
});

const withGit = <A, E, R>(
  identity: { name: string | null; email: string | null },
  effect: Effect.Effect<A, E, R>,
) => {
  const before = { ...git };
  return Effect.suspend(() => {
    Object.assign(git, identity);
    return effect;
  }).pipe(Effect.ensuring(Effect.sync(() => Object.assign(git, before))));
};

const withProcess = <A, E, R>(handler: typeof processHandler, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    processHandler = handler;
    processCalls.length = 0;
    return effect;
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        processHandler = () => null;
      }),
    ),
  );

// A BASE spec under review with the files an approval needs, plus the handles tests poke at.
const reviewedBaseSpec = Effect.fn("SpecServiceTest.reviewedBaseSpec")(function* (suffix: string) {
  const service = yield* SpecService.SpecService;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* baseApprovalWorkspace;
  const projectId = ProjectId.make(`project:${suffix}`);
  yield* createProject(projectId, root);
  const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
  const review = yield* service.mutate(
    mutation(
      "request-review",
      projectId,
      baseSlug,
      `command:${suffix}:review`,
      discovered.revision,
    ),
    human,
  );
  const folder = `${root}/specs/${baseSlug}`;
  // Approves at whatever revision the spec has now, since a test may touch the files first.
  let approvals = 0;
  const approve = Effect.suspend(() =>
    service
      .query({ projectId, slug: baseSlug })
      .pipe(
        Effect.flatMap((result) =>
          service.mutate(
            mutation(
              "approve",
              projectId,
              baseSlug,
              `command:${suffix}:approve:${(approvals += 1)}`,
              result.detail!.revision,
            ),
            human,
          ),
        ),
      ),
  );
  const files = Effect.gen(function* () {
    const names = ["spec.md", "status.json", "approval.json", "test-plan.json"].map(
      (name) => `${folder}/${name}`,
    );
    const seen: Record<string, string | null> = {};
    for (const name of [...names, `${root}/specs/_status.md`])
      seen[name.slice(root.length + 1)] = (yield* fs.exists(name))
        ? yield* fs.readFileString(name)
        : null;
    return seen;
  });
  return { service, fs, root, projectId, review, folder, approve, files };
});

const olderApproval = {
  confirmedBy: "Sam Roe <sam@example.com>",
  confirmedAt: "2026-09-01T10:00:00Z",
  source: "button",
  artifacts: { "spec.md": "0".repeat(64) },
};
const testPlan = {
  spec: baseSlug,
  status: "draft",
  cases: [{ id: "TC-1", ac: "AC-1", steps: ["Save the setting"] }],
};

const lineOf = (text: string, needle: string) =>
  text.split("\n").findIndex((line) => line.includes(needle)) + 1;
const remarkInput = (
  action: "remark-add" | "remark-delete" | "remarks-send",
  projectId: ProjectId,
  slug: string,
  document: "spec.md" | "prd.md" | "tech-analysis.md",
  commandId: string,
  fields: Record<string, unknown> = {},
) =>
  ({
    action,
    projectId,
    slug,
    document,
    commandId: CommandId.make(commandId),
    ...fields,
  }) as SpecMutationInput;
const comment = (text: string, heading = "Open questions") => ({
  kind: "comment",
  operation: "comment",
  section: { heading },
  comment: text,
});
const LEDGER_TIME = "1970-01-01T00:00:00.000Z";

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
        assert.isTrue(run?.document?.approvalValid);
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
      const workspaceRoot = yield* baseApprovalWorkspace;
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
      assert.equal(yield* fs.readFileString(specFile), baseSpec("approved", "", APPROVED_AT));
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
      assert.equal(yield* fs.readFileString(specFile), baseSpec("in-progress", "", APPROVED_AT));

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
      for (const name of ["tasks.json"]) {
        assert.isFalse(yield* fs.exists(`${workspaceRoot}/specs/${baseSlug}/${name}`));
      }
      assert.include(
        yield* fs.readFileString(`${workspaceRoot}/specs/_status.md`),
        "| in-progress |",
      );
    }),
  );

  it.effect("adopts only safe frontmatter status edits and never a requirements change", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* baseApprovalWorkspace;
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
      // Adopting the edited status carries it into the tracker row too.
      assert.equal(
        yield* fs.readFileString(`${workspaceRoot}/specs/_status.md`),
        baseTable("review"),
      );

      yield* fs.writeFileString(specFile, baseSpec("approved"));
      const unrecorded = yield* query();
      assert.equal(unrecorded.status, "review");
      assert.include(unrecorded.error, "approval.json does not match");
      yield* fs.writeFileString(specFile, baseSpec("review"));

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
      const workspaceRoot = yield* baseApprovalWorkspace;
      const projectId = ProjectId.make("project:base-volatile");
      yield* createProject(projectId, workspaceRoot);
      const specFile = `${workspaceRoot}/specs/${baseSlug}/spec.md`;
      const query = () =>
        service.query({ projectId, slug: baseSlug }).pipe(Effect.map((result) => result.detail!));
      const touchUpdated = (spec: string) =>
        spec.replace(/^updated: .*$/m, "updated: 2026-10-22T16:00:00+02:00");

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
      const workspaceRoot = yield* baseApprovalWorkspace;
      const projectId = ProjectId.make("project:base-artifacts");
      const threadId = ThreadId.make("thread:base-artifacts");
      yield* createProject(projectId, workspaceRoot);
      threads.set(threadId, { projectId, workspacePath: workspaceRoot, activeRunId: null });
      const folder = `${workspaceRoot}/specs/${baseSlug}`;
      const agent = { kind: "agent" as const, threadId };
      const statusJson = '{"phase":"requirements"}\n';
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
        const body = path === "status.json" ? statusJson : `${path} body`;
        revision = (yield* write(path, revision, path, body)).revision;
        assert.equal(yield* fs.readFileString(`${folder}/${path}`), body);
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
        // Approving wrote the approval log itself; no agent write may change it.
        if (path !== "approval.json") assert.isFalse(yield* fs.exists(`${folder}/${path}`));
      }
      const log = yield* fs.readFileString(`${folder}/approval.json`);
      revision = (yield* write("decisions.md", revision, "decisions")).revision;
      assert.equal(yield* fs.readFileString(`${folder}/approval.json`), log);
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

  const waitingThread = (
    suffix: string,
    projectId: ProjectId,
    workspacePath: string,
    runStatus?: string,
  ) => {
    const threadId = ThreadId.make(`thread:intake:${suffix}`);
    threads.set(threadId, {
      projectId,
      workspacePath,
      activeRunId: null,
      ...(runStatus ? { runStatus } : {}),
    });
    return threadId;
  };
  const markIntake = (projectId: ProjectId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      return yield* service.setIntake({ projectId, threadId, action: "mark" }, human);
    });
  const intakeCreate = (threadId: ThreadId, commandId: string, slug: string, body = content) => ({
    threadId,
    commandId: CommandId.make(commandId),
    slug,
    title: "Example",
    content: body,
  });

  it.effect("starts a spec from an intake: creates it, binds the thread, ends the intake", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:intake-create");
      const threadId = waitingThread("create", projectId, workspaceRoot);
      yield* createProject(projectId, workspaceRoot);

      const marked = yield* markIntake(projectId, threadId);
      assert.isNotNull(marked.intake);
      assert.deepEqual(yield* markIntake(projectId, threadId), marked);
      assert.equal(
        (yield* service.query({ projectId, threadId })).intake?.createdAt,
        marked.intake?.createdAt,
      );
      assert.equal(yield* service.scopeRole(threadId), "requirements");
      assert.isUndefined(yield* service.binding(threadId));

      const waiting = yield* service.beforeRun({ threadId, driver: "codex" });
      assert.equal(waiting?.role, "requirements");
      assert.isUndefined(waiting?.document);
      assert.deepEqual(
        { layout: waiting?.intake?.layout, workspacePath: waiting?.intake?.workspacePath },
        { layout: "par3", workspacePath: workspaceRoot },
      );
      const unsupported = yield* Effect.flip(service.beforeRun({ threadId, driver: "cursor" }));
      assert.equal(unsupported.reason, "unsupported-provider");

      const created = yield* service.createFromIntake(
        intakeCreate(threadId, "command:intake:create", "setting-lifecycle"),
      );
      assert.equal(created.status, "draft");
      assert.deepEqual(created.bindings, [{ threadId, role: "requirements" }]);
      assert.equal((yield* service.binding(threadId))?.slug, "setting-lifecycle");
      assert.equal((yield* service.binding(threadId))?.role, "requirements");
      assert.isUndefined((yield* service.query({ projectId, threadId })).intake);
      assert.isTrue(
        (yield* fs.readFileString(`${workspaceRoot}/specs/setting-lifecycle/spec.md`)).includes(
          "AC-1: The setting is saved.",
        ),
      );
      const bound = yield* service.beforeRun({ threadId, driver: "codex" });
      assert.equal(bound?.document?.slug, "setting-lifecycle");
      assert.isUndefined(bound?.intake);

      // A retry of the same command replays the result; a new command has no intake left to use.
      const replayed = yield* service.createFromIntake(
        intakeCreate(threadId, "command:intake:create", "setting-lifecycle"),
      );
      assert.equal(replayed.revision, created.revision);
      const second = yield* Effect.flip(
        service.createFromIntake(intakeCreate(threadId, "command:intake:again", "another-spec")),
      );
      assert.equal(second.reason, "forbidden");
      const reused = yield* Effect.flip(
        service.createFromIntake(
          intakeCreate(threadId, "command:intake:create", "setting-lifecycle", `${content}\nMore.`),
        ),
      );
      assert.equal(reused.reason, "conflict");
    }),
  );

  it.effect("refuses spec_create for a thread that is not waiting to start a spec", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:intake-none");
      const threadId = waitingThread("none", projectId, workspaceRoot);
      yield* createProject(projectId, workspaceRoot);

      const refused = yield* Effect.flip(
        service.createFromIntake(intakeCreate(threadId, "command:intake:none", "no-intake")),
      );
      assert.equal(refused.reason, "forbidden");
      assert.include(refused.message, "not waiting to start a spec");
      assert.isUndefined(yield* service.scopeRole(threadId));
      assert.isUndefined(yield* service.beforeRun({ threadId, driver: "codex" }));
      assert.lengthOf((yield* service.query({ projectId })).specs, 0);
    }),
  );

  it.effect("checks the spec folder name against the checkout's layout and keeps waiting", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const par3Root = yield* scopedWorkspace;
      const baseRoot = yield* baseWorkspace;
      const par3Project = ProjectId.make("project:intake-par3-slug");
      const baseProject = ProjectId.make("project:intake-base-slug");
      yield* createProject(par3Project, par3Root);
      yield* createProject(baseProject, baseRoot);
      const par3Thread = waitingThread("par3-slug", par3Project, par3Root);
      const baseThread = waitingThread("base-slug", baseProject, baseRoot);
      yield* markIntake(par3Project, par3Thread);
      yield* markIntake(baseProject, baseThread);

      const keyedInPar3 = yield* Effect.flip(
        service.createFromIntake(intakeCreate(par3Thread, "command:slug:par3", baseSlug)),
      );
      assert.equal(keyedInPar3.reason, "invalid");
      assert.equal(yield* service.scopeRole(par3Thread), "requirements");
      assert.isUndefined(yield* service.binding(par3Thread));

      const wrongCase = yield* Effect.flip(
        service.createFromIntake(
          intakeCreate(baseThread, "command:slug:case", "Proj-125_new-thing"),
        ),
      );
      assert.equal(wrongCase.reason, "invalid");
      const taken = yield* Effect.flip(
        service.createFromIntake(intakeCreate(baseThread, "command:slug:taken", baseSlug)),
      );
      assert.equal(taken.reason, "conflict");
      assert.isUndefined(yield* service.binding(baseThread));

      assert.equal(
        (yield* service.beforeRun({ threadId: baseThread, driver: "claudeAgent" }))?.intake?.layout,
        "base",
      );
      yield* fs.writeFileString(
        `${baseRoot}/specs/_status.md`,
        "| Spec | Status |\n| --- | --- |\n| PROJ-124_new-thing | todo |\n| PROJ-1_other | review |\n",
      );
      const created = yield* service.createFromIntake(
        intakeCreate(
          baseThread,
          "command:slug:base",
          "PROJ-124_new-thing",
          withStatus(baseSpec(), "approved"),
        ),
      );
      assert.equal(created.layout, "base");
      // A new spec is a draft whatever status the agent wrote into the frontmatter.
      const written = yield* fs.readFileString(`${baseRoot}/specs/PROJ-124_new-thing/spec.md`);
      assert.include(written, "status: draft");
      assert.notInclude(written, "status: approved");
      assert.equal(created.status, "draft");
      // Like any BASE status write, an existing tracker row follows the new draft.
      assert.equal(
        yield* fs.readFileString(`${baseRoot}/specs/_status.md`),
        "| Spec | Status |\n| --- | --- |\n| PROJ-124_new-thing | draft |\n| PROJ-1_other | review |\n",
      );
      for (const file of ownedFiles)
        assert.isFalse(yield* fs.exists(`${baseRoot}/specs/PROJ-124_new-thing/${file}`));
    }),
  );

  it.effect(
    "lets only a person mark or cancel an intake, and refuses bound or running threads",
    () =>
      Effect.gen(function* () {
        const service = yield* SpecService.SpecService;
        const workspaceRoot = yield* scopedWorkspace;
        const projectId = ProjectId.make("project:intake-human");
        yield* createProject(projectId, workspaceRoot);
        const threadId = waitingThread("human", projectId, workspaceRoot);
        const agent = { kind: "agent" as const, threadId };

        const agentMark = yield* Effect.flip(
          service.setIntake({ projectId, threadId, action: "mark" }, agent),
        );
        assert.equal(agentMark.reason, "forbidden");
        assert.isUndefined(yield* service.intake(threadId));

        yield* markIntake(projectId, threadId);
        const agentCancel = yield* Effect.flip(
          service.setIntake({ projectId, threadId, action: "cancel" }, agent),
        );
        assert.equal(agentCancel.reason, "forbidden");
        assert.isDefined(yield* service.intake(threadId));

        const cancelled = yield* service.setIntake(
          { projectId, threadId, action: "cancel" },
          human,
        );
        assert.isNull(cancelled.intake);
        assert.isUndefined(yield* service.intake(threadId));
        assert.isUndefined(yield* service.scopeRole(threadId));
        assert.isUndefined(yield* service.beforeRun({ threadId, driver: "codex" }));

        const running = waitingThread("running", projectId, workspaceRoot, "running");
        const stopFirst = yield* Effect.flip(markIntake(projectId, running));
        assert.equal(stopFirst.reason, "conflict");
        assert.isUndefined(yield* service.intake(running));

        const spec = yield* service.mutate(
          createSpec(projectId, "bound-spec", "command:ih:create"),
          human,
        );
        const boundThread = waitingThread("bound", projectId, workspaceRoot);
        yield* bind(
          service,
          projectId,
          boundThread,
          spec.slug,
          "implementation",
          spec.revision,
          "ih",
        );
        const alreadyBound = yield* Effect.flip(markIntake(projectId, boundThread));
        assert.equal(alreadyBound.reason, "conflict");

        const wrongDriver = yield* Effect.flip(
          service.assertIntakeAllowed({ projectId, driver: "cursor" }),
        );
        assert.equal(wrongDriver.reason, "unsupported-provider");
        yield* service.assertIntakeAllowed({ projectId, driver: "claudeAgent" });
      }),
  );

  it.effect("ends an intake when a person binds the thread to an existing spec", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const workspaceRoot = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:intake-bind");
      yield* createProject(projectId, workspaceRoot);
      const spec = yield* service.mutate(
        createSpec(projectId, "existing-spec", "command:ib:create"),
        human,
      );
      const threadId = waitingThread("bind", projectId, workspaceRoot);
      yield* markIntake(projectId, threadId);

      yield* bind(service, projectId, threadId, spec.slug, "requirements", spec.revision, "ib");
      assert.isUndefined(yield* service.intake(threadId));
      assert.equal(
        (yield* service.beforeRun({ threadId, driver: "codex" }))?.document?.slug,
        spec.slug,
      );
    }),
  );

  it.effect("approves a BASE spec in BASE's own files, byte for byte like its extension", () =>
    Effect.gen(function* () {
      const ctx = yield* reviewedBaseSpec("base-approve");
      const { fs, root, folder } = ctx;
      const table = `${root}/specs/_status.md`;
      assert.equal(yield* fs.readFileString(table), baseTable("review"));

      const logBefore = JSON.stringify({ approvals: [olderApproval] }, null, 4) + "\n";
      const planBefore = JSON.stringify(testPlan, null, 2) + "\n";
      yield* fs.writeFileString(`${folder}/approval.json`, logBefore);
      yield* fs.writeFileString(`${folder}/test-plan.json`, planBefore);

      const approved = yield* ctx.approve;
      assert.equal(approved.status, "approved");
      assert.isTrue(approved.approvalValid);
      assert.isUndefined(approved.approval?.external);

      const spec = baseSpec("approved", "", APPROVED_AT);
      assert.equal(yield* fs.readFileString(`${folder}/spec.md`), spec);
      const planAfter = JSON.stringify({ ...testPlan, status: "approved" }, null, 2) + "\n";
      assert.equal(yield* fs.readFileString(`${folder}/test-plan.json`), planAfter);
      assert.equal(
        yield* fs.readFileString(`${folder}/approval.json`),
        JSON.stringify(
          {
            approvals: [
              olderApproval,
              {
                confirmedBy: "Jane Doe <jane@example.com>",
                confirmedAt: APPROVED_AT,
                source: "button",
                artifacts: {
                  "spec.md": yield* sha256(spec),
                  "test-plan.json": yield* sha256(planAfter),
                },
              },
            ],
          },
          null,
          4,
        ) + "\n",
      );
      assert.equal(
        yield* fs.readFileString(`${folder}/status.json`),
        JSON.stringify(
          {
            version: 1,
            phase: "requirements",
            updated: APPROVED_AT,
            requirements: { awaiting: "nothing", owner: "Jane" },
          },
          null,
          4,
        ) + "\n",
      );
      assert.equal(yield* fs.readFileString(table), baseTable("approved"));
      assert.isFalse(yield* fs.exists(`${folder}/${baseSlug}.par3-tmp`));
    }),
  );

  it.effect("keeps the BASE status table in step with every status Par3 writes", () =>
    Effect.gen(function* () {
      const ctx = yield* reviewedBaseSpec("base-table");
      const { service, fs, root, projectId } = ctx;
      const table = `${root}/specs/_status.md`;
      const changes = yield* service.mutate(
        mutation(
          "request-changes",
          projectId,
          baseSlug,
          "command:base-table:changes",
          ctx.review.revision,
        ),
        human,
      );
      assert.equal(changes.status, "draft");
      assert.equal(yield* fs.readFileString(table), baseTable("draft"));
      yield* service.mutate(
        mutation(
          "request-review",
          projectId,
          baseSlug,
          "command:base-table:again",
          changes.revision,
        ),
        human,
      );
      assert.equal(yield* fs.readFileString(table), baseTable("review"));

      assert.equal((yield* ctx.approve).status, "approved");
      assert.equal(yield* fs.readFileString(table), baseTable("approved"));
      // Editing the requirements sends an approved spec back to review.
      yield* fs.writeFileString(
        `${root}/specs/${baseSlug}/spec.md`,
        baseSpec("approved").replace("The setting is saved.", "The setting is saved twice."),
      );
      assert.equal((yield* service.query({ projectId, slug: baseSlug })).detail!.status, "review");
      assert.equal(yield* fs.readFileString(table), baseTable("review"));
    }),
  );

  it.effect("hashes spec.md exactly as written and names the approver from git", () =>
    Effect.gen(function* () {
      const ctx = yield* reviewedBaseSpec("base-bytes");
      const { fs, folder } = ctx;
      // A spec saved by another editor: CRLF endings, then a byte order mark Par3 does not rewrite.
      const crlf = baseSpec("review").replaceAll("\n", "\r\n");
      yield* fs.writeFileString(`${folder}/spec.md`, crlf);
      yield* ctx.service.query({ projectId: ctx.projectId, slug: baseSlug });
      yield* fs.writeFileString(`${folder}/spec.md`, "\uFEFF" + crlf);

      const approved = yield* withGit({ name: null, email: "jane@example.com" }, ctx.approve);
      assert.equal(approved.status, "approved");
      const written = yield* fs.readFile(`${folder}/spec.md`);
      assert.deepEqual(Array.from(written.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
      const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(written);
      assert.equal(text, "\uFEFF" + baseSpec("approved", "", APPROVED_AT).replaceAll("\n", "\r\n"));
      const log = JSON.parse(yield* fs.readFileString(`${folder}/approval.json`));
      assert.deepEqual(log.approvals, [
        {
          confirmedBy: "jane@example.com",
          confirmedAt: APPROVED_AT,
          source: "button",
          artifacts: { "spec.md": yield* sha256(written) },
        },
      ]);
      assert.isTrue(
        (yield* fs.readFileString(`${folder}/approval.json`)).startsWith('{\n  "approvals"'),
      );
    }),
  );

  it.effect("falls back to the Par3 approver when git knows nobody", () =>
    Effect.gen(function* () {
      const ctx = yield* reviewedBaseSpec("base-approver");
      yield* withGit({ name: null, email: null }, ctx.approve);
      const log = JSON.parse(yield* ctx.fs.readFileString(`${ctx.folder}/approval.json`));
      assert.equal(log.approvals[0].confirmedBy, human.label);
    }),
  );

  it.effect("refuses to approve unless BASE's own files are in the state the extension needs", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        name: string;
        prepare: (ctx: {
          fs: FileSystem.FileSystem;
          root: string;
          folder: string;
        }) => Effect.Effect<void, PlatformError.PlatformError>;
      }> = [
        {
          name: "a second status key",
          prepare: (ctx) =>
            ctx.fs.writeFileString(
              `${ctx.folder}/spec.md`,
              baseSpec("review").replace("id: ", "status: review\nid: "),
            ),
        },
        {
          name: "a status that is not review",
          prepare: (ctx) => ctx.fs.writeFileString(`${ctx.folder}/spec.md`, baseSpec("bogus")),
        },
        {
          name: "a status.json that is missing",
          prepare: (ctx) => ctx.fs.remove(`${ctx.folder}/status.json`),
        },
        {
          name: "a status.json that is not an object",
          prepare: (ctx) => ctx.fs.writeFileString(`${ctx.folder}/status.json`, "[]\n"),
        },
        {
          name: "a missing _status.md",
          prepare: (ctx) => ctx.fs.remove(`${ctx.root}/specs/_status.md`),
        },
        {
          name: "a _status.md without the row",
          prepare: (ctx) =>
            ctx.fs.writeFileString(
              `${ctx.root}/specs/_status.md`,
              "| Spec | Status |\n| - | - |\n",
            ),
        },
        {
          name: "a row that is not review",
          prepare: (ctx) =>
            ctx.fs.writeFileString(`${ctx.root}/specs/_status.md`, baseTable("draft")),
        },
        {
          name: "a test plan for another spec",
          prepare: (ctx) =>
            ctx.fs.writeFileString(
              `${ctx.folder}/test-plan.json`,
              JSON.stringify({ ...testPlan, spec: "PROJ-999_other" }),
            ),
        },
        {
          name: "an approval log that is not a log",
          prepare: (ctx) => ctx.fs.writeFileString(`${ctx.folder}/approval.json`, "{}\n"),
        },
      ];
      for (const [index, item] of cases.entries()) {
        const ctx = yield* reviewedBaseSpec(`base-refuse-${index}`);
        yield* item.prepare(ctx);
        const before = yield* ctx.files;
        const refused = yield* Effect.flip(ctx.approve);
        assert.equal(refused.reason, "invalid", item.name);
        assert.deepEqual(yield* ctx.files, before, item.name);
      }
    }),
  );

  it.effect("aborts an approval when a file changes between the snapshot and the writes", () =>
    Effect.gen(function* () {
      const ctx = yield* reviewedBaseSpec("base-race");
      const { fs, folder } = ctx;
      const before = yield* ctx.files;
      const refused = yield* Effect.flip(
        ctx.approve.pipe(
          Effect.provideService(ApprovalHooks, {
            afterSnapshot: fs
              .writeFileString(`${folder}/status.json`, '{"edited":true}\n')
              .pipe(Effect.orDie),
            beforeWrite: () => Effect.void,
          }),
        ),
      );
      assert.equal(refused.reason, "conflict");
      assert.include(refused.message, "changed after the approval was requested");
      assert.deepEqual(yield* ctx.files, {
        ...before,
        [`specs/${baseSlug}/status.json`]: '{"edited":true}\n',
      });
      assert.equal(
        (yield* ctx.service.query({ projectId: ctx.projectId, slug: baseSlug })).detail!.status,
        "review",
      );
    }),
  );

  it.effect("rolls back every file already written when one write fails", () =>
    Effect.gen(function* () {
      const ctx = yield* reviewedBaseSpec("base-rollback");
      const { fs, folder } = ctx;
      yield* fs.writeFileString(
        `${folder}/approval.json`,
        JSON.stringify({ approvals: [olderApproval] }, null, 2) + "\n",
      );
      yield* fs.writeFileString(
        `${folder}/test-plan.json`,
        JSON.stringify(testPlan, null, 2) + "\n",
      );
      const before = yield* ctx.files;
      const written: string[] = [];
      const refused = yield* Effect.flip(
        ctx.approve.pipe(
          Effect.provideService(ApprovalHooks, {
            afterSnapshot: Effect.void,
            beforeWrite: (relative) =>
              relative === "specs/_status.md"
                ? Effect.fail(new SpecError({ reason: "io", message: "injected" }))
                : Effect.sync(() => void written.push(relative)),
          }),
        ),
      );
      assert.equal(refused.reason, "io");
      assert.include(refused.message, "rolled back");
      assert.lengthOf(written, 3);
      assert.deepEqual(yield* ctx.files, before);
      assert.equal(
        (yield* ctx.service.query({ projectId: ctx.projectId, slug: baseSlug })).detail!.status,
        "review",
      );
    }),
  );

  it.effect("adopts an approval made in the BASE extension only while spec.md is unchanged", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:base-external");
      yield* createProject(projectId, root);
      yield* fs.writeFileString(`${root}/specs/_status.md`, baseTable());
      const folder = `${root}/specs/${baseSlug}`;
      const query = () =>
        service.query({ projectId, slug: baseSlug }).pipe(Effect.map((result) => result.detail!));
      const discovered = yield* query();

      const approvedSpec = baseSpec("approved", "", "2026-10-21T09:30:00Z");
      const entry = Effect.fn("SpecServiceTest.entry")(function* (text: string) {
        return {
          confirmedBy: "Sam Roe <sam@example.com>",
          confirmedAt: "2026-10-21T09:30:00Z",
          source: "button",
          artifacts: { "spec.md": yield* sha256(text) },
        };
      });
      const writeLog = (...approvals: unknown[]) =>
        fs.writeFileString(
          `${folder}/approval.json`,
          JSON.stringify({ approvals }, null, 2) + "\n",
        );

      // No record, an older matching record, or a stale last record: not an approval.
      yield* fs.writeFileString(`${folder}/spec.md`, approvedSpec);
      const matching = yield* entry(approvedSpec);
      const mismatched = yield* entry("other text");
      for (const log of [[], [matching, mismatched]]) {
        yield* writeLog(...log);
        const stale = yield* query();
        assert.equal(stale.status, "draft");
        assert.isFalse(stale.approvalValid);
        assert.include(stale.error, "approval.json does not match");
        assert.equal(yield* fs.readFileString(`${root}/specs/_status.md`), baseTable());
      }

      yield* writeLog(mismatched, matching);
      const adopted = yield* query();
      assert.equal(adopted.status, "approved");
      assert.isTrue(adopted.approvalValid);
      assert.isUndefined(adopted.error);
      assert.equal(adopted.revision, discovered.revision + 1);
      assert.deepEqual(adopted.approval, {
        subject: "Sam Roe <sam@example.com>",
        label: "Sam Roe <sam@example.com>",
        approvedAt: "2026-10-21T09:30:00Z",
        revision: adopted.revision,
        specHash: discovered.specHash,
        constitutionHash: null,
        external: true,
      });
      assert.equal(yield* fs.readFileString(`${folder}/spec.md`), approvedSpec);
      assert.equal(yield* fs.readFileString(`${root}/specs/_status.md`), baseTable("approved"));

      // The requirements change after the approval: it no longer holds.
      yield* fs.writeFileString(
        `${folder}/spec.md`,
        approvedSpec.replace("The setting is saved.", "The setting is saved twice."),
      );
      const changed = yield* query();
      assert.equal(changed.status, "review");
      assert.isFalse(changed.approvalValid);
    }),
  );

  it.effect("runs the project's BASE validators before review and approval", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseApprovalWorkspace;
      const projectId = ProjectId.make("project:base-validate");
      yield* createProject(projectId, root);
      yield* fs.writeFileString(`${root}/specs/validate_spec.py`, "");
      yield* fs.makeDirectory(`${root}/.github/skills/spec-status`, { recursive: true });
      yield* fs.writeFileString(`${root}/.github/skills/spec-status/validate_status.py`, "");
      const ref = { projectId, slug: baseSlug };
      const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
      const review = (revision: number, suffix: string) =>
        service.mutate(
          mutation(
            "request-review",
            projectId,
            baseSlug,
            `command:base-validate:${suffix}`,
            revision,
          ),
          human,
        );
      const validators =
        (specOut: string, statusOut: { stdout: string; code: number }) =>
        (input: ProcessRunner.ProcessRunInput) =>
          input.command !== "python3"
            ? null
            : input.args[0] === "specs/validate_spec.py"
              ? processOutput(specOut)
              : processOutput(statusOut.stdout, statusOut.code);

      // validate_spec.py reports an error; its warnings never count.
      const failing = JSON.stringify({
        errors: [{ message: "Missing the Rollout section" }],
        warnings: [{ message: "Consider a longer summary" }],
      });
      yield* withProcess(
        validators(failing, { stdout: "", code: 0 }),
        Effect.gen(function* () {
          const report = yield* service.validate(ref);
          assert.deepEqual(report, {
            layout: "base",
            ran: true,
            ok: false,
            findings: [{ code: "validator", message: "Missing the Rollout section" }],
            warnings: [],
          });
          assert.deepEqual(processCalls[0], {
            command: "python3",
            args: ["specs/validate_spec.py", `specs/${baseSlug}`, "--json"],
            cwd: root,
          });
          const refused = yield* Effect.flip(review(discovered.revision, "blocked"));
          assert.equal(refused.reason, "invalid");
          assert.include(refused.message, "Missing the Rollout section");
        }),
      );

      // Clean validators let review through; a failing status validator then blocks approval.
      const reviewed = yield* withProcess(
        validators('{"errors":[]}', { stdout: "", code: 0 }),
        Effect.gen(function* () {
          assert.isTrue((yield* service.validate(ref)).ok);
          return yield* review(discovered.revision, "review");
        }),
      );
      assert.equal(reviewed.status, "review");
      yield* withProcess(
        validators('{"errors":[]}', { stdout: "status.json: phase is unknown", code: 1 }),
        Effect.gen(function* () {
          const refused = yield* Effect.flip(
            service.mutate(
              mutation(
                "approve",
                projectId,
                baseSlug,
                "command:base-validate:approve",
                reviewed.revision,
              ),
              human,
            ),
          );
          assert.equal(refused.reason, "invalid");
          assert.include(refused.message, "phase is unknown");
          assert.isFalse(yield* fs.exists(`${root}/specs/${baseSlug}/approval.json`));
        }),
      );

      // The next interpreter is used when python3 is not installed, and again for the second script.
      yield* withProcess(
        (input) => (input.command === "python" ? processOutput('{"errors":[]}') : null),
        Effect.gen(function* () {
          assert.isTrue((yield* service.validate(ref)).ran);
          assert.deepEqual(
            processCalls.map((call) => call.command),
            ["python3", "python", "python"],
          );
        }),
      );

      // The Windows Store alias starts but never runs the script: it counts as missing, by exit code
      // or by message, and the next interpreter is tried.
      for (const stub of [
        processOutput("", 9009),
        processOutput(
          "",
          49,
          "Python was not found; run without arguments to install from the Microsoft Store.",
        ),
      ]) {
        yield* withProcess(
          (input) =>
            input.command === "python3"
              ? stub
              : input.command === "python"
                ? processOutput('{"errors":[]}')
                : null,
          Effect.gen(function* () {
            const report = yield* service.validate(ref);
            assert.isTrue(report.ran);
            assert.deepEqual(
              processCalls.map((call) => call.command),
              ["python3", "python", "python"],
            );
          }),
        );
      }

      // Every interpreter being the stub is the same as having none.
      yield* withProcess(
        () => processOutput("", 9009),
        Effect.gen(function* () {
          const report = yield* service.validate(ref);
          assert.deepEqual(report.warnings, [PYTHON_MISSING]);
          assert.isFalse(report.ran);
          assert.isTrue(report.ok);
          assert.deepEqual(
            processCalls.map((call) => call.command),
            ["python3", "python", "uv"],
          );
        }),
      );

      // A script that ran and failed is a validator error, never a missing interpreter.
      yield* withProcess(
        (input) =>
          input.command === "python3"
            ? processOutput("", 1, "Traceback (most recent call last):\nValueError: bad spec")
            : processOutput('{"errors":[]}'),
        Effect.gen(function* () {
          const report = yield* service.validate(ref);
          assert.isTrue(report.ran);
          assert.isFalse(report.ok);
          assert.include(report.findings[0]?.message, "ValueError: bad spec");
          assert.deepEqual(
            processCalls.map((call) => call.command),
            ["python3", "python3"],
          );
        }),
      );

      // Without Python nothing runs, and that alone blocks nothing.
      yield* withProcess(
        () => null,
        Effect.gen(function* () {
          const report = yield* service.validate(ref);
          assert.deepEqual(report, {
            layout: "base",
            ran: false,
            ok: true,
            findings: [],
            warnings: [PYTHON_MISSING],
          });
          const approved = yield* service.mutate(
            mutation(
              "approve",
              projectId,
              baseSlug,
              "command:base-validate:approve2",
              reviewed.revision,
            ),
            human,
          );
          assert.equal(approved.status, "approved");
        }),
      );
    }),
  );

  it.effect("reports Par3's own readiness findings for specs outside BASE", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const root = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:par3-validate");
      processCalls.length = 0;
      yield* createProject(projectId, root);
      yield* service.mutate(
        createSpec(projectId, "par3-validate", "command:par3-validate:create", "# Thin\n"),
        human,
      );
      const report = yield* service.validate({ projectId, slug: "par3-validate" });
      assert.equal(report.layout, "par3");
      assert.isFalse(report.ran);
      assert.isFalse(report.ok);
      assert.isAbove(report.findings.length, 0);
      assert.lengthOf(processCalls, 0);
    }),
  );

  it.effect("writes a remark to the review ledger the way the BASE panel does", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-ledger");
      yield* createProject(projectId, root);
      const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
      const ledgerFile = `${root}/specs/${baseSlug}/spec-comments.json`;

      const added = yield* remarks.mutate(
        remarkInput(
          "remark-add",
          projectId,
          baseSlug,
          "spec.md",
          "command:remark:add",
          comment("Answer: (a) per connection"),
        ),
        human,
      );
      assert.equal(added.remark?.status, "pending");
      assert.equal(added.revision, discovered.revision);

      const text = yield* fs.readFileString(ledgerFile);
      assert.isTrue(text.startsWith('{\n  "$schema"'));
      assert.isTrue(text.endsWith("}\n"));
      const ledger = JSON.parse(text);
      assert.equal(ledger.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(ledger.schemaVersion, "1.0.0");
      assert.equal(ledger.documentPath, `specs/${baseSlug}/spec.md`);
      assert.equal(ledger.createdAt, LEDGER_TIME);
      assert.equal(ledger.updatedAt, LEDGER_TIME);
      assert.lengthOf(ledger.entries, 1);
      const [entry] = ledger.entries;
      assert.match(entry.id, /^[0-9a-f-]{36}$/);
      const { id: _id, events: _events, ...rest } = entry;
      assert.deepEqual(rest, {
        kind: "comment",
        operation: "comment",
        createdAt: LEDGER_TIME,
        section: { heading: "Open questions" },
        comment: "Answer: (a) per connection",
      });
      assert.lengthOf(entry.events, 1);
      assert.equal(entry.events[0].type, "created");
      assert.equal(entry.events[0].timestamp, LEDGER_TIME);
      assert.equal(added.remark?.id, entry.id);
      assert.isFalse(yield* fs.exists(`${ledgerFile}.par3-tmp`));
    }),
  );

  it.effect("keeps unknown ledger fields, entries and indent when it adds and withdraws", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-keep");
      yield* createProject(projectId, root);
      const ledgerFile = `${root}/specs/${baseSlug}/spec-comments.json`;
      const foreign = {
        id: "foreign-1",
        kind: "comment",
        operation: "comment",
        createdAt: "2026-09-01T09:00:00.000Z",
        section: { heading: "Scope" },
        comment: "Written by the extension",
        futureField: { keep: ["me"] },
        events: [{ eventId: "f1", type: "created", timestamp: "2026-09-01T09:00:00.000Z" }],
      };
      const original = {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        schemaVersion: "1.0.0",
        documentPath: `specs/${baseSlug}/spec.md`,
        createdAt: "2026-09-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
        reviewer: { name: "Jane Doe" },
        entries: [foreign, { unknownShape: true }],
      };
      yield* fs.writeFileString(ledgerFile, JSON.stringify(original, null, 4) + "\n");

      const added = yield* remarks.mutate(
        remarkInput(
          "remark-add",
          projectId,
          baseSlug,
          "spec.md",
          "command:remark:keep-add",
          comment("Second"),
        ),
        human,
      );
      let text = yield* fs.readFileString(ledgerFile);
      assert.isTrue(text.startsWith('{\n    "$schema"'));
      let parsed = JSON.parse(text);
      assert.deepEqual(parsed.reviewer, original.reviewer);
      assert.equal(parsed.createdAt, original.createdAt);
      assert.equal(parsed.updatedAt, LEDGER_TIME);
      assert.deepEqual(parsed.entries[0], foreign);
      assert.deepEqual(parsed.entries[1], { unknownShape: true });
      assert.equal(parsed.entries[2].id, added.remark?.id);

      // Only the remark that was never sent can be withdrawn, and withdrawing adds an event.
      const withdrawn = yield* remarks.mutate(
        remarkInput("remark-delete", projectId, baseSlug, "spec.md", "command:remark:keep-del", {
          id: added.remark!.id,
        }),
        human,
      );
      assert.equal(withdrawn.remark?.status, "deleted");
      text = yield* fs.readFileString(ledgerFile);
      parsed = JSON.parse(text);
      assert.deepEqual(
        parsed.entries[2].events.map((event: { type: string }) => event.type),
        ["created", "deleted"],
      );
      assert.deepEqual(parsed.entries[0], foreign);
      const again = yield* Effect.flip(
        remarks.mutate(
          remarkInput("remark-delete", projectId, baseSlug, "spec.md", "command:remark:keep-del2", {
            id: added.remark!.id,
          }),
          human,
        ),
      );
      assert.equal(again.reason, "conflict");
      const unknown = yield* Effect.flip(
        remarks.mutate(
          remarkInput("remark-delete", projectId, baseSlug, "spec.md", "command:remark:keep-del3", {
            id: "nope",
          }),
          human,
        ),
      );
      assert.equal(unknown.reason, "not-found");
    }),
  );

  it.effect(
    "refuses remarks that make no sense, on missing documents, in Par3 specs, and for agents",
    () =>
      Effect.gen(function* () {
        const remarks = yield* SpecRemarkService.SpecRemarkService;
        const service = yield* SpecService.SpecService;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* baseWorkspace;
        const projectId = ProjectId.make("project:remark-refuse");
        const threadId = ThreadId.make("thread:remark-refuse");
        yield* createProject(projectId, root);
        threads.set(threadId, { projectId, workspacePath: root, activeRunId: null });
        const folder = `${root}/specs/${baseSlug}`;
        const add = (
          document: "spec.md" | "prd.md",
          suffix: string,
          fields: Record<string, unknown>,
        ) =>
          remarks.mutate(
            remarkInput(
              "remark-add",
              projectId,
              baseSlug,
              document,
              `command:remark:refuse:${suffix}`,
              fields,
            ),
            human,
          );

        assert.equal(
          (yield* Effect.flip(add("spec.md", "empty", comment("  ")))).reason,
          "invalid",
        );
        assert.equal(
          (yield* Effect.flip(
            add("spec.md", "edit", {
              kind: "text-edit",
              operation: "reword",
              section: { heading: "Scope" },
              selection: { text: "old" },
            }),
          )).reason,
          "invalid",
        );
        assert.equal(
          (yield* Effect.flip(add("prd.md", "nodoc", comment("Hm")))).reason,
          "not-found",
        );
        assert.isFalse(yield* fs.exists(`${folder}/prd-comments.json`));

        yield* fs.writeFileString(`${folder}/spec-comments.json`, "not json");
        const broken = yield* Effect.flip(add("spec.md", "broken", comment("Hm")));
        assert.equal(broken.reason, "invalid");
        assert.equal(yield* fs.readFileString(`${folder}/spec-comments.json`), "not json");
        yield* fs.remove(`${folder}/spec-comments.json`);

        const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
        yield* bind(
          service,
          projectId,
          threadId,
          baseSlug,
          "requirements",
          discovered.revision,
          "remark-refuse",
        );
        const agent = yield* Effect.flip(
          service.remark(
            remarkInput(
              "remark-add",
              projectId,
              baseSlug,
              "spec.md",
              "command:remark:agent",
              comment("Hm"),
            ) as never,
            { kind: "agent", threadId },
          ),
        );
        assert.equal(agent.reason, "forbidden");

        const par3Root = yield* scopedWorkspace;
        const par3Project = ProjectId.make("project:remark-refuse-par3");
        yield* createProject(par3Project, par3Root);
        yield* service.mutate(
          createSpec(par3Project, "par3-remarks", "command:remark:par3-create"),
          human,
        );
        const par3 = yield* Effect.flip(
          remarks.mutate(
            remarkInput(
              "remark-add",
              par3Project,
              "par3-remarks",
              "spec.md",
              "command:remark:par3",
              comment("Hm"),
            ),
            human,
          ),
        );
        assert.equal(par3.reason, "invalid");
        assert.isFalse(yield* fs.exists(`${par3Root}/specs/par3-remarks/spec-comments.json`));
      }),
  );

  it.effect("serializes concurrent ledger changes so none is lost", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-concurrent");
      yield* createProject(projectId, root);
      yield* Effect.all(
        ["a", "b", "c", "d", "e"].map((name) =>
          remarks.mutate(
            remarkInput(
              "remark-add",
              projectId,
              baseSlug,
              "spec.md",
              `command:remark:c:${name}`,
              comment(`Remark ${name}`),
            ),
            human,
          ),
        ),
        { concurrency: "unbounded" },
      );
      const ledger = JSON.parse(
        yield* fs.readFileString(`${root}/specs/${baseSlug}/spec-comments.json`),
      );
      assert.sameMembers(
        ledger.entries.map((entry: { comment: string }) => entry.comment),
        ["a", "b", "c", "d", "e"].map((name) => `Remark ${name}`),
      );
      assert.lengthOf(new Set(ledger.entries.map((entry: { id: string }) => entry.id)), 5);
    }),
  );

  it.effect("returns the ledgers and the other documents only when the query asks", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-query");
      yield* createProject(projectId, root);
      const folder = `${root}/specs/${baseSlug}`;
      yield* fs.writeFileString(`${folder}/prd.md`, "# PRD\n\n- [ ] one\n");
      yield* remarks.mutate(
        remarkInput(
          "remark-add",
          projectId,
          baseSlug,
          "prd.md",
          "command:remark:q",
          comment("Why?", "PRD"),
        ),
        human,
      );
      yield* fs.writeFileString(`${folder}/tech-analysis-comments.json`, "{ nope");

      assert.isUndefined((yield* service.query({ projectId, slug: baseSlug })).remarks);
      const view = (yield* service.query({ projectId, slug: baseSlug, includeRemarks: true }))
        .remarks!;
      assert.deepEqual(
        view.documents.map((item) => [item.document, item.exists, item.entries.length]),
        [
          ["spec.md", true, 0],
          ["prd.md", true, 1],
          ["tech-analysis.md", false, 0],
        ],
      );
      assert.isUndefined(view.documents[0]?.text);
      assert.equal(view.documents[1]?.text, "# PRD\n\n- [ ] one\n");
      assert.equal(view.documents[1]?.entries[0]?.section.heading, "PRD");
      assert.include(view.documents[2]?.error, "not valid");
      assert.equal(yield* fs.readFileString(`${folder}/tech-analysis-comments.json`), "{ nope");
    }),
  );

  it.effect("lets a bound agent resolve an open remark once, and nobody else", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-resolve");
      yield* createProject(projectId, root);
      const requirements = ThreadId.make("thread:remark-resolve:requirements");
      const researcher = ThreadId.make("thread:remark-resolve:researcher");
      const stranger = ThreadId.make("thread:remark-resolve:stranger");
      for (const id of [requirements, researcher, stranger])
        threads.set(id, { projectId, workspacePath: root, activeRunId: null });
      const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
      const bound = yield* bind(
        service,
        projectId,
        requirements,
        baseSlug,
        "requirements",
        discovered.revision,
        "resolve-r",
      );
      yield* bind(
        service,
        projectId,
        researcher,
        baseSlug,
        "researcher",
        bound.revision,
        "resolve-s",
      );

      const ids: string[] = [];
      for (const name of ["a", "b", "c", "d"])
        ids.push(
          (yield* remarks.mutate(
            remarkInput(
              "remark-add",
              projectId,
              baseSlug,
              "spec.md",
              `command:remark:r:${name}`,
              comment(name),
            ),
            human,
          )).remark!.id,
        );
      const [a, b, c, d] = ids as [string, string, string, string];
      yield* service.commitRemarksSend({
        projectId,
        slug: baseSlug,
        document: "spec.md",
        workspace: root,
        ids: [a, b],
        resent: [],
        prompt: "",
      });
      const resolve = (
        threadId: ThreadId,
        id: string,
        outcome: "addressed" | "unmatched",
        response = "Done.",
      ) => service.resolveRemark({ threadId, document: "spec.md", id, outcome, response });

      // A submitted remark and a pending one can both be resolved.
      const addressed = yield* resolve(requirements, a, "addressed", "Boundary confirmed.");
      assert.equal(addressed.status, "addressed");
      assert.equal(addressed.response, "Boundary confirmed.");
      assert.deepEqual(
        addressed.events.map((event) => event.type),
        ["created", "submitted", "addressed"],
      );
      const unmatched = yield* resolve(requirements, c, "unmatched", "The quoted text is gone.");
      assert.equal(unmatched.status, "unmatched");

      // A closed remark cannot be resolved again, whatever the outcome.
      assert.equal((yield* Effect.flip(resolve(requirements, a, "unmatched"))).reason, "conflict");
      assert.equal((yield* Effect.flip(resolve(requirements, c, "addressed"))).reason, "conflict");
      yield* remarks.mutate(
        remarkInput("remark-delete", projectId, baseSlug, "spec.md", "command:remark:r:del", {
          id: d,
        }),
        human,
      );
      assert.equal((yield* Effect.flip(resolve(requirements, d, "addressed"))).reason, "conflict");
      assert.equal(
        (yield* Effect.flip(resolve(requirements, "nope", "addressed"))).reason,
        "not-found",
      );
      assert.equal(
        (yield* Effect.flip(resolve(requirements, b, "addressed", "  "))).reason,
        "invalid",
      );
      assert.equal((yield* Effect.flip(resolve(researcher, b, "addressed"))).reason, "forbidden");
      assert.equal((yield* Effect.flip(resolve(stranger, b, "addressed"))).reason, "forbidden");

      const ledger = JSON.parse(
        yield* fs.readFileString(`${root}/specs/${baseSlug}/spec-comments.json`),
      );
      const statuses = ledger.entries.map(
        (entry: { events: Array<{ type: string }> }) => entry.events.at(-1)?.type,
      );
      assert.deepEqual(statuses, ["addressed", "submitted", "unmatched", "deleted"]);
      // Resolving never touches the spec.
      assert.equal(
        (yield* service.query({ projectId, slug: baseSlug })).detail!.revision,
        bound.revision + 1,
      );
    }),
  );

  it.effect("sends the open remarks to a new requirements thread bound to the spec", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-send");
      yield* createProject(projectId, root, codexModel);
      launches.length = 0;
      const ledgerFile = `${root}/specs/${baseSlug}/spec-comments.json`;
      const requirements = ThreadId.make("thread:remark-send:requirements");
      threads.set(requirements, { projectId, workspacePath: root, activeRunId: null });
      const eventTypes = Effect.gen(function* () {
        const ledger = JSON.parse(yield* fs.readFileString(ledgerFile));
        return ledger.entries.map((entry: { events: Array<{ type: string }> }) =>
          entry.events.map((event) => event.type),
        ) as string[][];
      });
      const add = (name: string) =>
        remarks.mutate(
          remarkInput(
            "remark-add",
            projectId,
            baseSlug,
            "spec.md",
            `command:remark:s:${name}`,
            comment(name),
          ),
          human,
        );
      const send = (suffix: string) =>
        remarks.mutate(
          remarkInput(
            "remarks-send",
            projectId,
            baseSlug,
            "spec.md",
            `command:remark:send:${suffix}`,
          ),
          human,
        );

      // Nothing to send: no thread, no ledger.
      const empty = yield* Effect.flip(send("none"));
      assert.equal(empty.reason, "invalid");
      assert.include(empty.message, "no open remarks");
      assert.lengthOf(launches, 0);

      const a = (yield* add("a")).remark!.id;
      const b = (yield* add("b")).remark!.id;
      const first = yield* send("1");
      assert.deepEqual(first.sent, {
        threadId: ThreadId.make("thread:remarks-opened"),
        ids: [a, b],
        resent: [],
      });
      assert.lengthOf(launches, 1);
      const launch = launches[0]!;
      assert.equal(launch.commandId, CommandId.make("command:remark:send:1"));
      assert.equal(launch.title, `Remarks: ${baseSlug}`);
      assert.deepEqual(launch.modelSelection, codexModel);
      assert.deepEqual(launch.workspaceStrategy, { type: "root" });
      assert.deepEqual(launch.specBinding, { slug: baseSlug, role: "requirements" });
      assert.deepEqual(launch.initialMessage?.attachments, []);
      const prompt = launch.initialMessage?.text ?? "";
      assert.include(prompt, `specs/${baseSlug}/spec.md`);
      assert.include(prompt, `specs/${baseSlug}/spec-comments.json`);
      assert.include(prompt, `open request UUIDs:\n${a}\n${b}\n`);
      assert.deepEqual(yield* eventTypes, [
        ["created", "submitted"],
        ["created", "submitted"],
      ]);

      // A second send lists what is still open, resends the submitted ones without a new event, and
      // leaves out what was resolved.
      const c = (yield* add("c")).remark!.id;
      const bound = yield* bind(
        service,
        projectId,
        requirements,
        baseSlug,
        "requirements",
        (yield* service.query({ projectId, slug: baseSlug })).detail!.revision,
        "remark-send",
      );
      assert.isAbove(bound.revision, 0);
      yield* service.resolveRemark({
        threadId: requirements,
        document: "spec.md",
        id: b,
        outcome: "addressed",
        response: "Done.",
      });
      const second = yield* send("2");
      assert.deepEqual(second.sent, {
        threadId: ThreadId.make("thread:remarks-opened"),
        ids: [a, c],
        resent: [a],
      });
      assert.include(launches[1]?.initialMessage?.text ?? "", `open request UUIDs:\n${a}\n${c}\n`);
      assert.notInclude(launches[1]?.initialMessage?.text ?? "", b);
      assert.deepEqual(yield* eventTypes, [
        ["created", "submitted"],
        ["created", "submitted", "addressed"],
        ["created", "submitted"],
      ]);
    }),
  );

  it.effect("leaves the ledger alone when the thread cannot be started", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const noModel = ProjectId.make("project:remark-send-nomodel");
      yield* createProject(noModel, root);
      const projectId = ProjectId.make("project:remark-send-fail");
      const otherRoot = yield* baseWorkspace;
      yield* createProject(projectId, otherRoot, codexModel);
      launches.length = 0;
      const ledgerOf = (workspace: string) =>
        fs.readFileString(`${workspace}/specs/${baseSlug}/spec-comments.json`);
      const send = (project: ProjectId, suffix: string) =>
        remarks.mutate(
          remarkInput(
            "remarks-send",
            project,
            baseSlug,
            "spec.md",
            `command:remark:fail:${suffix}`,
          ),
          human,
        );
      for (const [project, name] of [
        [noModel, "m"],
        [projectId, "p"],
      ] as const)
        yield* remarks.mutate(
          remarkInput(
            "remark-add",
            project,
            baseSlug,
            "spec.md",
            `command:remark:fail:add:${name}`,
            comment("x"),
          ),
          human,
        );

      const withoutModel = yield* Effect.flip(send(noModel, "nomodel"));
      assert.equal(withoutModel.reason, "invalid");
      assert.include(withoutModel.message, "default model");

      const before = yield* ledgerOf(otherRoot);
      providerDrivers.current = [{ instanceId: "codex", driver: "cursor" }];
      const unsupported = yield* Effect.flip(send(projectId, "provider")).pipe(
        Effect.ensuring(
          Effect.sync(
            () => void (providerDrivers.current = [{ instanceId: "codex", driver: "codex" }]),
          ),
        ),
      );
      assert.equal(unsupported.reason, "unsupported-provider");

      launchState.fail = true;
      const failed = yield* Effect.flip(send(projectId, "launch")).pipe(
        Effect.ensuring(Effect.sync(() => void (launchState.fail = false))),
      );
      assert.equal(failed.reason, "io");
      assert.lengthOf(launches, 1);
      assert.equal(yield* ledgerOf(otherRoot), before);

      const agent = yield* Effect.flip(
        remarks.mutate(
          remarkInput("remarks-send", projectId, baseSlug, "spec.md", "command:remark:fail:agent"),
          { kind: "agent", threadId: ThreadId.make("thread:nobody") },
        ),
      );
      assert.equal(agent.reason, "forbidden");
    }),
  );

  it.effect("sends from a worktree into the worktree's own checkout", () =>
    Effect.gen(function* () {
      const remarks = yield* SpecRemarkService.SpecRemarkService;
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* scopedWorkspace;
      const worktree = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-worktree");
      const viewing = ThreadId.make("thread:remark-worktree");
      yield* createProject(projectId, projectRoot, codexModel);
      threads.set(viewing, { projectId, workspacePath: worktree, activeRunId: null });
      launches.length = 0;
      yield* service.query({ projectId, threadId: viewing });

      yield* remarks.mutate(
        remarkInput("remark-add", projectId, baseSlug, "spec.md", "command:remark:wt:add", {
          ...comment("In the worktree"),
          threadId: viewing,
        }),
        human,
      );
      assert.isFalse(yield* fs.exists(`${projectRoot}/specs`));
      const sent = yield* remarks.mutate(
        remarkInput("remarks-send", projectId, baseSlug, "spec.md", "command:remark:wt:send", {
          threadId: viewing,
        }),
        human,
      );
      assert.lengthOf(sent.sent?.ids ?? [], 1);
      assert.deepEqual(launches[0]?.workspaceStrategy, {
        type: "existing_worktree",
        worktreePath: worktree,
      });
      const ledger = JSON.parse(
        yield* fs.readFileString(`${worktree}/specs/${baseSlug}/spec-comments.json`),
      );
      assert.equal(ledger.entries[0].events.at(-1).type, "submitted");
    }),
  );

  it.effect("toggles a checklist box in spec.md through the normal update path", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const ctx = yield* reviewedBaseSpec("checklist-spec");
      const { root, projectId } = ctx;
      const specFile = `${root}/specs/${baseSlug}/spec.md`;
      const approved = yield* ctx.approve;
      const onDisk = yield* fs.readFileString(specFile);
      const line = lineOf(onDisk, "AC-1");
      const toggle = (revision: number, suffix: string, fields: Record<string, unknown>) =>
        service.mutate(
          {
            action: "checklist-toggle",
            projectId,
            slug: baseSlug,
            document: "spec.md",
            commandId: CommandId.make(`command:checklist:${suffix}`),
            expectedRevision: revision,
            line,
            expectedText: "- [ ] AC-1: The setting is saved.",
            checked: true,
            ...fields,
          } as SpecDocumentMutationInput,
          human,
        );

      // A concurrent edit or an old revision is refused and nothing changes.
      assert.equal(
        (yield* Effect.flip(
          toggle(approved.revision, "stale", { expectedText: "- [ ] AC-1: Old text." }),
        )).reason,
        "conflict",
      );
      assert.equal(
        (yield* Effect.flip(toggle(approved.revision - 1, "old", {}))).reason,
        "conflict",
      );
      assert.equal(yield* fs.readFileString(specFile), onDisk);

      const ticked = yield* toggle(approved.revision, "tick", {});
      assert.equal(yield* fs.readFileString(specFile), onDisk.replace("- [ ] AC-1", "- [x] AC-1"));
      assert.equal(ticked.revision, approved.revision + 1);
      assert.equal(ticked.status, "approved");
      assert.isTrue(ticked.approvalValid);
      assert.equal(ticked.specHash, approved.specHash);

      const unticked = yield* toggle(ticked.revision, "untick", {
        expectedText: "- [x] AC-1: The setting is saved.",
        checked: false,
      });
      assert.equal(yield* fs.readFileString(specFile), onDisk);
      assert.isTrue(unticked.approvalValid);

      const agent = ThreadId.make("thread:checklist:agent");
      threads.set(agent, { projectId, workspacePath: root, activeRunId: null });
      const bound = yield* bind(
        service,
        projectId,
        agent,
        baseSlug,
        "requirements",
        unticked.revision,
        "checklist",
      );
      const refused = yield* Effect.flip(
        service.mutate(
          {
            action: "checklist-toggle",
            projectId,
            threadId: agent,
            slug: baseSlug,
            document: "spec.md",
            commandId: CommandId.make("command:checklist:agent"),
            expectedRevision: bound.revision,
            line,
            expectedText: "- [ ] AC-1: The setting is saved.",
            checked: true,
          } as SpecDocumentMutationInput,
          { kind: "agent", threadId: agent },
        ),
      );
      assert.equal(refused.reason, "forbidden");
    }),
  );

  it.effect("toggles prd.md and tech-analysis.md in place without a spec revision", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:checklist-prd");
      yield* createProject(projectId, root);
      const folder = `${root}/specs/${baseSlug}`;
      const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
      const prd = "# PRD\r\n\r\n- [ ] one\r\n- [x] two";
      yield* fs.writeFileString(`${folder}/prd.md`, prd);
      const toggle = (
        document: "prd.md" | "tech-analysis.md",
        suffix: string,
        fields: Record<string, unknown>,
      ) =>
        service.mutate(
          {
            action: "checklist-toggle",
            projectId,
            slug: baseSlug,
            document,
            commandId: CommandId.make(`command:checklist-prd:${suffix}`),
            expectedRevision: discovered.revision,
            line: 3,
            expectedText: "- [ ] one",
            checked: true,
            ...fields,
          } as SpecDocumentMutationInput,
          human,
        );

      const result = yield* toggle("prd.md", "tick", {});
      assert.equal(
        yield* fs.readFileString(`${folder}/prd.md`),
        "# PRD\r\n\r\n- [x] one\r\n- [x] two",
      );
      assert.equal(result.revision, discovered.revision);
      assert.equal(yield* fs.readFileString(`${folder}/spec.md`), baseSpec());
      assert.isFalse(yield* fs.exists(`${folder}/prd.md.par3-tmp`));

      // The same request again is harmless; a changed line is refused.
      yield* toggle("prd.md", "again", {});
      assert.equal(
        yield* fs.readFileString(`${folder}/prd.md`),
        "# PRD\r\n\r\n- [x] one\r\n- [x] two",
      );
      const stale = yield* Effect.flip(toggle("prd.md", "stale", { expectedText: "- [ ] uno" }));
      assert.equal(stale.reason, "conflict");
      assert.equal(
        (yield* Effect.flip(toggle("tech-analysis.md", "missing", {}))).reason,
        "not-found",
      );
    }),
  );

  it.effect("toggles only in BASE specs", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const root = yield* scopedWorkspace;
      const projectId = ProjectId.make("project:checklist-par3");
      yield* createProject(projectId, root);
      const created = yield* service.mutate(
        createSpec(projectId, "par3-checklist", "command:checklist-par3:create"),
        human,
      );
      const refused = yield* Effect.flip(
        service.mutate(
          {
            action: "checklist-toggle",
            projectId,
            slug: "par3-checklist",
            document: "spec.md",
            commandId: CommandId.make("command:checklist-par3:toggle"),
            expectedRevision: created.revision,
            line: 1,
            expectedText: "# Example",
            checked: true,
          } as SpecDocumentMutationInput,
          human,
        ),
      );
      assert.equal(refused.reason, "invalid");
    }),
  );

  it.effect("ignores checkbox state in BASE's requirements hash but not in a Par3 spec's", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const ctx = yield* reviewedBaseSpec("checkbox-hash");
      const specFile = `${ctx.root}/specs/${baseSlug}/spec.md`;
      const approved = yield* ctx.approve;
      const query = () =>
        service
          .query({ projectId: ctx.projectId, slug: baseSlug })
          .pipe(Effect.map((result) => result.detail!));
      const onDisk = yield* fs.readFileString(specFile);

      yield* fs.writeFileString(
        specFile,
        onDisk.replace("- [ ] AC-1", "- [x] AC-1").replace("- [x] AC-2", "- [ ] AC-2"),
      );
      const ticked = yield* query();
      assert.isTrue(ticked.approvalValid);
      assert.equal(ticked.status, "approved");
      assert.equal(ticked.revision, approved.revision);
      assert.equal(ticked.specHash, approved.specHash);

      yield* fs.writeFileString(
        specFile,
        onDisk.replace(
          "- [ ] AC-1: The setting is saved.",
          "- [x] AC-1: The setting is saved twice.",
        ),
      );
      const reworded = yield* query();
      assert.isFalse(reworded.approvalValid);
      assert.equal(reworded.status, "review");

      const par3Root = yield* scopedWorkspace;
      const par3Project = ProjectId.make("project:checkbox-hash-par3");
      yield* createProject(par3Project, par3Root);
      const created = yield* service.mutate(
        createSpec(
          par3Project,
          "par3-boxes",
          "command:checkbox:create",
          content.replace("- AC-1:", "- [ ] AC-1:"),
        ),
        human,
      );
      const par3Approved = yield* reviewAndApprove(
        service,
        par3Project,
        created.slug,
        created.revision,
        "par3-boxes",
      );
      assert.isTrue(par3Approved.approvalValid);
      const par3File = `${par3Root}/specs/par3-boxes/spec.md`;
      yield* fs.writeFileString(
        par3File,
        (yield* fs.readFileString(par3File)).replace("- [ ] AC-1", "- [x] AC-1"),
      );
      const par3After = (yield* service.query({ projectId: par3Project, slug: "par3-boxes" }))
        .detail!;
      assert.isFalse(par3After.approvalValid);
      assert.equal(par3After.status, "review");
    }),
  );

  it.effect("keeps review ledgers and the approval log out of agent artifact writes", () =>
    Effect.gen(function* () {
      const service = yield* SpecService.SpecService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* baseWorkspace;
      const projectId = ProjectId.make("project:remark-artifact");
      const threadId = ThreadId.make("thread:remark-artifact");
      yield* createProject(projectId, root);
      threads.set(threadId, { projectId, workspacePath: root, activeRunId: null });
      const discovered = (yield* service.query({ projectId, slug: baseSlug })).detail!;
      const bound = yield* bind(
        service,
        projectId,
        threadId,
        baseSlug,
        "requirements",
        discovered.revision,
        "remark-artifact",
      );
      for (const path of [
        "spec-comments.json",
        "prd-comments.json",
        "tech-analysis-comments.json",
        "approval.json",
      ]) {
        const refused = yield* Effect.flip(
          service.mutate(
            mutation(
              "artifact",
              projectId,
              baseSlug,
              `command:remark-artifact:${path}`,
              bound.revision,
              {
                threadId,
                path,
                content: "{}",
              },
            ),
            { kind: "agent", threadId },
          ),
        );
        assert.equal(refused.reason, "invalid");
        assert.include(refused.message, "Par3 only");
        assert.isFalse(yield* fs.exists(`${root}/specs/${baseSlug}/${path}`));
      }
    }),
  );
});
