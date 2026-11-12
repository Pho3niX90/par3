import {
  PAR3_PROJECT_FILE_NAME,
  PAR3_PROJECT_FILE_SCHEMA_URL,
  SourceControlProviderKind,
  T3ProjectFile,
} from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import type {
  ProjectCloneMember,
  ProjectCloneSnapshot,
  ProjectCloneStage,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectId,
  SourceControlCloneProtocol,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";
import {
  OrchestrationDispatchCommandError,
  PROJECT_CLONE_DETAIL_MAX_LENGTH,
  PROJECT_CLONE_ERROR_MAX_LENGTH,
  SourceControlRepositoryError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import type { ProjectConflictError } from "./ProjectService.ts";

export class ProjectCloneTracker extends Context.Service<
  ProjectCloneTracker,
  {
    readonly start: (
      input: ProjectCloneStartInput,
      hooks: ProjectCloneHooks,
    ) => Effect.Effect<
      ProjectCloneStartResult,
      SourceControlRepositoryError | OrchestrationDispatchCommandError
    >;
    /** Interrupts a running clone and deletes the partial checkout. */
    readonly cancel: (projectId: ProjectId) => Effect.Effect<boolean>;
    readonly retry: (projectId: ProjectId) => Effect.Effect<boolean, SourceControlRepositoryError>;
    /** Stops tracking, interrupts any running clone and removes unfinished checkouts. */
    readonly discard: (projectId: ProjectId) => Effect.Effect<void>;
    readonly get: (projectId: ProjectId) => Effect.Effect<ProjectCloneSnapshot | null>;
    readonly stream: Stream.Stream<ReadonlyArray<ProjectCloneSnapshot>>;
  }
>()("t3/project/ProjectCloneTracker") {}

export interface ProjectCloneHooks {
  /** Fails with `ProjectConflictError` when another project already owns the destination. */
  readonly createProject: (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly workspaceRoot: string;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchCommandError | ProjectConflictError>;
  readonly onCloned: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<void>;
}

const DONE_RETENTION = "30 seconds";
// Git prints nothing while a transfer waits on the network, and the kernel can
// take 15+ minutes to give up on a dead connection. Without this the banner
// keeps showing the last transfer speed as if data were still arriving.
const STALL_AFTER = "20 seconds";

function clampText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

const encodeProjectFile = Schema.encodeEffect(fromJsonStringPretty(T3ProjectFile));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface TrackedClone {
  readonly snapshot: ProjectCloneSnapshot;
  readonly fiber: Fiber.Fiber<unknown, unknown> | null;
  readonly hooks: ProjectCloneHooks;
  /** The step cloning or to resume from; past the end once every step has finished. */
  readonly stepIndex: number;
  readonly input: {
    readonly destinationPath: string;
    readonly steps: ReadonlyArray<CloneStep>;
    readonly protocol: SourceControlCloneProtocol;
  };
}

/** One repository to clone: the only one, or one member of a workspace. */
interface CloneStep {
  /** What git is given; may carry credentials and never leaves the server. */
  readonly cloneUrl: string;
  readonly remoteUrl: string;
  readonly destinationPath: string;
  readonly repository: SourceControlRepositoryInfo | null;
  readonly member: ProjectCloneMember | null;
}

const stepSnapshot = (step: CloneStep) => ({
  remoteUrl: step.remoteUrl,
  repository: step.repository,
  ...(step.member ? { member: step.member } : {}),
});

const cloneStartError = (
  provider: SourceControlProviderKind | undefined,
  detail: string,
  cause?: unknown,
) =>
  new SourceControlRepositoryError({
    operation: "cloneRepository",
    provider: provider ?? SourceControlProviderKind.make("unknown"),
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

/** @public */
export const make = Effect.gen(function* () {
  const repositories = yield* SourceControlRepositoryService.SourceControlRepositoryService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const clones = yield* Ref.make(new Map<ProjectId, TrackedClone>());
  const changes = yield* PubSub.unbounded<ReadonlyArray<ProjectCloneSnapshot>>();
  const retentionFibers = new Map<ProjectId, Fiber.Fiber<unknown, never>>();
  let sequence = 0;
  const cloneScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(cloneScope, Exit.void));
  // Serialize actions on the shared entry and directory so retries cannot race clones.
  const actionLock = yield* Semaphore.make(1);
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => actionLock.withPermits(1)(effect);

  const list = Ref.get(clones).pipe(
    Effect.map((current) => Array.from(current.values(), (tracked) => tracked.snapshot)),
  );
  const publish = list.pipe(Effect.flatMap((snapshots) => PubSub.publish(changes, snapshots)));

  const modify = (
    projectId: ProjectId,
    mutate: (tracked: TrackedClone) => TrackedClone,
  ): Effect.Effect<ProjectCloneSnapshot | null> =>
    Ref.modify(clones, (current) => {
      const existing = current.get(projectId);
      if (!existing) return [null, current] as const;
      const nextTracked = mutate(existing);
      const nextSnapshot = { ...nextTracked.snapshot, sequence: ++sequence };
      const next = new Map(current);
      next.set(projectId, { ...nextTracked, snapshot: nextSnapshot });
      return [nextSnapshot, next] as const;
    }).pipe(Effect.tap((snapshot) => (snapshot ? publish : Effect.void)));

  const clearRetention = (projectId: ProjectId) => {
    const fiber = retentionFibers.get(projectId);
    retentionFibers.delete(projectId);
    return fiber ? Fiber.interrupt(fiber).pipe(Effect.ignore) : Effect.void;
  };

  const remove = (projectId: ProjectId) =>
    Ref.update(clones, (current) => {
      if (!current.has(projectId)) return current;
      const next = new Map(current);
      next.delete(projectId);
      return next;
    }).pipe(Effect.andThen(publish));

  const scheduleRemoval = Effect.fn("ProjectCloneTracker.scheduleRemoval")(function* (
    projectId: ProjectId,
  ) {
    yield* clearRetention(projectId);
    const fiber = yield* remove(projectId).pipe(
      Effect.delay(DONE_RETENTION),
      Effect.ensuring(
        Effect.sync(() => {
          if (retentionFibers.get(projectId) === fiber) retentionFibers.delete(projectId);
        }),
      ),
      Effect.forkDetach,
    );
    retentionFibers.set(projectId, fiber);
  });

  const progress = (
    projectId: ProjectId,
    update: {
      readonly stage: ProjectCloneStage;
      readonly percent: number | null;
      readonly detail: string | null;
    },
  ) =>
    modify(projectId, (tracked) => ({
      ...tracked,
      snapshot: {
        ...tracked.snapshot,
        stage: update.stage,
        percent: update.percent,
        detail:
          update.detail === null ? null : clampText(update.detail, PROJECT_CLONE_DETAIL_MAX_LENGTH),
        stalled: false,
      },
    })).pipe(Effect.asVoid);

  const markStalled = (projectId: ProjectId) =>
    modify(projectId, (tracked) => ({
      ...tracked,
      snapshot: { ...tracked.snapshot, stalled: true },
    })).pipe(Effect.asVoid);

  /** Marks the clone stalled once, then waits for git to speak again. */
  const watchForStall = (projectId: ProjectId, pulses: Queue.Dequeue<void>) =>
    Queue.take(pulses).pipe(
      Effect.timeoutOption(STALL_AFTER),
      Effect.flatMap((pulse) =>
        Option.isSome(pulse)
          ? Effect.void
          : markStalled(projectId).pipe(Effect.andThen(Queue.take(pulses))),
      ),
      Effect.forever,
    );

  const finish = Effect.fn("ProjectCloneTracker.finish")(function* (
    projectId: ProjectId,
    phase: "done" | "failed" | "cancelled",
    error: string | null,
  ) {
    const endedAt = yield* nowIso;
    yield* modify(projectId, (tracked) => ({
      ...tracked,
      fiber: null,
      snapshot: {
        ...tracked.snapshot,
        phase,
        endedAt,
        percent: phase === "done" ? 100 : tracked.snapshot.percent,
        stalled: false,
        error:
          error === null
            ? null
            : clampText(
                tracked.snapshot.member ? `${tracked.snapshot.member.path}: ${error}` : error,
                PROJECT_CLONE_ERROR_MAX_LENGTH,
              ),
      },
    }));
    if (phase === "done") yield* scheduleRemoval(projectId);
  });

  const cloneWatchingForStall = Effect.fn("ProjectCloneTracker.cloneWatchingForStall")(function* (
    projectId: ProjectId,
    step: CloneStep,
    protocol: SourceControlCloneProtocol,
  ) {
    const pulses = yield* Queue.sliding<void>(1);
    yield* watchForStall(projectId, pulses).pipe(Effect.forkScoped);
    return yield* repositories.cloneRepository(
      {
        remoteUrl: step.cloneUrl,
        destinationPath: step.destinationPath,
        protocol,
      },
      {
        onProgress: (update) =>
          Queue.offer(pulses, undefined).pipe(Effect.andThen(progress(projectId, update))),
        timeoutMs: null,
      },
    );
  }, Effect.scoped);

  const advance = (projectId: ProjectId, finishedIndex: number) =>
    modify(projectId, (tracked) => {
      const next = tracked.input.steps[finishedIndex + 1];
      return {
        ...tracked,
        stepIndex: finishedIndex + 1,
        snapshot: next
          ? {
              ...tracked.snapshot,
              ...stepSnapshot(next),
              stage: "connecting",
              percent: null,
              detail: null,
              stalled: false,
            }
          : tracked.snapshot,
      };
    });

  /** Advancing in `onExit` means an interrupt cannot leave `stepIndex` on a finished checkout. */
  const cloneRemainingSteps = Effect.fn("ProjectCloneTracker.cloneRemainingSteps")(function* (
    projectId: ProjectId,
    tracked: TrackedClone,
  ) {
    for (let index = tracked.stepIndex; index < tracked.input.steps.length; index++) {
      yield* cloneWatchingForStall(
        projectId,
        tracked.input.steps[index]!,
        tracked.input.protocol,
      ).pipe(
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? advance(projectId, index) : Effect.void)),
      );
    }
  });

  /**
   * `onExit` records outcomes even on interruption; `matchCause` would be skipped.
   * Mark the clone done before the post-clone hook so a late Cancel cannot remove it.
   */
  const runClone = (projectId: ProjectId, tracked: TrackedClone) =>
    cloneRemainingSteps(projectId, tracked).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? finish(projectId, "done", null)
          : Cause.hasInterruptsOnly(exit.cause)
            ? finish(projectId, "cancelled", null)
            : finish(projectId, "failed", describeCloneFailure(exit.cause)),
      ),
      Effect.flatMap(() =>
        tracked.hooks
          .onCloned({ projectId, workspaceRoot: tracked.input.destinationPath })
          .pipe(Effect.ignoreCause({ log: true })),
      ),
      Effect.ignoreCause(),
    );

  /** Finished steps are complete checkouts and stay on disk. */
  const discardCurrentStep = (tracked: TrackedClone) => {
    const step = tracked.input.steps[tracked.stepIndex];
    return step ? repositories.discardClone(step.destinationPath) : Effect.void;
  };

  const launch = Effect.fn("ProjectCloneTracker.launch")(function* (projectId: ProjectId) {
    const current = yield* Ref.get(clones);
    const tracked = current.get(projectId);
    if (!tracked) return;
    const fiber = yield* runClone(projectId, tracked).pipe(Effect.forkIn(cloneScope));
    yield* Ref.update(clones, (map) => {
      const existing = map.get(projectId);
      if (!existing) return map;
      const next = new Map(map);
      next.set(projectId, { ...existing, fiber });
      return next;
    });
  });

  const planRepositoryClone = Effect.fn("ProjectCloneTracker.planRepositoryClone")(function* (
    input: ProjectCloneStartInput,
  ) {
    const prepared = yield* repositories.prepareClone(input);
    return {
      destinationPath: prepared.destinationPath,
      steps: [{ ...prepared, member: null }] as ReadonlyArray<CloneStep>,
    };
  });

  const planWorkspaceClone = Effect.fn("ProjectCloneTracker.planWorkspaceClone")(function* (
    input: ProjectCloneStartInput,
    members: NonNullable<ProjectCloneStartInput["repositories"]>,
  ) {
    const first = members[0];
    if (
      first === undefined ||
      input.provider !== undefined ||
      input.repository !== undefined ||
      input.remoteUrl !== undefined ||
      new Set(members.map((member) => member.path)).size !== members.length
    ) {
      return yield* cloneStartError(
        input.provider,
        "A workspace clone needs a list of repositories with different paths and nothing else to clone.",
      );
    }
    const protocol = input.protocol ? { protocol: input.protocol } : {};
    // The workspace folder follows the same new-or-empty rule and path expansion as a single clone.
    const { destinationPath } = yield* repositories.prepareClone({
      destinationPath: input.destinationPath,
      remoteUrl: first.remoteUrl,
      ...protocol,
    });
    const steps = yield* Effect.forEach(members, (member, index) =>
      repositories
        .prepareClone({
          destinationPath: path.join(destinationPath, member.path),
          remoteUrl: member.remoteUrl,
          ...protocol,
        })
        .pipe(
          Effect.map((prepared): CloneStep => ({
            ...prepared,
            member: { path: member.path, index: index + 1, count: members.length },
          })),
        ),
    );
    return { destinationPath, steps };
  });

  /** Written before any clone so the folder identifies as this workspace right away. */
  const writeWorkspaceManifest = Effect.fn("ProjectCloneTracker.writeWorkspaceManifest")(
    function* (manifestPath: string, steps: ReadonlyArray<CloneStep>) {
      const manifest = yield* encodeProjectFile({
        $schema: PAR3_PROJECT_FILE_SCHEMA_URL,
        // The redacted URL: this file stays on disk and is meant to be shareable.
        repositories: steps.flatMap((step) =>
          step.member ? [{ path: step.member.path, url: step.remoteUrl }] : [],
        ),
      });
      yield* fileSystem.makeDirectory(path.dirname(manifestPath), { recursive: true });
      yield* fileSystem.writeFileString(manifestPath, `${manifest}\n`);
    },
    Effect.mapError((cause) =>
      cloneStartError(undefined, "The workspace folder could not be created.", cause),
    ),
  );

  const moveClaim = (from: ProjectId, to: ProjectId) =>
    Ref.modify(clones, (current) => {
      const claim = current.get(from);
      if (!claim || current.has(to)) return [false, current] as const;
      const next = new Map(current);
      next.delete(from);
      next.set(to, { ...claim, snapshot: { ...claim.snapshot, projectId: to } });
      return [true, next] as const;
    });

  const start: ProjectCloneTracker["Service"]["start"] = Effect.fn("ProjectCloneTracker.start")(
    function* (input, hooks) {
      const plan = input.repositories
        ? yield* planWorkspaceClone(input, input.repositories)
        : yield* planRepositoryClone(input);
      const firstStep = plan.steps[0]!;
      const startedAt = yield* nowIso;
      const snapshot: ProjectCloneSnapshot = {
        projectId: input.projectId,
        ...stepSnapshot(firstStep),
        destinationPath: plan.destinationPath,
        phase: "running",
        stage: "connecting",
        percent: null,
        detail: null,
        stalled: false,
        error: null,
        startedAt,
        endedAt: null,
        sequence: ++sequence,
      };
      const destinations = new Set([
        plan.destinationPath,
        ...plan.steps.map((step) => step.destinationPath),
      ]);
      const claimed = yield* Ref.modify(clones, (current) => {
        const conflict = Array.from(current.values()).some(
          (tracked) =>
            tracked.snapshot.projectId === input.projectId ||
            destinations.has(tracked.input.destinationPath) ||
            tracked.input.steps.some((step) => destinations.has(step.destinationPath)),
        );
        if (conflict) return [false, current] as const;
        const next = new Map(current);
        next.set(input.projectId, {
          snapshot,
          fiber: null,
          hooks,
          stepIndex: 0,
          input: {
            destinationPath: plan.destinationPath,
            steps: plan.steps,
            protocol: input.protocol ?? "auto",
          },
        });
        return [true, next] as const;
      });
      const alreadyInProgress = cloneStartError(
        input.provider,
        "A clone into this destination is already in progress.",
      );
      if (!claimed) return yield* alreadyInProgress;
      // Finish or release the claim despite disconnects; a claim without a fiber cannot be cancelled or retried.
      const projectId = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* clearRetention(input.projectId);
          const manifestPath = input.repositories
            ? path.join(plan.destinationPath, PAR3_PROJECT_FILE_NAME)
            : null;
          if (manifestPath) yield* writeWorkspaceManifest(manifestPath, plan.steps);
          // Register before creation so racing thread.create and project.delete see the clone.
          const projectId = yield* hooks
            .createProject({
              projectId: input.projectId,
              title: input.title,
              workspaceRoot: plan.destinationPath,
              createdAt: input.createdAt,
            })
            .pipe(
              Effect.as(input.projectId),
              // A failed clone's project still owns its empty folder after a restart
              // forgets the clone; clone for that project instead.
              Effect.catchTags({
                ProjectConflictError: (conflict) =>
                  moveClaim(input.projectId, conflict.conflictingProjectId).pipe(
                    Effect.flatMap((moved) =>
                      moved ? Effect.succeed(conflict.conflictingProjectId) : alreadyInProgress,
                    ),
                  ),
              }),
              // The folder must stay empty, or starting this clone again would be refused.
              Effect.tapError(() =>
                manifestPath
                  ? fileSystem.remove(manifestPath, { force: true }).pipe(Effect.ignore)
                  : Effect.void,
              ),
            );
          yield* publish;
          yield* launch(projectId);
          return projectId;
        }).pipe(Effect.tapError(() => remove(input.projectId))),
      );
      return {
        projectId,
        cwd: plan.destinationPath,
        remoteUrl: firstStep.remoteUrl,
        repository: firstStep.repository,
      };
    },
  );

  const get: ProjectCloneTracker["Service"]["get"] = (projectId) =>
    Ref.get(clones).pipe(Effect.map((current) => current.get(projectId)?.snapshot ?? null));

  const cancel: ProjectCloneTracker["Service"]["cancel"] = Effect.fn("ProjectCloneTracker.cancel")(
    function* (projectId) {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (!tracked || tracked.snapshot.phase !== "running" || !tracked.fiber) return false;
      // Finish cancellation despite disconnects to avoid dead fibers behind running snapshots.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Fiber.interrupt(tracked.fiber!);
          const after = (yield* Ref.get(clones)).get(projectId) ?? tracked;
          if (after.snapshot.phase === "done") return;
          if (after.snapshot.phase === "running") yield* finish(projectId, "cancelled", null);
          yield* discardCurrentStep(after).pipe(Effect.ignore);
        }),
      );
      return true;
    },
  );

  const retry: ProjectCloneTracker["Service"]["retry"] = Effect.fn("ProjectCloneTracker.retry")(
    function* (projectId) {
      const current = yield* Ref.get(clones);
      const tracked = current.get(projectId);
      if (
        !tracked ||
        (tracked.snapshot.phase !== "failed" && tracked.snapshot.phase !== "cancelled")
      ) {
        return false;
      }
      yield* discardCurrentStep(tracked);
      const startedAt = yield* nowIso;
      yield* modify(projectId, (entry) => ({
        ...entry,
        snapshot: {
          ...entry.snapshot,
          phase: "running",
          stage: "connecting",
          percent: null,
          detail: null,
          stalled: false,
          error: null,
          startedAt,
          endedAt: null,
        },
      }));
      yield* launch(projectId);
      return true;
    },
  );

  const discard: ProjectCloneTracker["Service"]["discard"] = Effect.fn(
    "ProjectCloneTracker.discard",
  )(function* (projectId) {
    const current = yield* Ref.get(clones);
    const tracked = current.get(projectId);
    if (!tracked) return;
    if (tracked.fiber) yield* Fiber.interrupt(tracked.fiber);
    // Git may have finished while the interrupt was landing; the project
    // is going away either way, but a complete checkout is the user's.
    const after = (yield* Ref.get(clones)).get(projectId) ?? tracked;
    if (after.snapshot.phase !== "done") {
      yield* discardCurrentStep(after).pipe(Effect.ignore);
    }
    yield* clearRetention(projectId);
    yield* remove(projectId);
  });

  const stream: ProjectCloneTracker["Service"]["stream"] = Stream.callback<
    ReadonlyArray<ProjectCloneSnapshot>
  >(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* list);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((snapshots) =>
            Effect.sync(() => Queue.offerUnsafe(mailbox, snapshots)),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  // Forwarders retain the underlying operation spans.
  return ProjectCloneTracker.of({
    start: Effect.fnUntraced(function* (input, hooks) {
      return yield* locked(start(input, hooks));
    }),
    cancel: Effect.fnUntraced(function* (projectId) {
      return yield* locked(cancel(projectId));
    }),
    retry: Effect.fnUntraced(function* (projectId) {
      return yield* locked(retry(projectId));
    }),
    discard: Effect.fnUntraced(function* (projectId) {
      return yield* locked(discard(projectId));
    }),
    get,
    stream,
  });
});

const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);

/**
 * Every dispatch transport (WebSocket, HTTP) runs this before normalizing so no
 * client can start a thread on an empty tree, and no attachment copies are made
 * for a command that is about to be refused.
 */
export const rejectCommandsDuringClone = Effect.fn("ProjectCloneTracker.rejectCommandsDuringClone")(
  function* (
    tracker: ProjectCloneTracker["Service"],
    command: {
      readonly type: string;
      readonly projectId?: ProjectId;
      readonly bootstrap?: unknown;
    },
  ): Effect.fn.Return<void, OrchestrationDispatchCommandError> {
    const projectId =
      command.type === "thread.create"
        ? (command.projectId ?? null)
        : command.type === "thread.turn.start"
          ? bootstrapProjectId(command.bootstrap)
          : null;
    if (projectId === null) return;
    const clone = yield* tracker.get(projectId);
    if (clone === null || clone.phase === "done") return;
    return yield* new OrchestrationDispatchCommandError({
      message:
        clone.phase === "running"
          ? "The repository is still being cloned."
          : "The repository was not cloned. Retry the clone first.",
    });
  },
);

function bootstrapProjectId(bootstrap: unknown): ProjectId | null {
  if (typeof bootstrap !== "object" || bootstrap === null) return null;
  const createThread = (bootstrap as { createThread?: { projectId?: ProjectId } }).createThread;
  return createThread?.projectId ?? null;
}

function describeCloneFailure(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (isSourceControlRepositoryError(error)) return error.detail;
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The repository could not be cloned.";
}

export const layer = Layer.effect(ProjectCloneTracker, make);
